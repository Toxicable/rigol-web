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
    InstrumentRegistry lifecycle
  |                    |
Dho804Driver         Dm858eDriver
   \                  /
    ScpiScheduler
          |
    ScpiTransport
```

Each active instrument gets its **own** scheduler and transport instance. Only their implementations are shared.

## WebSocket session/protocol broker

`WebSocketGateway` is the common browser transport/session broker. It does not own DHO804 or DM858E application semantics.

It owns:

- accept/close of `/ws` sockets;
- protocol hello/version handshake;
- browser session identity;
- desired instrument publication subscriptions;
- calls into `InstrumentRegistry` for the current subscription-owned runtime policy;
- common JSON and binary send framing;
- common request completion/failure framing;
- common socket buffered-amount/backpressure threshold;
- release of all browser subscriptions on socket close.

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
- live-waveform latest-frame replacement/backpressure state.

Waveform binary behaviour therefore stays scope-specific rather than becoming a generic broker concern.

### DmmWebSocketAdapter

Owns browser-wire mapping specific to the DM858E:

- DMM control validation and dispatch;
- DMM connection/state lifecycle projection;
- latest display-snapshot projection;
- DM858E-targeted raw SCPI;
- in-flight connection-revision validation.

It has no waveform/sample transport surface.

The tiny `WebSocketInstrumentAdapter` / `WebSocketAdapterHost` contract exists only to connect these two fixed adapters to common WebSocket session delivery. It is not an instrument plugin API and does not abstract instrument capabilities.

## InstrumentRegistry

`InstrumentRegistry` still owns subscription-driven activation decisions for the exactly two supported instruments in the current architecture.

Responsibilities:

- map `SupportedInstrument.Dho804` and `SupportedInstrument.Dm858e` to explicit endpoint/runtime registrations;
- track browser-session subscriptions independently per instrument;
- start a runtime on the first subscriber;
- keep it active while any subscriber remains;
- stop it after the last subscriber leaves;
- release all subscriptions when a browser WebSocket closes;
- serialize activation/deactivation transitions;
- roll back a subscription if runtime activation rejects.

DHO804 Sleep is not a registry suspension mode. The scope service/runtime owns that instrument-specific physical-session suspension while registry subscription ownership remains unchanged.

**This lifetime model is intentionally unchanged by Stream C.** Stream D replaces subscription-owned physical lifetime with server-owned runtime lifetime and leaves browser subscriptions as publication/fanout state only.

## Shared SCPI infrastructure

### ScpiTransport

`ScpiTransport` owns one TCP socket and raw SCPI framing for one active instrument session.

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

`ScopeRuntime` owns active physical-session composition, reconnection and deliberate Sleep suspension. Outside Sleep it remains started/stopped by `InstrumentRegistry` until Stream D.

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

`DmmService` owns one logical mutation queue, authoritative post-mutation readback, stale function-dependent control rejection, and current display-snapshot invalidation/deduplication/replay. `DmmRuntime` owns fresh-session connection/composition/recovery.

## Protocol compatibility

WebSocket protocol version 6 uses the application-level handshake:

```text
server: ProtocolHello(PROTOCOL_VERSION)
client: ProtocolHelloAck(PROTOCOL_VERSION)
```

Stream C changes internal ownership only. It does not change protocol version or add a compatibility path.

After handshake, explicit browser subscriptions decide which instrument publications a session receives. The current registry also uses those subscriptions for physical runtime activation until Stream D.

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
- create a fresh session only if that runtime remains active under the current lifetime policy;
- never replay stale commands after reconnect.

Do not add persistent queues, circuit breakers or per-command retry policies without measured need.

## Dependency direction

```text
WebSocket session/protocol broker
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

- `WebSocketGateway` owns common browser transport/session/protocol concerns only.
- `ScopeWebSocketAdapter` owns DHO804 wire mapping and waveform browser delivery semantics.
- `DmmWebSocketAdapter` owns DM858E wire mapping.
- `InstrumentRegistry` still owns subscription-driven physical activation until Stream D.
- `ScopeService` / `DmmService` own application semantics and do not depend on WebSocket types.
- `Dho804Driver` / `Dm858eDriver` own device protocol semantics.
- `ScpiScheduler` owns serialized transport access for one instrument session.
