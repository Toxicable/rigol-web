# Rigol Web Architecture

## Purpose

Rigol Web is a local TypeScript bench application for three fixed instruments:

- Rigol DHO804 oscilloscope;
- Rigol DM858E digital multimeter;
- Nordic PPK2 through the Toxicboards ESP32-S3 PPK2Bridge.

It is deliberately concrete. Shared transport/lifecycle code does not make Rigol Web a generic instrument framework.

## System shape

```text
Browser
  |
  | one persistent WebSocket per tab
  v
AppConnection
  |
  +-- ScopeBinding -> ScopeActions -> DHO804 UI
  +-- DmmBinding   -> DmmActions   -> DM858E UI
  `-- Ppk2Binding  -> Ppk2Actions  -> PPK2 UI

WebSocketGateway
  | session / handshake / subscriptions / common framing
  +-- AcquisitionWebSocketAdapter -> AcquisitionService
  +-- ScopeWebSocketAdapter       -> ScopeService -> ScopeRuntime -> Dho804Driver -> SCPI
  +-- DmmWebSocketAdapter         -> DmmService   -> DmmRuntime   -> Dm858eDriver -> SCPI
  `-- Ppk2WebSocketAdapter        -> Ppk2Service  -> Ppk2Runtime  -> TBP2 TCP stream
                                        |
                                        +-> bounded acquisition store
                                        +-> statistics / charge
                                        `-> decimated live/history
```

The PPK2 path is intentionally non-SCPI. It does not use `ScpiScheduler`.

## Fixed configuration and routes

Required server endpoints are explicit:

```text
RIGOL_SCOPE_HOST
RIGOL_SCOPE_PORT
RIGOL_DMM_HOST
RIGOL_DMM_PORT
PPK2_BRIDGE_HOST
PPK2_BRIDGE_PORT
```

The selected PPK2Bridge TCP port is `5557`.

Fixed routes:

- `/` — DHO804
- `/dm858e` — DM858E
- `/ppk2` — PPK2

No browser-side arbitrary host/model selection is planned.

## Physical instrument lifetime

Physical runtime lifetime is server-owned.

At server startup `InstrumentRegistry` starts exactly three configured runtimes:

- DHO804 scope runtime;
- DM858E DMM runtime;
- PPK2 bridge runtime.

Browser route subscriptions control publication fanout only. Navigation, last unsubscribe, browser close and browser reconnect do not stop physical runtimes. Server shutdown explicitly stops them.

`InstrumentRegistry` is not a browser-subscriber registry, plugin manager or DI container.

## Server-owned acquisition operations

`AcquisitionService` owns long-running acquisition/recording operation metadata and lifecycle independently of browser routes and physical-instrument publication subscriptions.

An operation has a positive ID, label, initiator metadata, start timestamp, `Running`/`Stopped`/`Failed` state, explicit stop/failure and monotonic progress including received-item and source-loss counts.

Browser initiator metadata records who requested an operation; it is not a lifetime lease. Browser disconnect does not stop the operation.

`BoundedAcquisitionChunkStore<T>` provides explicit byte-bounded retention for concrete streaming producers while keeping payload types source-specific. Producer/source loss is tracked separately from retention eviction.

Existing scope/DMM semantics remain unchanged:

- DHO804 live frames are disposable display data;
- DHO804 deep captures keep their concrete retained representation;
- DM858E latest snapshots are display snapshots, not identified physical samples.

## PPK2 acquisition path

```text
PPK2 CDC bytes
 -> PPK2Bridge TBP2 TCP
 -> Ppk2Runtime
 -> Ppk2StreamDecoder / calibration
 -> Ppk2Service
 -> AcquisitionService + bounded chunk store
 -> statistics / charge / decimation
 -> Ppk2WebSocketAdapter
