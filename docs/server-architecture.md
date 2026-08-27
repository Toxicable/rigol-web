# Server Architecture

## Purpose

The Rigol Web server coordinates two fixed instruments, the DHO804 and DM858E, plus browser clients over one WebSocket per browser tab.

The design remains concrete. Shared code exists only where both supported instruments genuinely need the same behaviour, principally SCPI transport/scheduling and subscription-owned lifecycle.

## Top-level structure

```text
Browser WebSocket
      |
      v
WebSocketGateway
      |
      v
InstrumentRegistry
   /            \
  v              v
ScopeRuntime    DmmRuntime
  |              |
Dho804Driver   Dm858eDriver
   \            /
    ScpiScheduler
          |
    ScpiTransport
```

Each active instrument gets its **own** scheduler and transport instance. Only their implementations are shared.

## InstrumentRegistry

`InstrumentRegistry` owns activation decisions for the exactly two supported instruments.

Responsibilities:

- map `SupportedInstrument.Dho804` and `SupportedInstrument.Dm858e` to explicit endpoint/runtime registrations
- track browser-session subscriptions independently per instrument
- start a runtime on the first subscriber
- keep it active while any subscriber remains
- stop it after the last subscriber leaves
- release all subscriptions when a browser WebSocket closes
- serialize activation/deactivation transitions so rapid route changes cannot leave runtime state inverted
- roll back a subscription if runtime activation rejects, so the same browser can retry cleanly
- mark the registry inactive before awaiting idempotent runtime deactivation, so a failed `stop()` remains retryable on a later subscription

This is a small lifecycle registry, not a generic plugin framework or dependency-injection container.

The configured endpoints are:

```text
RIGOL_SCOPE_HOST
RIGOL_SCOPE_PORT
RIGOL_DMM_HOST
RIGOL_DMM_PORT
```

No browser message may choose an arbitrary host or port.

## ScpiTransport

`ScpiTransport` owns one TCP socket and raw SCPI framing for one active instrument session.

Responsibilities:

- connect/disconnect
- low-latency socket options such as `TCP_NODELAY`
- write command bytes
- read complete text responses
- read complete IEEE/TMC binary blocks
- report socket, framing and timeout failures

It does not know DHO804 channels, DM858E functions, browser messages, polling or application state.

## ScpiScheduler

`ScpiScheduler` is the sole normal owner of serialized access to its `ScpiTransport`.

Responsibilities:

- one complete SCPI transaction at a time
- P0-P4 priority scheduling
- query/response ownership
- binary-transfer atomicity
- coalescing/supersession where callers provide keys
- timing/latency instrumentation
- rejecting pending work when the transport becomes unusable

The DHO804 and DM858E do not share a scheduler queue. Each runtime creates its own scheduler around its own transport.

See `scpi-scheduler.md`.

## DHO804 path

The existing DHO804 application path remains:

```text
WebSocketGateway
   |
ScopeController
   |
Dho804Driver
   |
ScpiScheduler
   |
ScpiTransport
```

### Dho804Driver

Owns exact DHO804 SCPI commands, response parsing, waveform native representation and device-specific quirks.

Native Rigol waveform/TMC representation stops at this boundary. Higher waveform services consume normalized amplitude data.

### ScopeStateStore

Owns the complete cached connected `ScopeState` and change notifications. It does not query the instrument.

### ScopeController

Owns application-level scope control semantics:

- discrete controls
- interactive update/commit behaviour
- optimistic state where appropriate
- focused authoritative readback
- Run/Stop/Single
- measurements
- raw DHO804 SCPI routing
- stale poll rejection around newer local mutations

### ScopePoller

Validates important physical scope state at approximately 1 Hz. Poll cycles do not pile up and stale snapshots are discarded after newer local mutations.

### LiveWaveformService

Owns recurring NORMAL/live waveform reads, keeps work latest-oriented and publishes normalized binary frames.

### DeepCaptureService

Owns RAW/deep capture retrieval, retained full captures, min/max viewport downsampling and deep viewport encoding.

See `waveforms.md` and `waveform-protocol.md`.

## ScopeRuntime

`ScopeRuntime` composes one live DHO804 session:

```text
ScopeRuntime
  |- ScpiTransport
  |- ScpiScheduler
  |- Dho804Driver
  |- ScopeStateStore
  |- ScopeController
  |- ScopePoller
  |- LiveWaveformService
  `- DeepCaptureService
```

Unlike the original scope-only startup model, `ScopeRuntime.start()` is called by `InstrumentRegistry` only while at least one DHO804 browser subscription exists.

Activation publishes a pending/disconnected lifecycle first, then attempts:

```text
connect TCP
 -> identify and require DHO804
 -> read complete initial ScopeState
 -> publish Connected
 -> start poll/live services
