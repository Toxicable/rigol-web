# Server Architecture

## Purpose

The Rigol Web server coordinates two fixed instruments, the DHO804 and DM858E, plus browser clients over one persistent WebSocket per browser tab.

The design remains concrete. Shared code exists only where both supported instruments genuinely need the same behaviour. Rigol Web is not a generic instrument framework.

## Top-level structure

```text
Browser WebSocket
      |
      v
WebSocketGateway
(session/protocol broker)
   /                  \
  v                    v
ScopeWebSocketAdapter  DmmWebSocketAdapter
  |                    |
  v                    v
ScopeService          DmmService
  |                    |
  v                    v
ScopeRuntime          DmmRuntime
   \                  /
    InstrumentRegistry
  |                    |
Dho804Driver         Dm858eDriver
   \                  /
    ScpiScheduler
          |
    ScpiTransport
```

Each instrument gets its **own** scheduler and transport instance. Only their implementations are shared.

## Server-owned runtime lifetime

The server process owns physical instrument lifetime.

`InstrumentRegistry` is the small manager for the exactly two known runtimes. It owns only process-lifetime transitions:

- start both runtimes at server startup;
- keep start/stop operations idempotent;
- serialize a stop behind an in-flight start;
- stop both runtimes at server shutdown;
- attempt to stop both even if one stop fails;
- leave a failed transition retryable.

It does not know browser sessions, publication subscriptions, endpoint selection or DMM snapshot replay.

`ScopeRuntime` and `DmmRuntime` already maintain their own reconnect loops while running. A transport failure therefore reconnects independently of browser presence.

## WebSocket session/protocol broker

`WebSocketGateway` is the common browser transport/session broker. It does not own DHO804 or DM858E application semantics or physical runtime lifetime.

It owns:

- accept/close of `/ws` sockets;
- protocol hello/version handshake;
- browser session identity;
- desired instrument publication subscriptions;
- common JSON and binary send framing;
- common request completion/failure framing;
- common socket buffered-amount/backpressure threshold;
- release of adapter session/publication state on route unsubscribe or socket close.

Browser subscribe/unsubscribe is local publication state only. It never calls `InstrumentRegistry` and never starts or stops a physical runtime.

The broker does **not** parse scope controls, DMM controls, measurements, deep-capture requests or waveform headers. It does not call instrument application-service methods directly.

`websocket-validation.ts` contains only transport-common structural readers such as request IDs and supported-instrument discriminants.

## Explicit instrument WebSocket adapters

The server has exactly two explicit adapters. They are fixed composition, not a plugin registry.

### ScopeWebSocketAdapter

Owns browser-wire mapping specific to the DHO804:

- scope request validation and dispatch;
- scope connection/state lifecycle projection;
- controls and interactive controls;
- acquisition actions and Sleep;
- measurement requests/results;
- DHO804-targeted raw SCPI;
- deep-capture request/result mapping;
- waveform viewport validation and supersession;
- binary waveform header validation;
- live-waveform latest-frame replacement/backpressure state;
- browser-session ownership and cleanup of long-lived scope interactions.

Waveform binary behaviour therefore stays scope-specific rather than becoming a generic broker concern.

Long-lived interactive controls use one narrow per-session lease. The owning session holds live waveform acquisition paused until commit, unsubscribe or disconnect. Another browser cannot commit or resume that interaction. Atomic controls remain globally accepted; the last accepted physical write wins.

### DmmWebSocketAdapter

Owns browser-wire mapping specific to the DM858E:

- DMM control validation and dispatch;
- DMM connection/state lifecycle projection;
- latest display-snapshot projection;
- direct current-snapshot replay to a newly subscribing session;
- DM858E-targeted raw SCPI;
- in-flight connection-revision validation.

Snapshot replay is presentation/session behaviour. It does not notify the physical runtime and does not rebroadcast the retained snapshot to already subscribed sessions.

It has no waveform/sample transport surface.

The tiny `WebSocketInstrumentAdapter` / `WebSocketAdapterHost` contract exists only to connect these two fixed adapters to common WebSocket session delivery. It is not an instrument plugin API and does not abstract instrument capabilities.

## Shared SCPI infrastructure

### ScpiTransport

`ScpiTransport` owns one TCP socket and raw SCPI framing for one physical instrument session.

Responsibilities:

- connect/disconnect;
- low-latency socket options;
- write command bytes;
- read complete text responses;
- read complete IEEE/TMC binary blocks;
- report socket, framing and timeout failures.

It contains no instrument or browser semantics.

### ScpiScheduler

`ScpiScheduler` is the sole normal owner of serialized access to its `ScpiTransport`.

Responsibilities:

- one complete SCPI transaction at a time;
- P0-P4 priority scheduling;
- query/response ownership;
- binary-transfer atomicity;
- coalescing/supersession where callers provide keys;
- timing/latency instrumentation;
- rejecting pending work when the transport becomes unusable.

DHO804 and DM858E do not share a scheduler queue.

### SCPI program-message classification

`src/server/scpi/scpi-program-message.ts` owns generic raw-SCPI program-message rules used by both drivers. Drivers do not maintain independent raw-SCPI query scanners.

## DHO804 path

```text
WebSocketGateway
   |
ScopeWebSocketAdapter
   |
ScopeService
   |
ScopeController
   |
ScopeRuntime session
   |
Dho804Driver
   |
ScpiScheduler
   |
ScpiTransport
```

`Dho804Driver` owns exact DHO804 SCPI commands, response parsing, waveform native representation and device-specific quirks.

