# Rigol Web Architecture

## Purpose

Rigol Web is a local web interface for two fixed Rigol bench instruments:

- DHO804 oscilloscope
- DM858E digital multimeter

The goal is a faster, clearer browser interface while retaining direct access to native instrument capabilities through SCPI.

This remains a personal project. Supporting the second known instrument does **not** turn Rigol Web into a generic instrument framework. Add abstractions only where the DHO804 and DM858E have real shared behaviour.

Project-level implementation principles are documented in `development-practices.md`. TypeScript-specific conventions are documented separately in `typescript-practices.md`.

## Target hardware

Current targets:

- Rigol DHO804
- Rigol DM858E
- Ethernet connection for both
- raw SCPI over a persistent TCP connection while an instrument is active
- DHO804 behaviour based on the Rigol DHO800/DHO900 Programming Guide and DHO800 User Guide
- DM858E behaviour based on the current Rigol DM858 Series Programming Guide

No browser-side arbitrary host/model selection is planned. Server configuration names the two endpoints explicitly.

Required server configuration:

```text
RIGOL_SCOPE_HOST
RIGOL_SCOPE_PORT
RIGOL_DMM_HOST
RIGOL_DMM_PORT
```

## Technology

The application is entirely TypeScript.

```text
Browser
   |
   | one persistent WebSocket
   v
Rigol Web server
   |
   +---- DHO804 runtime ---- SCPI/TCP ---- DHO804
   |
   `---- DM858E runtime ---- SCPI/TCP ---- DM858E
```

Selected stack:

- Node.js + TypeScript server
- React + TypeScript frontend
- React Router for the two instrument routes
- Vite
- Zustand for application/instrument state
- uPlot for DHO804 waveform rendering
- one persistent WebSocket between each browser tab and the server

HTTP serves the frontend and simple infrastructure endpoints such as `/health`.

## Routes and browser lifetime

The fixed routes are:

- `/` — DHO804
- `/dm858e` — DM858E

`BrowserRouter` owns browser navigation and the application shell keeps the WebSocket client above the route elements, so changing routes does not recreate the application-level WebSocket. The route component subscribes to the instrument it owns and unsubscribes when it unmounts.

Direct navigation to `/dm858e` is served through the production SPA fallback. Missing static assets still return `404` rather than being rewritten to `index.html`.

## Instrument activation

Instrument TCP/SCPI sessions are subscription-owned rather than process-owned.

For each supported instrument:

1. the first subscribed browser session activates its runtime
2. additional subscribers share the same physical instrument/runtime
3. unsubscribing one of several sessions does not stop the runtime
4. the last unsubscribe stops the runtime and closes its instrument session
5. closing a browser WebSocket releases all subscriptions owned by that browser session

The lifecycle registry is explicit and contains exactly the DHO804 and DM858E registrations. It is not a plugin framework.

Activation/deactivation transitions are serialized. Subscription state must remain transactional and retryable: a failed runtime activation must not leave a phantom subscriber, and a failed runtime deactivation must not leave the registry believing an uncertain runtime is definitely still active. Runtime `start()`/`stop()` implementations are idempotent so the registry can safely retry reconciliation after failures.

## Shared SCPI foundation

Each active physical instrument owns its own `ScpiTransport` and `ScpiScheduler` instance. The transport/scheduler implementation is shared; socket state and queues are not shared between instruments.

The scheduler preserves:

- query/response ownership
- one complete SCPI transaction at a time per instrument
- binary transfer atomicity
- priority scheduling
- coalescing/supersession where the owning runtime uses it
- clear rejection when the transport becomes unusable

No instrument-specific SCPI command knowledge belongs in the generic transport or scheduler.

## DHO804 server path

The DHO804 path remains concrete:

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

The DHO804 runtime is dormant while no browser route is subscribed. Once active, reconnection behaviour remains the existing simple fresh-session retry loop.

## DM858E server path

The DM858E backend uses the same transport/scheduler foundation but separate meter-specific state and driver types:

```text
WebSocketGateway
   |
   v
Dmm runtime/controller boundary
   |
   v
Dm858eDriver
   |
   v
ScpiScheduler
   |
   v
ScpiTransport
   |
   v
