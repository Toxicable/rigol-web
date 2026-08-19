# Rigol Web Architecture

## Purpose

Rigol Web is a local web interface for a Rigol DHO804 oscilloscope.

The goal is to provide a faster, clearer and more flexible interface than the scope UI while retaining direct access to native scope capabilities through SCPI.

This is a personal project. The initial design should not be distorted by requirements for commercial deployment, arbitrary instruments, hostile multi-user environments or hypothetical future hardware.

Project-level implementation principles are documented in `development-practices.md`. TypeScript-specific conventions are documented separately in `typescript-practices.md`.

## Target hardware

Initial target:

- Rigol DHO804 only
- Ethernet connection
- Raw SCPI over a persistent TCP connection
- Behaviour based on the Rigol DHO800/DHO900 Programming Guide and DHO800 User Guide

Support for other instruments can be considered later. Do not build a generic instrument framework now.

## Technology

The application is entirely TypeScript.

```text
Browser
   |
   | WebSocket
   v
Rigol Web server
   |
   | persistent TCP / SCPI
   v
Rigol DHO804
```

Selected stack:

- Node.js + TypeScript server
- React + TypeScript frontend
- Vite
- Zustand for application/scope state
- uPlot for waveform rendering
- one WebSocket connection between browser and server

HTTP is only needed to serve the frontend and simple infrastructure endpoints such as health checks.

Frontend details are documented in `frontend.md`.

## Server structure

The server uses explicit layers with one path to the instrument:

```text
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

Polling and waveform services use the same driver/scheduler path. Nothing writes directly to the scope socket outside the SCPI transport/scheduler boundary.

Detailed module ownership and lifecycle are documented in `server-architecture.md`.

## Scope connection

The server maintains one persistent TCP connection to the DHO804.

All SCPI operations pass through the dedicated scheduler/transport layer.

Reasons:

- SCPI query responses must remain associated with the correct request
- binary waveform transfers must remain atomic
- interactive operations need priority over background work
- continuous controls need coalescing
- polling must not interfere with interaction

The scheduler is documented separately in `scpi-scheduler.md`.

Connection handling should remain simple. If socket or SCPI framing integrity is lost, fail visibly and recreate the connection rather than trying to salvage an uncertain stream or replay stale work.

## Browser connection

The browser uses one persistent WebSocket connection to the server.

The WebSocket carries:

- commands
- scope state
- measurements
- errors
- SCPI console requests/responses
- live waveform data
- deep-capture viewport data

Use JSON for control/state/lifecycle messages and binary WebSocket frames for waveform samples.

Fixed protocol values and discriminants use numeric TypeScript enums rather than repeated string values. Object field names remain descriptive.

WebSocket compression should be disabled initially. This runs on a local network, so responsiveness and low latency matter more than reducing bandwidth.

The server sends complete authoritative `ScopeState` snapshots rather than partial patches.

The JSON protocol is documented in `websocket-protocol.md`. The binary waveform layout is documented in `waveform-protocol.md`.

## Scope state

The physical oscilloscope is the authoritative source of state.

The server maintains a cached model of important scope state, including at least:

- channel enable state
- channel coupling and amplitude unit
- channel vertical scale
- channel vertical offset
- probe ratio
- horizontal scale
- horizontal position
- sample rate
- memory depth
- trigger type
- trigger source
- trigger level
- trigger slope
- acquisition state

The concrete DHO804 types, SCPI mappings and Rigol-specific response parsing rules are documented in `scope-model.md`.

Web interactions update the UI optimistically so controls feel immediate.

Ordinary discrete operations may be read back immediately where useful. Continuous interactions are not read back on every intermediate value.

## State validation

Important scope state is polled at approximately 1 Hz.

The poll exists primarily to detect:

- changes made with the physical scope controls
- changes from another SCPI client
- drift between cached and real scope state

Polling is not the primary propagation path for changes made by Rigol Web.

Properties currently being manipulated interactively must not be overwritten by stale poll results. After an interaction completes, the final value is explicitly read back and reconciled.

## Interaction model

Continuous controls are performance-critical.

Examples:

- vertical offset
- trigger level
- horizontal position
- vertical/horizontal scale when gesture driven

During interaction:

1. the browser updates its local display immediately
2. the browser sends the desired value over the WebSocket
3. the server scheduler coalesces equivalent pending operations
4. the latest useful value is sent to the scope as soon as the SCPI connection is available

Intermediate values may be discarded if the scope cannot consume them quickly enough.

There should be no arbitrary fixed-rate throttle unless measurement shows one is required.

When the interaction ends, the final value must be sent with highest priority, then read back from the scope and reconciled.

## Frontend data flow

Application/scope state and waveform data use separate paths.

```text
WebSocket
   |
   +---- JSON state/control ----> Zustand ----> React UI
   |
   +---- binary waveform ------> waveform layer ----> uPlot
