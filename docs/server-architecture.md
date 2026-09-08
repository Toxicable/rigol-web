# Server Architecture

## Purpose

The Rigol Web server coordinates two fixed instruments, the DHO804 and DM858E, plus browser clients over one WebSocket per browser tab.

The design remains concrete. Shared code exists only where both supported instruments genuinely need the same behaviour, principally SCPI transport/scheduling/program-message classification and subscription-owned lifecycle.

## Top-level structure

```text
Browser WebSocket
      |
      v
WebSocketGateway
   /            \
  v              v
ScopeService    DmmService
  |              |
  v              v
ScopeRuntime    DmmRuntime
   \            /
   InstrumentRegistry lifecycle
  |              |
Dho804Driver   Dm858eDriver
   \            /
    ScpiScheduler
          |
    ScpiTransport
```

Each active instrument gets its **own** scheduler and transport instance. Only their implementations are shared.

## InstrumentRegistry

`InstrumentRegistry` owns subscription-driven activation decisions for the exactly two supported instruments.

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

DHO804 Sleep is deliberately **not** a registry suspension mode. The scope service/runtime owns that instrument-specific physical-session suspension while registry subscription ownership remains unchanged. The later runtime-lifetime refactor still owns replacement of subscription-driven activation itself.

This is a small lifecycle registry, not a generic plugin framework or dependency-injection container.

Configured endpoints are explicit:

```text
RIGOL_SCOPE_HOST
RIGOL_SCOPE_PORT
RIGOL_DMM_HOST
RIGOL_DMM_PORT
```

No browser message may choose an arbitrary host or port.

## Shared SCPI infrastructure

### ScpiTransport

`ScpiTransport` owns one TCP socket and raw SCPI framing for one active instrument session.

Responsibilities:

- connect/disconnect
- low-latency socket options such as `TCP_NODELAY`
- write command bytes
- read complete text responses
- read complete IEEE/TMC binary blocks
- report socket, framing and timeout failures

It does not know DHO804 channels, DM858E functions, browser messages, polling or application state.

### ScpiScheduler

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

### SCPI program-message classification

`src/server/scpi/scpi-program-message.ts` owns the generic raw-SCPI message rules used by both drivers:

- non-empty input
- exactly one CR/LF-free program message
- command/query classification from `?` outside quoted strings
- doubled quote handling inside SCPI strings

Drivers do not maintain independent raw-SCPI query scanners.

## DHO804 path

```text
WebSocketGateway
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

`ScopeStateStore` owns the complete cached connected `ScopeState` and change notifications. It does not query the instrument.

`ScopeController` owns application-level scope control semantics including discrete/interactive controls, readback, acquisition actions, measurements and raw SCPI routing.

`ScopePoller` validates important physical scope state. Live/deep waveform services remain DHO804-specific.

`ScopeService` is the application boundary for scope controls, acquisition actions, measurements, raw SCPI, waveform/deep-capture operations and DHO804 Sleep. It owns per-session `ScopeController` instances and exposes data-only connection/state/waveform publications.

DHO804 Sleep follows one application path:

```text
browser ScopeSleep request
  -> WebSocketGateway
  -> ScopeService.sleep()
  -> ScopePowerLifecycle
       -> ScopeRuntime.suspendForSleep()
       -> Dho804PowerControl.sleep()
       -> TCP offline/online wake monitor
       -> ScopeRuntime.resumeAfterSleep()
```

The runtime's sleep suspension preserves its registry activation/subscribers but stops its physical session and reconnect loop until a physical wake is observed. A failed ADB Sleep or failed wake monitor releases the suspension so normal runtime recovery can continue. `POST /api/scope/sleep` does not exist; HTTP is not a second scope control plane.

`ScopeRuntime` owns active DHO804 physical-session composition, reconnection and deliberate Sleep suspension. It does not import WebSocket gateway or wire-result types. Outside Sleep it remains started/stopped by `InstrumentRegistry` subscription ownership until the later runtime-lifetime stream.

## DM858E path

```text
WebSocketGateway
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

`Dm858eDriver` owns:

- exact DM858E SCPI commands and parsing
- model validation
- function/range/rate mappings
- latest-reading snapshot parsing
- immediate physical-function validation before function-dependent writes

`DmmStateStore` owns authoritative cached DMM configuration state. Non-applicable range/rate controls are represented explicitly as `null`.

`DmmPoller` performs two distinct jobs while the runtime is active:

- low-rate authoritative configuration reconciliation
- latest-reading display snapshot polling

The display snapshot is not a sample stream. It carries no sequence/sample identity and must not be used for sample statistics.

