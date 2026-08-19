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
- read complete IEEE-style binary blocks
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
- live waveform queries
- RAW/deep waveform queries
- waveform preamble and scaling metadata
- DHO804-specific behaviour and quirks

Application layers should call typed driver operations rather than constructing SCPI strings themselves.

The raw SCPI console is the deliberate exception: its command text originates in the browser, but execution still passes through `ScpiScheduler` so it cannot corrupt stream ordering.

## ScopeStateStore

`ScopeStateStore` owns the server's cached live `ScopeState` and change notification.

It does not query the instrument itself and does not contain SCPI logic.

The DHO804 remains authoritative. The store is the server-side representation used by the browser-facing application.

## ScopeController

`ScopeController` owns application-level control semantics.

It translates browser actions into driver operations and coordinates state changes around them.

Responsibilities include:

- ordinary control changes
- interactive update semantics
- final interaction commits
- optimistic state where appropriate
- authoritative readback after an interaction completes
- Run / Stop / Single actions
- coordinating actions that involve more than one lower-level operation

The WebSocket layer should not contain scope-control logic, and the DHO804 driver should not know about browser message types.

## ScopePoller

`ScopePoller` validates important DHO804 state at approximately 1 Hz.

It uses `Dho804Driver`, so its queries enter the scheduler as background work.

Its purpose is to detect changes made through:

- physical scope controls
- another SCPI client
- other drift between cached and actual state

Polling must not overwrite a property with stale data while that property is being manipulated interactively.

The poller owns its timer. Timers do not belong inside the driver or state store.

## LiveWaveformService

`LiveWaveformService` owns recurring NORMAL/live waveform acquisition.

Responsibilities:

- request small live waveform reads through `Dho804Driver`
- select enabled channels as required
- avoid building a FIFO backlog of waveform requests
- keep at most one acquisition in progress and one indication that a newer frame is wanted
- publish fresh live waveform data toward the WebSocket layer

Live waveform work is disposable and lower priority than interaction.

## DeepCaptureService

`DeepCaptureService` owns complete deep captures after they are retrieved from the DHO804.

Responsibilities:

- explicit RAW/deep acquisition
- storage of full raw sample arrays on the server
- capture IDs and capture lookup
- selecting requested sample ranges
- server-side min/max downsampling
- overscanned viewport responses for responsive browser pan/zoom

Panning or zooming an existing deep capture must not trigger another read from the oscilloscope.

See `waveforms.md` for detailed waveform behaviour.

## WebSocketGateway

`WebSocketGateway` owns browser/server transport, not application behaviour.

Responsibilities:

- accept browser WebSocket connections
- validate and decode incoming protocol messages
- dispatch commands to the appropriate application service
- serialize state, results and errors
- send binary waveform frames
- enforce browser-side waveform backpressure behaviour

It must not construct DHO804 SCPI commands, directly mutate scope state, or implement waveform downsampling.

See `websocket-protocol.md` for protocol details.

## ScopeRuntime

`ScopeRuntime` composes and owns the lifetime of the server-side scope components.

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

Startup is deliberately direct:

```text
connect TCP
   -> identify and verify DHO804
   -> read a complete initial ScopeState
   -> publish Connected state
   -> start polling and live-waveform work
```

A partially initialized scope is not treated as connected.

## Failure philosophy

Rigol Web is a personal local-network tool, not a high-availability service.

Prefer simple, visible failure over elaborate recovery machinery.

If socket or SCPI framing integrity is no longer trustworthy:

- fail the current operation loudly
- close the scope connection rather than guessing
- discard stale queued and interactive work
- do not replay old commands after a reconnect

Reconnect behaviour, where used, should remain simple. Do not add circuit breakers, persistent command queues, per-command retry policies or complex degraded states unless actual use demonstrates a need.

Completed deep captures are independent data and may remain available after the live scope connection is lost. An in-progress capture that loses its transport fails.

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

## Suggested source layout

```text
src/
|- shared/
|  |- scope-types.ts
|  `- websocket-protocol.ts
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
|  |  `- downsample.ts
|  |
|  `- websocket/
|     `- websocket-gateway.ts
|
`- web/
```

TypeScript naming and type conventions are documented separately in `typescript-practices.md`.

## Key boundaries

The three boundaries that should remain especially clear are:

- `Dho804Driver` is the DHO804/SCPI semantic boundary
- `ScopeController` is the application-command boundary
- `ScpiScheduler` is the serialized transport-ownership boundary

Keeping those boundaries simple should let the rest of the application evolve without turning the server into a generic framework.