DM858E
```

The DM858E driver/runtime is implemented in the backend workstream. The multi-instrument foundation defines the activation and browser protocol boundaries without inventing DM858E SCPI commands.

## Browser connection and protocol handshake

Each browser tab uses one persistent WebSocket at `/ws`.

Protocol version 2 begins with an application-level handshake before instrument traffic:

```text
server -> ProtocolHello(version)
browser -> ProtocolHelloAck(version)
```

The server rejects application messages before a successful hello acknowledgement. A version mismatch closes the socket clearly instead of allowing an old browser bundle to wait silently for lifecycle messages it will never receive.

After the handshake, the browser sends explicit instrument subscriptions. Lifecycle/state/waveform publications are sent only to sessions subscribed to that instrument.

The WebSocket carries:

- protocol handshake
- instrument subscribe/unsubscribe
- DHO804 controls/state/measurements
- DM858E controls/state/readings
- errors and command completion
- instrument-targeted raw SCPI console requests/responses
- DHO804 live waveform data
- DHO804 deep-capture viewport data

Use JSON for control/state/lifecycle messages and binary WebSocket frames for DHO804 waveform samples.

Fixed protocol values and discriminants use numeric TypeScript enums. Object field names remain descriptive.

WebSocket compression remains disabled initially because this is a local-network latency-sensitive application.

See `websocket-protocol.md` and `waveform-protocol.md`.

## Browser transport state

WebSocket transport state is an application-level concern separate from either instrument lifecycle.

The browser exposes shared transport states:

- Connecting
- Connected (protocol handshake complete)
- Disconnected with reason

Both instrument UIs must invalidate a previously connected presentation when the browser/server transport is lost. A stale DMM reading must never remain visually indistinguishable from a live connected reading merely because no later DMM lifecycle message can arrive.

## Raw SCPI

Raw SCPI is explicitly instrument-targeted end to end. Browser APIs and protocol messages require a `SupportedInstrument`; there is no implicit DHO804 default.

Raw commands still pass through the selected instrument's normal scheduler. Nothing bypasses transaction serialization.

## DHO804 state

The physical oscilloscope is authoritative for scope state.

The server maintains a complete cached `ScopeState`, including channel, horizontal, acquisition and trigger state. The browser receives complete authoritative snapshots rather than partial patches.

Web interactions may update presentation optimistically. Continuous controls use the existing coalesced fast path and reconcile from authoritative focused readback after commit.

Important scope state is validated periodically, approximately 1 Hz, to detect front-panel changes and other drift.

The concrete DHO804 types and SCPI mappings are documented in `scope-model.md`.

## DM858E state

DM858E browser/server contracts are separate from `ScopeState`.

Shared DMM types cover:

- measurement function
- Auto/fixed range
- Slow/Medium/Fast acquisition rate
- primary reading value/overload and unit
- typed DMM control changes

The physical DM858E remains authoritative. Exact SCPI mapping and state reconciliation belong to the DM858E backend workstream.

## DHO804 waveform acquisition

The application separates live display acquisition from deep acquisition.

### Live display

While running:

- use the DHO waveform NORMAL/screen path
- keep waveform reads small
- optimise for transaction latency
- send live samples directly to subscribed DHO804 browser sessions as binary frames
- stale waveform frames may be discarded

### Deep acquisition

When stopped or after a single acquisition:

- use RAW waveform acquisition
- retrieve the full acquisition into server memory
- keep the full capture server-side
- downsample on the server for requested browser viewports
- use min/max bucketing rather than every-Nth-sample decimation
- return display-resolution binary waveform windows
- overscan viewport responses so small pans remain local

Panning and zooming a retained deep capture must not cause another DHO804 read.

See `waveforms.md` and `waveform-protocol.md`.

## Waveform representation and backpressure

Native DHO804 waveform codes and IEEE/TMC block representation stop at the DHO804 driver boundary. The server publishes normalized amplitude data.

Live waveform data is disposable. Under browser backpressure:

- replace stale live frames with newer frames
- preserve JSON control/state/error messages
- do not build an unbounded waveform queue

Waveform data remains outside React/Zustand state.

## Measurements

DHO804 measurements are dynamic request/result data and are not members of `ScopeState`.

DM858E primary readings likewise use their own reading messages rather than being inserted into scope state or a generic mixed instrument object.

## Failure philosophy

Prefer simple visible failure over elaborate recovery.

If SCPI socket/framing integrity is lost:

- fail affected work clearly
- discard stale queued work
- close the uncertain instrument session
- create a fresh session only while that runtime remains activated by subscriptions
- never replay stale commands after reconnect

Do not add persistent command queues, circuit breakers or per-command retry machinery without measured need.

## Architecture documents

- `architecture.md` — overall decisions
- `development-practices.md` — project implementation principles
- `typescript-practices.md` — TypeScript conventions
- `scope-model.md` — DHO804 domain model and SCPI mapping
- `server-architecture.md` — server ownership and lifecycle
- `scpi-scheduler.md` — generic scheduler semantics
- `frontend.md` — browser routing/state/data flow
- `waveforms.md` — DHO804 live/deep waveform ownership
- `websocket-protocol.md` — JSON browser/server protocol
- `waveform-protocol.md` — DHO804 binary waveform layout
- `testing.md` — fake layers, integration tests and hardware benchmarks
- `workstreams/dm858e-*.md` — staged DM858E implementation handoffs

## References

Primary device specifications:

- Rigol DHO800/DHO900 Programming Guide
- Rigol DHO800 User Guide
- Rigol DM858 Series Programming Guide

Open-source projects may be useful implementation references, but the Rigol manuals define expected device behaviour.
