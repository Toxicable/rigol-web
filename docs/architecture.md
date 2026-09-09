# Rigol Web Architecture

## Purpose

Rigol Web is a local TypeScript bench application for the Rigol DHO804 oscilloscope and Rigol DM858E digital multimeter, with an explicit server-owned acquisition-operation boundary for long-running streaming sources such as PPK2.

It is deliberately concrete. Shared transport/lifecycle code does not make Rigol Web a generic instrument framework.

## System shape

```text
Browser
  |
  | one persistent WebSocket per tab
  v
WebSocketGateway
  | session / handshake / subscriptions / common framing
  +-------------------------+------------------------+
  |                         |                        |
  v                         v                        v
AcquisitionWebSocketAdapter ScopeWebSocketAdapter    DmmWebSocketAdapter
  |                         |                        |
  v                         v                        v
AcquisitionService          ScopeService             DmmService
                            |                        |
                            v                        v
                            ScopeRuntime             DmmRuntime
                            |                        |
                            Dho804Driver             Dm858eDriver
                            |                        |
                            ScpiScheduler            ScpiScheduler
                            |                        |
                            ScpiTransport            ScpiTransport
```

The browser shares one app transport but keeps instrument domains separate:

```text
                    AppConnection
                   /             \
                  v               v
            ScopeBinding      DmmBinding
                 ^               ^
                 |               |
            ScopeActions      DmmActions
                 |               |
                 v               v
             scope UI          DMM UI
```

Acquisition-operation requests use `AppConnection` request/correlation directly until a concrete producer such as PPK2 adds its own browser binding/actions.

## Fixed configuration and routes

Server configuration names the two current SCPI endpoints explicitly:

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

At server startup both configured runtimes are started once. Browser route subscription changes publication fanout only; navigation, last unsubscribe, browser close and browser reconnect do not stop physical runtimes. Server shutdown explicitly stops both runtimes.

`InstrumentRegistry` owns those two fixed runtime lifetimes. It is not a browser-subscriber registry, plugin manager or DI container.

## Server-owned acquisition operations

`AcquisitionService` owns long-running acquisition/recording operation metadata and lifecycle independently of browser routes and physical-instrument publication subscriptions.

An operation has a positive ID, label, initiator metadata, start timestamp, `Running`/`Stopped`/`Failed` state, explicit stop/failure and monotonic progress including received-item and source-loss counts.

Browser initiator metadata records who requested the operation; it is not a lifetime lease. A browser disconnect does not stop the operation. Server shutdown stops remaining running operations.

`BoundedAcquisitionChunkStore<T>` provides an explicit byte-bounded retention primitive for concrete streaming producers. The payload remains source-specific. The store tracks producer/source loss separately from retention eviction, supports sequence-range reads and exposes an export boundary.

No default retention budget is guessed in Stream G. A concrete source such as PPK2 must choose its byte budget based on the required retained duration and memory cost.

Existing data semantics remain unchanged:

- DHO804 live frames remain disposable latest-oriented display data;
- DHO804 deep captures retain their concrete representation;
- DM858E latest snapshots remain display snapshots and are not unique physical samples/logging data.

See `acquisition-operations.md`.

## Server WebSocket boundary

`WebSocketGateway` owns common browser transport/session concerns only:

- accept/close WebSockets;
- protocol hello/version handshake;
- browser session identity;
- instrument publication subscriptions;
- common JSON/binary send primitives;
- request failure/completion framing;
- common socket buffered-byte state.

Application-level acquisition requests are handled by the fixed `AcquisitionWebSocketAdapter` before the two instrument adapters. It does not participate in instrument publication subscription/backpressure lifecycle.

`ScopeWebSocketAdapter` owns DHO804 request validation/dispatch, lifecycle/state projection, measurements, raw SCPI mapping, deep-capture wire mapping, waveform delivery/backpressure semantics and browser-session ownership of long-lived scope interactions.

`DmmWebSocketAdapter` owns DM858E request validation/dispatch, lifecycle/state/snapshot projection, raw SCPI mapping and current-snapshot replay for newly subscribing sessions.

These are explicit fixed composition boundaries, not a plugin registry.

## Browser transport boundary

`AppConnection` is the sole owner of application-wide browser transport concerns:

- WebSocket connect/reconnect;
- protocol handshake/version validation;
- request ID allocation and response correlation;
- desired instrument publication subscriptions and replay after reconnect;
- JSON/binary transport fanout;
- transport error/disconnect propagation.

`src/web/app-transport-store.ts` is the single Zustand owner of browser transport state. Scope and DMM stores do not duplicate WebSocket lifecycle state.

`ScopeBinding` and `DmmBinding` own instrument-specific wire mapping and publication projection. Route mount/unmount activates/deactivates publication subscriptions without recreating `AppConnection`.

The old scope-shaped global WebSocket client was removed as a hard cut.

## Browser domain actions

Ordinary React controls do not construct WebSocket requests or coordinate request failures directly.