```

Waveform samples do not live in React or Zustand state.

A uPlot instance is created once for a waveform view and updated imperatively as data arrives.

See `frontend.md`.

## Waveform acquisition

The application deliberately separates live display acquisition from deep acquisition.

### Live display

While running:

- use the DHO waveform NORMAL/screen path
- keep waveform reads small
- optimise for transaction latency
- send live samples directly to the browser as binary frames
- stale waveform frames may be discarded

The live display is for responsiveness, not complete acquisition memory.

### Deep acquisition

When stopped or after a single acquisition:

- use RAW waveform acquisition
- retrieve the full acquisition into server memory
- treat the transfer from the DHO804 as an explicit long-running operation
- keep the full capture server-side
- downsample on the server for the requested browser viewport
- use min/max bucketing rather than every-Nth-sample decimation
- return display-resolution binary waveform windows to the browser
- overscan viewport responses so small pans remain local and immediate

The browser should not receive tens of millions of samples merely to discard most of them before rendering.

Panning and zooming within an already acquired deep capture must not require another read from the DHO804.

See `waveforms.md`.

## Waveform representation

The DHO804's native waveform codes and TMC/IEEE block format stop at the DHO804 driver boundary.

The server normalizes waveform samples into numeric amplitude values before sending browser frames. Deep captures are stored as per-channel `Float32Array`s in the current channel amplitude unit, which keeps the rest of the application independent from Rigol native WORD encoding details.

The browser binary frame uses fixed-size indexed Float32 records. Each record carries the original source sample index and amplitude value, allowing the same format to represent both sequential live samples and min/max-downsampled deep points.

The frame also carries X increment/origin/reference and channel amplitude unit, so the browser can derive real X values without receiving native Rigol Y code-scaling fields.

See `waveform-protocol.md`.

## Backpressure

Live waveform data is disposable.

If the browser cannot keep up:

- drop stale waveform frames
- prefer the newest waveform
- never discard control, state or error messages merely to preserve old waveform data

The live stream represents current state, not an event log.

## Measurements

Measurement results are dynamic data and do not live inside `ScopeState`.

The browser requests only the measurements it is currently displaying. Start with a low refresh rate around 1 Hz and benchmark before increasing it. Measurement queries must not delay interactive scope controls.

The initial shared measurement set and exact SCPI mapping are documented in `scope-model.md`.

## Version 1 scope

Initial functionality:

- connect to DHO804
- connection/status information
- live waveform display
- CH1-CH4 enable/disable
- vertical scale
- vertical offset
- horizontal scale
- horizontal position
- Run / Stop / Single
- basic edge trigger configuration
- basic measurements
- raw SCPI console
- deep waveform retrieval and server-side viewport downsampling while stopped

More of the DHO804 command set can be added incrementally after the interaction model performs well.

## Architecture documents

- `architecture.md` - overall decisions
- `development-practices.md` - general project implementation principles
- `typescript-practices.md` - TypeScript type, enum and naming conventions
- `scope-model.md` - DHO804 domain types and exact SCPI state/control mapping
- `server-architecture.md` - server module ownership, dependency direction and lifecycle
- `scpi-scheduler.md` - SCPI priority, coalescing and latency behaviour
- `frontend.md` - React/Zustand/uPlot data flow and interaction model
- `waveforms.md` - live/deep waveform ownership, downsampling and viewport caching
- `websocket-protocol.md` - JSON browser/server message model
- `waveform-protocol.md` - binary waveform frame layout
- `testing.md` - fake layers, unit/integration tests and real-scope benchmarks

## References

Primary specification/reference material:

- Rigol DHO800/DHO900 Programming Guide
- Rigol DHO800 User Guide

Useful implementation references:

- ngscopeclient / scopehal Rigol driver
- SCPI-Instrument-Control web gateway
- SCPI-Web-Interface

The Rigol manuals define expected device behaviour. Open-source projects are implementation references, not specifications.