# Rigol Web Architecture

## Purpose

Rigol Web is a local TypeScript bench application for two fixed instruments:

- Rigol DHO804 oscilloscope
- Rigol DM858E digital multimeter

It is deliberately concrete. Supporting multiple known instruments does not make Rigol Web a generic instrument framework.

## System shape

```text
Browser
  |
  | one persistent WebSocket per tab
  v
WebSocketGateway
  |  session / handshake / subscriptions / common framing
  +------------------------+
  |                        |
  v                        v
ScopeWebSocketAdapter      DmmWebSocketAdapter
  |                        |
  v                        v
ScopeService               DmmService
  |                        |
  v                        v
ScopeRuntime               DmmRuntime
  |                        |
Dho804Driver               Dm858eDriver
  |                        |
ScpiScheduler              ScpiScheduler
  |                        |
ScpiTransport              ScpiTransport
  |                        |
DHO804                     DM858E
```

The browser side mirrors that separation:

```text
AppConnection
  +-> ScopeBinding -> scope store + waveform controller
  `-> DmmBinding   -> DMM store
```

## Fixed configuration and routes

Server configuration names the two endpoints explicitly:

```text
RIGOL_SCOPE_HOST
RIGOL_SCOPE_PORT
RIGOL_DMM_HOST
RIGOL_DMM_PORT
```

Fixed routes:

- `/` — DHO804
- `/dm858e` — DM858E

No browser-side arbitrary host/model selection is planned.

## Physical instrument lifetime

Physical runtime lifetime is server-owned.

At server startup both configured runtimes are started once. Each maintains its own SCPI connection/recovery loop. Browser route subscription changes publication fanout only; navigation, the last unsubscribe, browser close, and browser reconnect do not stop physical runtimes. Server shutdown explicitly stops both runtimes.

`InstrumentRegistry` owns those two fixed runtime lifetimes. It is not a browser-subscriber registry, plugin manager, or DI container.

## Server WebSocket boundary

`WebSocketGateway` owns common browser transport/session concerns only:

- accept/close WebSockets;
- protocol hello/version handshake;
- browser session identity;
- desired publication subscriptions;
- common JSON/binary send primitives;
- request failure/completion framing;
- common socket buffered-byte state.

Instrument semantics live in explicit adapters.

`ScopeWebSocketAdapter` owns DHO804 request validation/dispatch, lifecycle/state projection, measurements, raw SCPI mapping, deep-capture wire mapping, waveform delivery/backpressure semantics, and browser-session ownership of long-lived scope interactions.

`DmmWebSocketAdapter` owns DM858E request validation/dispatch, lifecycle/state/snapshot projection, raw SCPI mapping, and current-snapshot replay for newly subscribing sessions.

The tiny adapter boundary exists only for these known transports. It is not a generic instrument plugin API.

## Browser transport boundary

`AppConnection` is the sole owner of application-wide browser transport concerns:

- WebSocket connect/reconnect;
- protocol handshake/version validation;
- request ID allocation and response correlation;
- desired publication subscriptions and replay after reconnect;
- JSON/binary transport fanout;
- transport error/disconnect propagation.

`src/web/app-transport-store.ts` is the single Zustand owner of browser transport state: Connecting, Connected, or Disconnected. Scope and DMM stores do not duplicate WebSocket lifecycle state.

`ScopeBinding` and `DmmBinding` own instrument-specific browser protocol mapping. Route mount/unmount activates/deactivates publication subscriptions through those bindings without recreating `AppConnection`.

The old scope-shaped global WebSocket client has been removed. There is no compatibility alias.

## Browser protocol handshake

Each tab connects to `/ws` and completes:

```text
server -> ProtocolHello(PROTOCOL_VERSION)
browser -> ProtocolHelloAck(PROTOCOL_VERSION)
```

Application traffic is rejected before a matching acknowledgement. `Connected` browser transport state means this handshake completed, not merely that a socket opened.

Protocol version 6 remains current. The architecture refactor through Stream E changes ownership only and does not require a wire-protocol version change.

On an unexpected close, pending requests fail and the browser reconnects. Desired route subscriptions are replayed only after the new handshake succeeds. A disposed `AppConnection` cancels any pending reconnect so application teardown cannot recreate the transport.

## DHO804 application path

```text
ScopeWebSocketAdapter
 -> ScopeService
 -> ScopeController / waveform services
 -> Dho804Driver
 -> ScpiScheduler
 -> ScpiTransport