```

A partially initialized scope is never published as connected.

While activated, transport failure uses the existing simple fresh-session retry loop. Once the last DHO804 subscriber leaves, `stop()` publishes inactive state immediately, cancels/rejects current work and disposes the session. No reconnect loop runs while inactive.

## DM858E path

The foundation reserves a separate DMM runtime/controller/driver path and shared browser contracts without implementing the device SCPI semantics in this workstream.

The backend workstream owns:

```text
src/server/dmm/dm858e-driver.ts
src/server/dmm/dmm-runtime.ts
src/server/dmm/dmm-state-store.ts
src/server/dmm/dmm-poller.ts   (only if needed)
```

`Dm858eDriver` will own exact DM858E commands/parsing. Its runtime will create a fresh `ScpiTransport` + `ScpiScheduler` session under the same subscription lifecycle as the DHO804.

Do not route DM858E commands through `ScopeController`, and do not place DM858E state into `ScopeStateStore`.

## WebSocketGateway

`WebSocketGateway` owns browser/server transport, protocol validation and session-scoped routing.

Responsibilities:

- accept `/ws` connections
- send `ProtocolHello` immediately
- require a matching `ProtocolHelloAck` before application traffic
- track the instruments subscribed by each browser session
- dispatch commands only when that session is subscribed to the target instrument
- publish lifecycle/state/readings/waveforms only to subscribed sessions
- route raw SCPI to the explicitly named instrument
- send command results/errors
- enforce DHO804 waveform backpressure behaviour
- release all session subscriptions when the socket closes

It must not construct instrument SCPI commands, directly mutate instrument state or implement waveform downsampling.

Multiple browser tabs may subscribe to the same physical instrument. They share the one runtime/session for that instrument; there is no exclusive browser lock.

See `websocket-protocol.md`.

## Protocol compatibility

WebSocket protocol version 2 uses an application-level handshake before subscriptions:

```text
server: ProtocolHello(PROTOCOL_VERSION)
client: ProtocolHelloAck(PROTOCOL_VERSION)
```

Any non-handshake client message received before a valid acknowledgement closes the socket with a protocol error. Version mismatch is therefore visible before an old browser can silently wait for a scope lifecycle message that is now subscription-gated.

## Raw SCPI

The raw SCPI console is deliberately allowed to originate command text in the browser, but targeting is explicit:

```text
ScpiExecute(instrument, command)
```

The gateway routes it to the selected runtime's normal scheduler path. There is no implicit DHO804 target and no direct socket bypass.

## DMM lifecycle publication

The gateway exposes separate DM858E lifecycle/data messages:

- `DmmConnected`
- `DmmState`
- `DmmDisconnected`
- `DmmReading`

The real DMM runtime will drive those callbacks in the backend workstream. Until then the route receives a clear backend-not-implemented disconnected state.

## Failure philosophy

Rigol Web is a local bench tool, not a high-availability service.

For either instrument, if socket/framing integrity is no longer trustworthy:

- fail current work clearly
- stop/reject stale queued work
- close the uncertain transport
- create a fresh session only if that runtime remains subscription-active
- never replay stale commands after reconnect

Do not add persistent queues, circuit breakers or per-command retry policies without concrete measured need.

## Dependency direction

```text
WebSocket / app routing
        |
        v
instrument-specific app semantics
        |
        v
instrument-specific driver
        |
        v
shared SCPI scheduler
        |
        v
shared TCP/framing transport
```

Ordinary constructor dependencies and explicit callbacks are sufficient. Do not add a generic event bus or DI framework.

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
|  |  |- scpi-transport.ts
|  |  `- scpi-scheduler.ts
|  |- scope/
|  |  |- dho804-driver.ts
|  |  |- scope-controller.ts
|  |  |- scope-state-store.ts
|  |  `- scope-poller.ts
|  |- dmm/                 (DM858E backend workstream)
|  |- waveform/
|  |  |- live-waveform-service.ts
|  |  |- deep-capture-service.ts
|  |  |- downsample.ts
|  |  `- waveform-frame-encoder.ts
|  `- websocket/
|     `- websocket-gateway.ts
|
`- web/
```

Tests live beside the files they exercise.

## Key boundaries

- `InstrumentRegistry` owns subscription-driven activation, not instrument semantics.
- `Dho804Driver` owns DHO804 SCPI semantics.
- `Dm858eDriver` owns DM858E SCPI semantics once implemented.
- `ScopeController` remains scope-only.
- `ScpiScheduler` owns serialized access for one instrument session.
- waveform services remain DHO804-specific.
- `WebSocketGateway` owns transport/session routing, not device commands.
