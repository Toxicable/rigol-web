# Server Architecture

## Purpose

The Rigol Web server is deliberately small and concrete. It coordinates one DHO804, one persistent SCPI/TCP connection and browser clients over WebSocket.

The important design goal is clear ownership. There should be one obvious path from an application action to the oscilloscope:

```text
Browser
   |
   | WebSocket
   v
WebSocketGateway
   |
   v
ScopeController
   |
   v
Dho804Driver
   |
   v
ScpiScheduler
   |
   v
ScpiTransport
   |
   v
DHO804
```

Background state polling and waveform acquisition use the same driver/scheduler path. Nothing bypasses the scheduler to write directly to the scope socket.

## ScpiTransport

`ScpiTransport` owns the TCP socket and raw SCPI response framing.

Responsibilities:

- connect and disconnect the TCP socket
- enable low-latency socket behaviour such as `TCP_NODELAY`
- write command bytes
- read complete text responses
- read complete IEEE/TMC binary blocks
- report socket, framing and timeout failures

It does not know about channels, trigger settings, browser messages, priorities or polling.

The scheduler is the only normal caller of the transport.

## ScpiScheduler

`ScpiScheduler` is the sole owner of serialized access to `ScpiTransport`.

Responsibilities:

- one complete SCPI transaction at a time
- P0-P4 priority scheduling
- latest-value-wins coalescing for continuous controls
- supersession of stale live-waveform work
- preserving query/response ownership
- timing and latency instrumentation
- rejecting pending work when the transport becomes unusable

It operates on scheduled operations and should not contain DHO804 command semantics.

See `scpi-scheduler.md` for detailed behaviour.

## Dho804Driver

`Dho804Driver` owns DHO804-specific SCPI commands and parsing.

Responsibilities include:

- exact SCPI command strings
- parsing DHO804 responses into application values
- channel, timebase, trigger and acquisition operations
- measurement queries
- live waveform queries
- RAW/deep waveform queries
- native waveform PREamble/scaling metadata
- conversion of native DHO804 waveform codes into normalized amplitude values
- DHO804-specific behaviour and quirks

Application layers call typed driver operations rather than constructing SCPI strings themselves.

Native Rigol waveform block/code representation ends at this boundary. The waveform services consume normalized per-channel `Float32Array` amplitude data plus X metadata and channel unit.

The raw SCPI console is the deliberate exception: its command text originates in the browser, but execution still passes through `ScpiScheduler` so it cannot corrupt stream ordering.

## ScopeStateStore

`ScopeStateStore` owns the server's cached live `ScopeState` and change notification.

It does not query the instrument itself and does not contain SCPI logic.

The DHO804 remains authoritative. The store is the server-side representation used by the browser-facing application.

The store always contains a complete connected-scope snapshot. Disconnected lifecycle state is represented separately rather than by making `ScopeState` fields optional.

## ScopeController

`ScopeController` owns application-level control semantics.

It translates browser actions into driver operations and coordinates state changes around them.

Responsibilities include:

- ordinary control changes
- interactive update semantics
- final interaction commits
- optimistic state where appropriate
- authoritative focused readback after an interaction completes
- Run / Stop / Single actions
- measurements and raw SCPI routing
- rejecting stale poll snapshots after newer local mutations

The WebSocket layer should not contain scope-control logic, and the DHO804 driver should not know about browser message types.

## ScopePoller

`ScopePoller` validates important DHO804 state at approximately 1 Hz.

It uses `Dho804Driver`, so its queries enter the scheduler as background work.

Its purpose is to detect changes made through:

- physical scope controls
- another SCPI client
- other drift between cached and actual state

Poll cycles do not pile up. If a local state-affecting mutation occurs while a complete poll snapshot is in flight, that stale poll snapshot is discarded and the next cycle validates again.

The poller owns its timer. Timers do not belong inside the driver or state store.

## LiveWaveformService

`LiveWaveformService` owns recurring NORMAL/live waveform acquisition.

Responsibilities:

- request small normalized live waveform reads through `Dho804Driver`
- select enabled channels as required
- read enabled channels as separate serialized transactions
- avoid building a FIFO backlog of waveform requests
- keep at most one acquisition in progress and one indication that a newer frame is wanted
- encode/publish fresh live waveform data toward the WebSocket layer

Live waveform work is disposable and lower priority than interaction.

## DeepCaptureService

`DeepCaptureService` owns complete deep captures after they are retrieved from the DHO804.

Responsibilities:

- explicit RAW/deep acquisition while stopped
- server storage of normalized per-channel `Float32Array` captures
- one latest-completed positive capture ID in version 1
- selecting requested sample ranges
- server-side min/max downsampling
- overscanned viewport responses for responsive browser pan/zoom
- encoding deep viewport binary frames

A failed replacement capture leaves the previous completed capture intact. A successful replacement invalidates the previous capture ID.

Panning or zooming an existing deep capture must not trigger another read from the oscilloscope.

See `waveforms.md` and `waveform-protocol.md` for detailed waveform behaviour.

## WebSocketGateway

`WebSocketGateway` owns browser/server transport, not application behaviour.

Responsibilities:

- accept browser WebSocket connections
- validate and decode incoming JSON protocol messages
- dispatch commands to the appropriate application service
- serialize state, results and errors
- send binary waveform frames
- enforce browser-side waveform backpressure behaviour

It must not construct DHO804 SCPI commands, directly mutate scope state, or implement waveform downsampling.

Multiple browser tabs share the same physical scope/server state. Version 1 does not add session ownership or locking.

See `websocket-protocol.md` for JSON protocol details.

## ScopeRuntime

`ScopeRuntime` composes and owns the lifetime of the server-side scope session.

Conceptually:

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

A successful scope session starts directly:

```text
connect TCP
   -> identify and require DHO804
   -> read a complete initial ScopeState
   -> publish Connected state
   -> start polling and live-waveform work
```

A partially initialized scope is not treated as connected.

The HTTP/WebSocket application itself may remain running while the scope is switched off. Version 1 reconnection is deliberately simple: one connection attempt at a time and a fixed short retry interval after failure. Each reconnect creates a fresh scope session; stale operations from the old session are never replayed.

## Failure philosophy

Rigol Web is a personal local-network tool, not a high-availability service.

Prefer simple, visible failure over elaborate recovery machinery.

If socket or SCPI framing integrity is no longer trustworthy:

- fail the current operation loudly
- close the scope connection rather than guessing
- discard stale queued and interactive work
- do not replay old commands after a reconnect
- publish the disconnected state visibly to browser clients

Reconnect behaviour remains simple. Do not add circuit breakers, persistent command queues, per-command retry policies or complex degraded states unless actual use demonstrates a need.

An in-progress deep capture that loses transport fails. Version 1 may discard retained deep capture state when a completely new scope session is created rather than complicating cross-session ownership.

## Dependency direction

Higher layers depend downward on narrower responsibilities:

```text
WebSocket/application
        |
        v
DHO804 semantics
        |
        v
SCPI scheduling
        |
        v
TCP/framing
```

Do not add a dependency-injection framework or generic event bus. Ordinary constructor dependencies and explicit callbacks/subscriptions are sufficient.

## Source layout

```text
src/
|- shared/
|  |- scope-types.ts
|  |- websocket-protocol.ts
|  `- waveform-protocol.ts
|
|- server/
|  |- server.ts
|  |- scope-runtime.ts
|  |
|  |- scpi/
|  |  |- scpi-transport.ts
|  |  `- scpi-scheduler.ts
|  |
|  |- scope/
|  |  |- dho804-driver.ts
|  |  |- scope-controller.ts
|  |  |- scope-state-store.ts
|  |  `- scope-poller.ts
|  |
|  |- waveform/
|  |  |- live-waveform-service.ts
|  |  |- deep-capture-service.ts
|  |  |- downsample.ts
|  |  `- waveform-frame-encoder.ts
|  |
|  `- websocket/
|     `- websocket-gateway.ts
|
`- web/
```

Tests live beside the files they exercise rather than in a separate generic test hierarchy.

TypeScript naming and type conventions are documented separately in `typescript-practices.md`.

## Workstream ownership

Implementation boundaries are documented under `docs/workstreams/`:

- `foundation.md`
- `scpi-backend.md`
- `server-control.md`
- `waveforms.md`
- `frontend.md`
- `integration.md`

The point of those handoffs is to let implementation proceed with minimal shared-file contention.

## Key boundaries

The boundaries that should remain especially clear are:

- `Dho804Driver` is the DHO804/SCPI semantic boundary
- `ScopeController` is the application-command boundary
- `ScpiScheduler` is the serialized transport-ownership boundary
- waveform services own normalized display/capture data, not native Rigol encoding
- `WebSocketGateway` owns browser transport, not scope semantics

Keeping those boundaries simple should let the rest of the application evolve without turning the server into a generic framework.