```

`ScopeService` owns application semantics: controls, acquisition actions, measurements, raw SCPI, deep/live waveform operations, and Sleep. `ScopeRuntime` owns physical-session composition/recovery and deliberate Sleep suspension.

Scope Sleep uses the normal application path rather than HTTP:

```text
browser -> ScopeWebSocketAdapter -> ScopeService.sleep()
        -> ScopePowerLifecycle -> ScopeRuntime / Dho804PowerControl
```

The physical DHO804 remains authoritative for scope state. Browser interactions may be optimistic, but complete authoritative state/readback reconciles presentation.

## DM858E application path

```text
DmmWebSocketAdapter
 -> DmmService
 -> DmmRuntime
 -> Dm858eDriver
 -> ScpiScheduler
 -> ScpiTransport
```

`DmmService` owns mutation serialization, authoritative post-mutation readback, stale function-dependent request rejection, and latest-display snapshot invalidation/deduplication. `DmmRuntime` owns physical-session composition/recovery.

DM858E display snapshots are latest display state, not identified physical samples. They must not be promoted into statistics/logging streams without verified sample identity semantics.

Scope and DMM domain stores remain separate.

## Multi-browser controls

Atomic controls are global; the last accepted physical write wins.

Long-lived scope interaction is explicitly browser-session-owned in `ScopeWebSocketAdapter`. The first interactive update acquires the interaction lease and pauses live waveform delivery. Only that session may continue/commit it. Commit, unsubscribe, socket close, or physical scope disconnect releases ownership and resumes live delivery as applicable.

Publication subscription itself is never a physical-runtime lease.

## Raw SCPI

Raw SCPI is explicitly instrument-targeted:

```text
ScpiExecute(instrument, command)
```

Browser `AppConnection` owns correlation only. The server broker routes to the selected adapter/service. No code bypasses the selected instrument's normal scheduler/transport path.

## DHO804 waveform ownership

Live and deep acquisition remain distinct.

Live waveform data is disposable and latest-oriented. Scope-specific server backpressure may replace stale pending live frames. Browser waveform bytes pass through `AppConnection` unchanged, then `ScopeBinding` decodes them and hands them to `WaveformController`; waveform arrays never enter React/Zustand or generic transport semantics.

Deep acquisition retains full source data server-side. Browser requests display-sized min/max-reduced viewport windows and may pan/zoom the retained capture without rereading the instrument.

## Failure policy

Prefer visible deterministic failure over elaborate recovery.

If SCPI framing/socket integrity is lost:

- fail affected work clearly;
- reject stale queued work;
- close the uncertain physical session;
- reconnect through the already-active server-owned runtime;
- never replay stale physical commands.

Do not add persistent command queues, per-command retry systems, runtime policy flags, a generic event bus, or a generic instrument framework without a concrete requirement.

## Refactor boundary after Stream E

Streams A-E have established:

- explicit server application services;
- scope power ownership inside the scope service/runtime;
- WebSocket broker + instrument adapters;
- server-owned physical runtime lifetime;
- app-wide browser transport + explicit scope/DMM bindings.

Stream F is the next architectural work: move view-side optimistic command/error orchestration behind scope/DMM domain action layers. Acquisition-operation modeling and PPK2 remain later Streams G/H.

## References

- `server-architecture.md` — server ownership and lifecycle
- `frontend.md` — browser transport/binding/store ownership
- `scope-model.md` — DHO804 domain model and SCPI mapping
- `scpi-scheduler.md` — serialized SCPI scheduling
- `waveforms.md` — DHO804 live/deep acquisition
- `websocket-protocol.md` — JSON browser/server protocol
- `waveform-protocol.md` — DHO804 binary waveform format
- `testing.md` — test strategy
- `workstreams/architecture-refactor.md` — architecture refactor sequence