`DmmService` owns:

- one logical mutation queue shared by browser controls and raw SCPI
- authoritative state readback after mutations
- stale function-dependent control rejection
- current display snapshot deduplication, invalidation and replay

`DmmRuntime` owns only fresh-session connect/identify/start/stop/reconnect composition plus DMM polling for its active physical session.

Range/rate messages carry the function under which the browser created them. Under mutation ownership the service compares that expected function with a fresh authoritative state read. The driver then rechecks `SENSe:FUNCtion?` immediately before the write in the same scheduler operation. Stale requests fail rather than being reinterpreted under another function.

Do not route DM858E commands through `ScopeController`, and do not place DM858E state into `ScopeStateStore`.

## WebSocketGateway

`WebSocketGateway` owns browser/server transport, protocol validation and session-scoped routing.

Responsibilities:

- accept `/ws` connections
- send `ProtocolHello` immediately
- require a matching `ProtocolHelloAck` before application traffic
- track instruments subscribed by each browser session
- dispatch commands only when that session is subscribed to the target instrument
- structurally validate function-bound DMM range/rate controls
- publish lifecycle/state/snapshots/waveforms only to subscribed sessions
- route raw SCPI to the explicitly named instrument
- route DHO804 Sleep to `ScopeService.sleep()`
- send command results/errors
- enforce DHO804 waveform backpressure behaviour
- release all session subscriptions when the socket closes

It must not construct instrument SCPI commands, directly mutate instrument state, implement DHO804 power orchestration or implement waveform downsampling.

Multiple browser tabs may subscribe to the same physical instrument. They share one runtime/session for that instrument; there is no exclusive browser lock.

See `websocket-protocol.md`.

## Protocol compatibility

WebSocket protocol version 6 uses an application-level handshake before subscriptions:

```text
server: ProtocolHello(PROTOCOL_VERSION)
client: ProtocolHelloAck(PROTOCOL_VERSION)
```

Version 6 adds the DHO804 `ScopeSleep` request to the normal command path and is a hard cut from older browser/server bundles. Any non-handshake client message received before acknowledgement closes the socket with a protocol error.

## Raw SCPI

Raw SCPI console targeting is explicit:

```text
ScpiExecute(instrument, command)
```

The gateway routes it to the selected service's normal mutation/scheduler path. There is no implicit DHO804 target and no direct socket bypass.

## DMM lifecycle publication

The gateway exposes separate DM858E lifecycle/data messages:

- `DmmConnected`
- `DmmState`
- `DmmDisconnected`
- `DmmSnapshot`

`DmmSnapshot` is latest display state, not a new-measurement event. `Unavailable` snapshots replace a prior valid display when the backend can no longer report a usable current value.

## HTTP boundary

HTTP owns frontend/static serving and simple HTTP-specific infrastructure such as `/health`. Instrument application operations use the WebSocket/application-service path. There is no REST/HTTP scope power control surface.

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
instrument-specific runtime/driver
        |
        v
shared SCPI scheduler/program-message rules
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
|  |  |- scpi-scheduler.ts
|  |  `- scpi-program-message.ts
|  |- scope/
|  |  |- dho804-driver.ts
|  |  |- dho804-power-control.ts
|  |  |- scope-controller.ts
|  |  |- scope-power-lifecycle.ts
|  |  |- scope-state-store.ts
|  |  `- scope-poller.ts
|  |- dmm/
|  |  |- dm858e-driver.ts
|  |  |- dmm-runtime.ts
|  |  |- dmm-state-store.ts
|  |  `- dmm-poller.ts
|  |- waveform/
|  `- websocket/
|     `- websocket-gateway.ts
|
`- web/
```

Tests live beside the files they exercise.

## Key boundaries

- `InstrumentRegistry` owns subscription-driven activation, not instrument semantics or DHO804 power suspension.
- `ScopeService`/`ScopePowerLifecycle` own DHO804 Sleep orchestration; `ScopeRuntime` owns the corresponding physical-session suspension/resume.
- `Dho804Driver` owns DHO804 SCPI semantics.
- `Dm858eDriver` owns DM858E SCPI semantics.
- `ScopeController` remains scope-only.
- `DmmService` owns DMM logical mutation serialization and state reconciliation; `DmmRuntime` owns physical session composition/recovery.
- `ScpiScheduler` owns serialized transport access for one instrument session.
- generic raw-SCPI message classification lives in the SCPI layer.
- waveform services remain DHO804-specific.
- `WebSocketGateway` owns transport/session routing, not device commands or power orchestration.
