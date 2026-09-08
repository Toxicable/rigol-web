# Rigol Web Architecture

## Purpose

Rigol Web is a local web interface for two fixed Rigol bench instruments:

- DHO804 oscilloscope
- DM858E digital multimeter

The application is intentionally concrete. Supporting multiple known instruments does **not** make Rigol Web a generic instrument framework.

Project implementation principles are in `development-practices.md`; TypeScript conventions are in `typescript-practices.md`.

## Target hardware and configuration

Current targets:

- Rigol DHO804
- Rigol DM858E
- Ethernet SCPI/TCP for both

Server configuration names the two endpoints explicitly:

```text
RIGOL_SCOPE_HOST
RIGOL_SCOPE_PORT
RIGOL_DMM_HOST
RIGOL_DMM_PORT
```

No browser-side arbitrary host/model selection is planned.

## Technology and top-level flow

The application is entirely TypeScript:

```text
Browser
   |
   | one persistent WebSocket
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
DHO804 runtime        DM858E runtime
  |                    |
 SCPI/TCP             SCPI/TCP
  |                    |
DHO804                DM858E
```

Selected stack:

- Node.js + TypeScript server
- React + TypeScript frontend
- React Router
- Vite
- Zustand for application/instrument state
- uPlot for DHO804 waveform rendering
- one persistent browser/server WebSocket per tab

HTTP serves the frontend and simple infrastructure endpoints such as `/health`.

## Routes and browser lifetime

Fixed routes:

- `/` — DHO804
- `/dm858e` — DM858E

The application-level WebSocket lives above route elements, so navigation does not recreate it. Route components subscribe/unsubscribe from the publications they need.

Direct navigation to `/dm858e` uses the production SPA fallback. Missing static assets remain `404`.

## Current physical instrument lifetime

Physical instrument sessions are still subscription-owned in the current architecture:

1. first browser subscription activates the runtime;
2. additional subscribers share it;
3. last unsubscribe stops it;
4. closing a WebSocket releases that session's subscriptions.

This model is intentionally unchanged by the WebSocket adapter refactor. The active architecture-refactor sequence moves physical lifetime to server ownership in Stream D; browser subscriptions then become publication/fanout concerns only.

## WebSocket broker and adapters

The common `WebSocketGateway` owns only application transport/session concerns:

- socket accept/close;
- protocol hello/version handshake;
- browser session identity;
- publication subscriptions;
- common JSON/binary delivery;
- common command completion/failure framing;
- common socket backpressure threshold;
- release of registry subscriptions on disconnect.

Instrument semantics live behind explicit adapters:

```text
WebSocketGateway
  -> ScopeWebSocketAdapter -> ScopeService
  -> DmmWebSocketAdapter   -> DmmService
```

`ScopeWebSocketAdapter` owns scope request validation/dispatch, lifecycle/state projection, measurements, DHO804 raw SCPI mapping, deep-capture wire mapping and all DHO804 waveform browser-delivery semantics.

`DmmWebSocketAdapter` owns DMM request validation/dispatch, lifecycle/state/snapshot projection and DM858E raw SCPI mapping.

The adapter contract is a small internal transport boundary for these two fixed adapters, not a plugin API. Scope and DMM domain models remain separate.

## Browser protocol handshake

Each tab connects to `/ws` and completes:

```text
server -> ProtocolHello(version)
browser -> ProtocolHelloAck(version)
```

Application traffic before a matching acknowledgement is rejected. Version mismatch closes the socket clearly.

Protocol version 6 remains current. The Stream C adapter split is internal and does not change the wire protocol or add compatibility shims.

After handshake the browser sends explicit instrument subscriptions. Publications are delivered only to subscribed sessions.

The WebSocket carries:

- protocol handshake;
- instrument subscribe/unsubscribe;
- DHO804 controls/state/measurements;
- DM858E controls/state/readings;
- command completion/errors;
- instrument-targeted raw SCPI;
- DHO804 live waveform frames;
- DHO804 deep-capture viewport frames.

Control/state/lifecycle traffic is JSON. DHO804 waveform samples use binary frames. Compression remains disabled for this local-network latency-sensitive application.

See `websocket-protocol.md` and `waveform-protocol.md`.

## Shared SCPI foundation

Each active physical instrument owns its own `ScpiTransport` and `ScpiScheduler`. Implementations are shared; socket state and queues are not.

The scheduler preserves:

- one complete transaction at a time per instrument;
- query/response ownership;
- binary transfer atomicity;
- priority scheduling;
- coalescing/supersession where used;
- clear rejection when transport integrity is lost.

No instrument-specific SCPI knowledge belongs in the generic transport or scheduler.

## DHO804 server path