```

The bridge payload stays the original PPK2 CDC byte stream. TBP2 framing adds source-session identity and monotonic byte offsets so bridge/network loss can be detected across buffering and reconnects.

Metadata loss, source-session changes, malformed framing and uncertain four-byte measurement alignment fail the session/capture rather than being guessed around.

The native PPK2 6-bit sample counter provides an additional source-loss signal when bridge byte offsets remain continuous.

### PPK2 retention

`Ppk2Service` uses a fixed 64 MiB payload budget. Each retained sample uses 8 payload bytes: calibrated current as `Float32` and the original packed sample word as `Uint32`.

At 100 kSa/s this is about 800 kB/s of retained payload, so the byte budget corresponds to roughly 83.9 seconds before chunk/object overhead.

Retention eviction is not source loss.

### PPK2 browser publication

Raw samples are server-only.

The server reduces each 100 raw samples to a 1 ms display bucket carrying min/max/mean current, sample/sequence range, and logic OR/AND. Twenty buckets are normally published together, about every 20 ms.

A slow browser may drop these decimated live-display updates when its WebSocket is backpressured. This affects presentation only; raw acquisition/storage/loss accounting continues server-side.

The browser retains at most 5,000 live buckets (~5 seconds) and explicitly requests decimated retained-history viewports when needed.

See `ppk2.md`.

## Server WebSocket boundary

`WebSocketGateway` owns common browser transport/session concerns only:

- accept/close WebSockets;
- protocol hello/version handshake;
- browser session identity;
- instrument publication subscriptions;
- JSON/binary send primitives;
- request failure/completion framing;
- common socket buffered-byte state.

The fixed adapters own concrete application mapping:

- `AcquisitionWebSocketAdapter` — application-level acquisition operation metadata/lifecycle requests;
- `ScopeWebSocketAdapter` — DHO804 state, controls, measurements, raw SCPI and waveforms;
- `DmmWebSocketAdapter` — DM858E state, controls, raw SCPI and snapshots;
- `Ppk2WebSocketAdapter` — PPK2 lifecycle/stats/live summaries, capture start/stop and retained viewports.

These are explicit composition boundaries, not a plugin registry.

## Browser transport boundary

`AppConnection` is the sole owner of application-wide browser transport concerns:

- WebSocket connect/reconnect;
- protocol handshake/version validation;
- request ID allocation and response correlation;
- desired instrument publication subscriptions and replay after reconnect;
- JSON/binary transport fanout;
- transport error/disconnect propagation.

`src/web/app-transport-store.ts` is the single Zustand owner of browser transport state.

`ScopeBinding`, `DmmBinding`, and `Ppk2Binding` own instrument-specific wire mapping and publication projection. Route mount/unmount activates/deactivates publication subscriptions without recreating `AppConnection`.

## Browser domain actions

Ordinary React controls do not construct WebSocket requests or coordinate transport failures directly.

- `ScopeActions` owns scope commands, optimistic interactions, Sleep state and measurement polling.
- `DmmActions` owns DMM controls and generation-safe pending/error state.
- `Ppk2Actions` owns capture start/stop/history intent and PPK2 pending/error state.

Action APIs remain instrument-specific. There is no generic browser command dispatcher or mixed instrument store.

PPK2 raw arrays never enter React or Zustand. The PPK2 store contains only lifecycle/state summaries, acquisition stats, decimated live buckets and one requested viewport.

## Browser protocol handshake

Each tab connects to `/ws` and completes:

```text
server -> ProtocolHello(PROTOCOL_VERSION)
browser -> ProtocolHelloAck(PROTOCOL_VERSION)
```

Application traffic is rejected before a matching acknowledgement. `Connected` browser transport state means the handshake completed, not merely that a socket opened.

Protocol version **10** is current. Version 10 is a hard cut adding explicit PPK2 instrument identity/lifecycle/stats/live/capture/viewport messages. Existing numeric message values remain unchanged.

On unexpected close, pending browser requests fail and the browser reconnects. Desired instrument subscriptions are replayed only after the new handshake succeeds.

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

DM858E display snapshots are latest display state, not identified physical samples. They are not promoted into statistics/logging streams.

## PPK2 application path

```text
React PPK2 control
 -> Ppk2Actions
 -> Ppk2Binding
 -> AppConnection
 -> Ppk2WebSocketAdapter
 -> Ppk2Service
 -> Ppk2Runtime
 -> PPK2Bridge TCP
```

A PPK2 capture is a server-owned acquisition operation. Leaving `/ppk2`, unsubscribing or closing the initiating browser does not stop it. Explicit Stop, physical/source failure or server shutdown ends it.

## Multi-browser semantics

Atomic scope/DMM controls are global; the last accepted physical write wins.

Long-lived scope interaction is browser-session-owned in `ScopeWebSocketAdapter`.

PPK2 acquisition operations use the server-owned lifetime rule. Initiator session metadata does not imply session ownership.

## Failure policy

Prefer visible deterministic failure over elaborate recovery.

For uncertain SCPI framing/socket integrity, fail affected work, reject stale queued work, close the uncertain physical session and reconnect through the server-owned runtime.

For PPK2, preserve/report sequence/source loss. Do not silently resynchronize an uncertain sample boundary and do not apply raw latest-frame-wins semantics.

Decimated browser display summaries may be omitted under browser backpressure because they are not the acquisition source data.

Do not add persistent command queues, runtime policy flags, a generic event bus or a generic instrument framework without a concrete requirement.

## Refactor completion

Streams A-H establish the intended architecture:

- explicit scope/DMM/PPK2 application paths;
- WebSocket broker plus fixed adapters;
- server-owned physical runtime lifetime;
- app-wide browser transport plus instrument-specific bindings/actions;
- explicit server-owned acquisition operation lifecycle;
- byte-bounded source-specific storage;
- PPK2 loss accounting, calibration, statistics, charge, retention and display decimation.

The architecture refactor workstream is therefore implementation-complete once Stream H lands. Executable typecheck/test/build validation remains a separate release gate.

## References

- `server-architecture.md` — server ownership/lifecycle
- `frontend.md` — browser transport/binding/action/store ownership
- `acquisition-operations.md` — long-running acquisition lifecycle/storage contract
- `ppk2.md` — PPK2 transport/decoder/storage/UI contract
- `scope-model.md` — DHO804 domain model and SCPI mapping
- `scpi-scheduler.md` — serialized SCPI scheduling
- `waveforms.md` — DHO804 live/deep acquisition
- `websocket-protocol.md` — JSON browser/server protocol
- `waveform-protocol.md` — DHO804 binary waveform format
- `testing.md` — test strategy
- `workstreams/architecture-refactor.md` — architecture refactor sequence