`ScopeActions` owns concrete scope command orchestration, optimistic presentation, coalesced interaction updates/final commit, command errors, Sleep pending state and measurement polling.

`DmmActions` owns function/range/rate commands, function-dependent control construction, redundant-write suppression and generation-safe pending/error ownership.

Action APIs remain instrument-specific. There is no generic browser command dispatcher or mixed instrument store.

The raw SCPI console remains an intentional diagnostic exception and targets an explicit instrument through `AppConnection.executeScpi(...)`.

## Browser protocol handshake

Each tab connects to `/ws` and completes:

```text
server -> ProtocolHello(PROTOCOL_VERSION)
browser -> ProtocolHelloAck(PROTOCOL_VERSION)
```

Application traffic is rejected before a matching acknowledgement. `Connected` browser transport state means the handshake completed, not merely that a socket opened.

Protocol version **7** is current. Stream G adds the acquisition-operation start/stop/get/list request/result wire contract and therefore deliberately bumps the hard-cut protocol from version 6.

On unexpected close, pending browser requests fail and the browser reconnects. Desired instrument route subscriptions are replayed only after the new handshake succeeds. A disposed `AppConnection` cancels pending reconnect.

## DHO804 application path

```text
React scope control
 -> ScopeActions
 -> ScopeBinding
 -> AppConnection
 -> ScopeWebSocketAdapter
 -> ScopeService
 -> ScopeController / waveform services
 -> Dho804Driver
 -> ScpiScheduler
 -> ScpiTransport
```

`ScopeService` owns server application semantics for controls, acquisition actions, measurements, raw SCPI, deep/live waveform operations and Sleep. `ScopeRuntime` owns physical-session composition/recovery and deliberate Sleep suspension.

The physical DHO804 remains authoritative for scope state. Browser optimistic state is replaced by authoritative server state/readback.

## DM858E application path

```text
React DMM control
 -> DmmActions
 -> DmmBinding
 -> AppConnection
 -> DmmWebSocketAdapter
 -> DmmService
 -> DmmRuntime
 -> Dm858eDriver
 -> ScpiScheduler
 -> ScpiTransport
```

`DmmService` owns mutation serialization, authoritative post-mutation readback, stale function-dependent request rejection and latest-display snapshot invalidation/deduplication. `DmmRuntime` owns physical-session composition/recovery.

DM858E display snapshots are latest display state, not identified physical samples. They must not be promoted into statistics/logging streams without verified sample identity semantics.

## Multi-browser semantics

Atomic instrument controls are global; the last accepted physical write wins.

Long-lived scope interaction is explicitly browser-session-owned in `ScopeWebSocketAdapter`. Publication subscription itself is never a physical-runtime lease.

Acquisition operations use a different lifetime rule: initiator session metadata does not imply session ownership, so disconnecting the initiating browser does not stop a running operation. Explicit stop/failure/server shutdown ends it.

## DHO804 waveform ownership

Live and deep acquisition remain distinct.

Live waveform data is disposable and latest-oriented. Scope-specific server backpressure may replace stale pending live frames. Browser waveform bytes pass through `AppConnection` unchanged, then `ScopeBinding` decodes them and hands them to `WaveformController`; waveform arrays do not enter React/Zustand or generic transport semantics.

Deep acquisition retains full source data server-side and serves display-sized viewport reductions.

Neither path is forced into `BoundedAcquisitionChunkStore<T>` merely to satisfy the new acquisition abstraction.

## Failure policy

Prefer visible deterministic failure over elaborate recovery.

For uncertain SCPI framing/socket integrity, fail affected work, reject stale queued work, close the uncertain physical session, reconnect through the server-owned runtime and never replay stale physical commands.

For loss-sensitive streaming sources, report sequence/source loss explicitly. Do not silently apply DHO live latest-frame-wins semantics to raw acquisition data.

Do not add persistent command queues, runtime policy flags, a generic event bus or a generic instrument framework without a concrete requirement.

## Refactor boundary after Stream G

Streams A-G have established:

- explicit server application services;
- scope power ownership inside the scope service/runtime;
- WebSocket broker + explicit adapters;
- server-owned physical runtime lifetime;
- app-wide browser transport + scope/DMM bindings;
- instrument-specific browser domain actions;
- server-owned acquisition operation lifecycle, sequence/loss progress and bounded source-storage contract.

Stream H is next: implement PPK2 as the first non-SCPI loss-sensitive streaming producer using this acquisition boundary.

## References

- `server-architecture.md` — server ownership and lifecycle
- `frontend.md` — browser transport/binding/action/store ownership
- `acquisition-operations.md` — long-running acquisition lifecycle/storage contract
- `scope-model.md` — DHO804 domain model and SCPI mapping
- `scpi-scheduler.md` — serialized SCPI scheduling
- `waveforms.md` — DHO804 live/deep acquisition
- `websocket-protocol.md` — JSON browser/server protocol
- `waveform-protocol.md` — DHO804 binary waveform format
- `testing.md` — test strategy
- `workstreams/architecture-refactor.md` — architecture refactor sequence