`ScopeStateStore` owns complete cached connected `ScopeState`. `ScopeController` owns application-level scope control semantics. `ScopePoller` validates important physical state. Live/deep waveform services remain DHO804-specific.

`ScopeService` is the application boundary for scope controls, acquisition actions, measurements, raw SCPI, waveform/deep-capture operations and DHO804 Sleep. It exposes data-only connection/state/waveform publications.

DHO804 Sleep follows:

```text
browser ScopeSleep request
  -> ScopeWebSocketAdapter
  -> ScopeService.sleep()
  -> ScopePowerLifecycle
       -> ScopeRuntime.suspendForSleep()
       -> Dho804PowerControl.sleep()
       -> TCP offline/online wake monitor
       -> ScopeRuntime.resumeAfterSleep()
```

`ScopeRuntime` is started at server startup and remains process-owned. Sleep is an instrument-specific temporary physical-session suspension; it does not change process ownership of the runtime.

## DM858E path

```text
WebSocketGateway
   |
DmmWebSocketAdapter
   |
DmmService
   |
DmmRuntime session
   |
Dm858eDriver
   |
ScpiScheduler
   |
ScpiTransport
```

`Dm858eDriver` owns exact DM858E SCPI commands/parsing, model validation, function/range/rate mappings, latest-reading snapshot parsing and immediate physical-function validation before function-dependent writes.

`DmmStateStore` owns authoritative cached DMM configuration state. `DmmPoller` performs configuration reconciliation and latest display-snapshot polling.

The display snapshot is not a sample stream. It carries no sequence/sample identity and must not be used for sample statistics.

`DmmService` owns one logical mutation queue, authoritative post-mutation readback, stale function-dependent control rejection, and current display-snapshot invalidation/deduplication. `DmmRuntime` owns fresh-session connection/composition/recovery. `DmmWebSocketAdapter` owns replay of the retained current snapshot to a new browser subscriber.

## Protocol compatibility

WebSocket protocol version 6 uses the application-level handshake:

```text
server: ProtocolHello(PROTOCOL_VERSION)
client: ProtocolHelloAck(PROTOCOL_VERSION)
```

Stream D changes internal lifetime ownership only. It does not change protocol version or add a compatibility path.

After handshake, explicit browser subscriptions decide which instrument publications a session receives. They do not affect physical runtime lifetime.

## Raw SCPI

Raw SCPI targeting is explicit:

```text
ScpiExecute(instrument, command)
```

The broker delegates the message to the adapter matching the target instrument. The adapter routes it through that instrument's application service and normal scheduler path. There is no implicit DHO804 target and no direct socket bypass.

## Waveform representation and backpressure

DHO804 waveform samples remain outside React/Zustand and outside common WebSocket semantics.

`ScopeWebSocketAdapter` owns:

- validation of the RigolWeb binary waveform frame header;
- latest-frame-per-channel replacement under browser backpressure;
- deep viewport response validation;
- viewport request supersession.

The common broker owns only socket delivery and the common buffered-byte threshold.

## HTTP boundary

HTTP owns frontend/static serving and simple HTTP-specific infrastructure such as `/health`. Instrument application operations use the WebSocket/application-service path.

## Failure philosophy

Rigol Web is a local bench tool, not a high-availability service.

For either instrument, if socket/framing integrity is no longer trustworthy:

- fail current work clearly;
- stop/reject stale queued work;
- close the uncertain transport;
- create a fresh physical session while the server-owned runtime remains active;
- never replay stale commands after reconnect.

Physical recovery does not depend on browser subscriptions.

Do not add persistent queues, circuit breakers or per-command retry policies without measured need.

## Dependency direction

```text
server composition / runtime manager
        |
        +--------------------------+
        |                          |
        v                          v
physical runtimes        WebSocket session/protocol broker
                                   |
                                   v
                         instrument WebSocket adapter
                                   |
                                   v
                         instrument application service
                                   |
                                   v
                         instrument runtime/driver
                                   |
                                   v
                   shared SCPI scheduler/program-message rules
                                   |
                                   v
                         shared TCP/framing transport
```

Ordinary constructor dependencies and explicit callbacks are sufficient. Do not add a generic event bus, DI framework or instrument plugin system.

## Source layout

```text
src/
|- shared/
|  |- instrument-types.ts
|  |- scope-types.ts
|  |- dmm-types.ts
|  |- websocket-protocol.ts
|  `- waveform-protocol.ts
|
|- server/
|  |- server.ts
|  |- scope-runtime.ts
|  |- instruments/
|  |  `- instrument-registry.ts
|  |- scpi/
|  |- scope/
|  |- dmm/
|  |- waveform/
|  `- websocket/
|     |- websocket-gateway.ts
|     |- websocket-adapter.ts
|     |- websocket-validation.ts
|     |- scope-websocket-adapter.ts
|     `- dmm-websocket-adapter.ts
|
`- web/
```

Tests live beside the files they exercise.

## Key boundaries

- `InstrumentRegistry` owns process-level start/stop of the two known physical runtimes only.
- `WebSocketGateway` owns common browser transport/session/protocol and publication subscription concerns only.
- `ScopeWebSocketAdapter` owns DHO804 wire mapping, waveform browser delivery and scope interaction session ownership.
- `DmmWebSocketAdapter` owns DM858E wire mapping and per-subscriber current-snapshot replay.
- `ScopeService` / `DmmService` own application semantics and do not depend on the WebSocket gateway/adapter layer.
- `Dho804Driver` / `Dm858eDriver` own device protocol semantics.
- `ScpiScheduler` owns serialized transport access for one instrument session.