```text
WebSocketGateway
   |
ScopeWebSocketAdapter
   |
ScopeService
   |
ScopeController
   |
Dho804Driver
   |
ScpiScheduler
   |
ScpiTransport
   |
DHO804
```

Polling and waveform services use the same driver/scheduler path. Nothing writes directly to the scope socket outside the transport/scheduler boundary.

`ScopeService` owns application semantics including controls, acquisition actions, measurements, raw SCPI, deep/live waveform operations and Sleep. `ScopeRuntime` owns physical-session composition/recovery and deliberate Sleep suspension.

Scope Sleep uses the normal application path:

```text
browser
 -> ScopeWebSocketAdapter
 -> ScopeService.sleep()
 -> ScopePowerLifecycle
 -> ScopeRuntime / Dho804PowerControl
```

HTTP is not a second scope control plane.

## DM858E server path

```text
WebSocketGateway
   |
DmmWebSocketAdapter
   |
DmmService
   |
DmmRuntime
   |
Dm858eDriver
   |
ScpiScheduler
   |
ScpiTransport
   |
DM858E
```

The physical DM858E remains authoritative. `DmmService` owns mutation serialization, authoritative post-mutation readback, stale function-dependent request rejection, and display-snapshot invalidation/deduplication/replay. `DmmRuntime` owns physical-session composition/recovery.

Do not route DM858E commands through scope services or place DMM state into scope state.

## Raw SCPI

Raw SCPI is explicitly instrument-targeted end to end:

```text
ScpiExecute(instrument, command)
```

The WebSocket broker does not choose a default instrument. The matching adapter routes through that instrument's normal service/scheduler path. Nothing bypasses transaction serialization.

## DHO804 state

The physical oscilloscope is authoritative.

The server maintains complete cached `ScopeState` snapshots. Browser interactions may update presentation optimistically, while authoritative readback reconciles state. Important scope state is validated periodically to detect front-panel changes and drift.

See `scope-model.md`.

## DM858E state and snapshots

DM858E types are separate from scope types. Shared DMM state covers measurement function, range and acquisition rate.

Primary reading snapshots are latest display state, not a unique physical sample stream. They carry no sequence/sample identity and must not be promoted into sample statistics or logging without verified sample semantics.

## DHO804 waveform acquisition

Live display and deep acquisition remain distinct.

### Live display

While running:

- use the DHO NORMAL/screen path;
- keep waveform reads small;
- publish normalized binary frames to subscribed browser sessions;
- stale live frames may be discarded/replaced.

### Deep acquisition

When stopped or after a single acquisition:

- use RAW acquisition;
- retain the full capture server-side;
- downsample requested viewports on the server using min/max bucketing;
- overscan viewport responses;
- do not reread the instrument for pan/zoom of a retained capture.

See `waveforms.md` and `waveform-protocol.md`.

## Waveform representation and backpressure

Native DHO804 waveform codes and IEEE/TMC representation stop at the driver boundary. Browser frames carry normalized amplitude data.

Waveform delivery is scope-specific and owned by `ScopeWebSocketAdapter`:

- latest completed live frame per channel replaces stale pending live frames;
- JSON control/state/error messages are preserved;
- deep viewport responses are validated against request capture/channel;
- superseded viewport requests fail clearly;
- unbounded waveform queues are not allowed.

The common WebSocket broker only exposes socket delivery and common buffered-byte state.

Waveform samples remain outside React/Zustand.

## Browser transport state

WebSocket transport state is an application concern separate from physical instrument lifecycle. Both instrument UIs must invalidate stale connected presentation when browser/server transport is lost.

The browser-side ownership cleanup for this concern is Stream E of the active architecture refactor.

## Failure philosophy

Prefer simple visible failure over elaborate recovery.

If SCPI socket/framing integrity is lost:

- fail affected work clearly;
- discard stale queued work;
- close the uncertain session;
- create a fresh session only while the runtime remains active under the current lifetime policy;
- never replay stale commands after reconnect.

Do not add persistent command queues, circuit breakers or per-command retry machinery without measured need.

## Architecture documents

- `architecture.md` — overall decisions
- `server-architecture.md` — server ownership and boundaries
- `frontend.md` — browser routing/state/data flow
- `scope-model.md` — DHO804 domain model and SCPI mapping
- `scpi-scheduler.md` — scheduler semantics
- `waveforms.md` — DHO804 live/deep waveform ownership
- `websocket-protocol.md` — JSON browser/server protocol
- `waveform-protocol.md` — DHO804 binary waveform layout
- `testing.md` — fake layers, integration tests and hardware benchmarks
- `workstreams/architecture-refactor.md` — active architecture-refactor sequence

## References

Primary device specifications:

- Rigol DHO800/DHO900 Programming Guide
- Rigol DHO800 User Guide
- Rigol DM858 Series Programming Guide
