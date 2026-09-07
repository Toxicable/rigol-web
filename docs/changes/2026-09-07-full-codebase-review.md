# RigolWeb full codebase review

Date: 2026-09-07

Reviewed `main` at `eccd3c5a98a5fb193ba745fcb60cab1e67a8e390`.

This is an architecture/correctness/product-gap review of the current source tree. It is not a claim that every item below has been reproduced on physical hardware. Findings that are mechanically provable from source are called out as such.

## Executive summary

RigolWeb does **not** need a rewrite. The strongest parts are the SCPI transport/scheduler split, subscription-owned instrument runtimes, authoritative state/readback model, DHO waveform binary path, stale-live-frame replacement under browser backpressure, and the general preference for explicit fixed device behavior over speculative abstraction.

The weak area is the application/protocol boundary. The project grew from a scope UI into a two-instrument application, but several scope-era ownership decisions remain: `ScopeWebSocketClient` is now an app-wide client, `WebSocketGateway` owns too many unrelated responsibilities, server runtimes import WebSocket-layer types, and browser transport state is represented differently for scope and DMM. That debt should be removed before PPK2 is added.

There are also several concrete correctness/operational issues that should be fixed first: the checked-in protocol test is stale and fails deterministically, SCPI scheduler metrics grow without bound, interactive scope waveform pause has no per-client ownership/cleanup, browser request promises have no timeout, and the direct HTTP/WebSocket control surfaces have no application-level trust-boundary enforcement.

Incremental software/package cost for the recommendations in this review is **A$0**. No new paid dependency is required.

## What is good and should be kept

- `ScpiTransport` owns stream framing and `ScpiScheduler` owns serialized prioritised work. Do not collapse these layers.
- The scheduler's coalescing/latest-value semantics are appropriate for interactive bench controls.
- DHO and DMM use independent runtime/transport/scheduler sessions.
- `InstrumentRegistry` gives subscription-owned lifecycle and avoids permanently polling unused instruments.
- Scope state is authoritative and complete; optimistic interaction is reconciled by device readback.
- DMM function-bound range/rate controls carry function context, which prevents stale UI writes from being silently reinterpreted after a front-panel or multi-tab function change.
- Binary waveform payloads bypass Zustand and stale live frames are replaceable per channel under backpressure.
- Deep captures remain server-side and the browser requests viewport reductions rather than forcing full captures through the UI.
- The codebase has strong TypeScript compiler settings and substantial focused unit/integration coverage.
- The runtime container runs as the unprivileged `node` user and has an explicit healthcheck.

## Findings by priority

### P0 — checked-in test suite is currently inconsistent with production protocol

`src/shared/websocket-protocol.ts` defines `PROTOCOL_VERSION = 5`, while `src/shared/websocket-protocol.test.ts` still asserts that it is `4`.

This is deterministic from source: ordinary `pnpm test` cannot be green until the assertion is updated or the production version is intentionally reverted. The source protocol change should remain the authority if version 5 is intentional.

There is also no `.github` workflow in the repository and `main` has no required status checks. The documented `pnpm typecheck`, `pnpm test`, `pnpm build` verification sequence therefore has no automatic gate.

**Action:** fix the stale assertion immediately, then add a minimal CI workflow for typecheck/test/build. Keep it hardware-free as `docs/testing.md` already specifies.

### P1 — `ScpiScheduler` metrics are an unbounded memory leak for long-running sessions

`ScpiScheduler` stores every completed operation in `private readonly metrics: ScpiOperationMetric[] = []` and pushes one record after every operation. There is no cap, aggregation or clear operation.

A connected scope can execute live waveform reads continuously plus state/measurement work. A DMM polls at roughly 10 Hz for readings plus state validation. A stable long-running session therefore grows the metrics array for as long as that scheduler exists.

This is especially important before PPK2 because its planned stream is much higher rate and long-lived instrumentation should not have unbounded diagnostic state.

**Action:** replace the array with either bounded ring storage for recent samples plus aggregate counters/histograms, or make detailed recording opt-in to an explicit benchmark session. Do not retain all production operations forever.

### P1 — scope live-waveform pause has no client ownership or disconnect cleanup

For `InteractionUpdate`, `WebSocketGateway` calls `pauseLiveWaveform()` and intentionally leaves live waveform acquisition paused until a later `InteractionCommit` calls `resumeLiveWaveform()`.

`LiveWaveformService` implements this as one global boolean `paused`.

Consequences:

- if a browser disconnects or navigates away after an interaction update but before commit, no code associated with client release resumes the service;
- with two browser clients, one client's commit can resume a pause still logically needed by the other client;
- one client interacting globally pauses live waveform delivery for every subscriber.

**Action:** make pause ownership explicit. A per-client interaction lease/ref-count is enough; release all leases when a session unsubscribes/closes. Alternatively remove long-lived pausing and rely on scheduler priority if real-scope testing proves that works reliably.

### P1 — browser request promises have no deadline

`ScopeWebSocketClient.sendRequest()` inserts a promise into `pending` and removes it only when a matching response arrives, send throws, the socket closes, or the client is disposed. There is no request timeout.

If the WebSocket stays open while a server-side operation wedges, the promise remains pending indefinitely. `measurementInFlight` can then stay true forever, permanently stopping scope measurement polling for that browser session.

**Action:** give request/command operations explicit deadlines appropriate to the operation type. Timeout should remove the pending entry and surface a visible error. A deep capture may need a longer timeout than an ordinary control/read.

### P1 — control-plane trust boundary is implicit rather than enforced

The Node server exposes a state-changing unauthenticated `POST /api/scope/sleep`. `WebSocketGateway` creates the WebSocket server with path/compression options but no origin/authentication gate, and raw SCPI is available to subscribed sessions.

`docker-compose.yml` publishes `3018:3000`, which by default binds on all host interfaces. An upstream authenticated Caddy hostname therefore does not itself prevent direct LAN access to port 3018.

This may be acceptable for a deliberately trusted bench LAN, but it must be explicit because a browser on another origin can attempt WebSocket access and the service can mutate physical instruments.

**Action:** choose and document one trust model. Cheapest robust option when Caddy is the intended entry point is bind Compose to loopback (`127.0.0.1:3018:3000`) and let Caddy own external access. If direct LAN access is required, add same-origin/origin validation plus an application authentication mechanism appropriate to the LAN deployment. Also set a deliberately small client WebSocket `maxPayload` because client messages are JSON controls, not large binary uploads.

### P1 — server architecture is inverted at the runtime/WebSocket boundary

Both `ScopeRuntime` and `DmmRuntime` import connection types from `websocket/websocket-gateway.ts`. `ScopeRuntime` also imports WebSocket protocol message types for deep-capture results.

That makes the instrument runtime/domain layer depend on the delivery layer. It also contributes to the `server.ts` temporal coupling where runtimes are constructed with callbacks that reference `let gateway!` before the gateway is assigned.

`WebSocketGateway` is about 37 KB and currently owns:

- wire validation/parsing;
- protocol handshake;
- client lifecycle;
- instrument subscriptions;
- scope command dispatch;
- DMM command dispatch;
- lifecycle projection;
- scope state subscription;
- raw SCPI routing;
- deep-view request generation tracking;
- binary waveform validation;
- live waveform backpressure.

That is the main architectural concentration point in the backend.

**Action:** move app/domain lifecycle types out of the gateway. Runtimes should publish domain events/results. The WebSocket layer should translate them into wire messages. Split gateway code into protocol decoding, client/session/subscription handling, and instrument-specific message adapters. Do not build a plugin framework; keep the supported instruments explicit.

### P1 — current architecture statement conflicts with the committed PPK2 roadmap

`docs/architecture.md` says RigolWeb is intentionally a personal UI for exactly two fixed Rigol instruments and not a generic instrument framework. `SupportedInstrument` likewise contains only DHO804 and DM858E.

The Toxicboards `PPK2Wireless` project now explicitly says RigolWeb will own PPK2 command logic, calibration/metadata, sample decoding, statistics, charge integration, storage/decimation and browser presentation. The bridge is expected to carry roughly 400 kB/s before network overhead.

This does not mean RigolWeb should become generic. It means the architecture needs one additional explicit non-SCPI streaming-instrument path.

**Action:** preserve `InstrumentRegistry` as lifecycle ownership, but make its domain event boundary transport-agnostic. Add PPK2 explicitly as a third instrument/runtime. Do **not** put PPK2 samples through `ScpiScheduler` and do **not** apply DHO live-waveform stale-frame dropping to raw PPK2 acquisition, because the PPK2 project requires detectable sample loss. Ingest/store samples server-side; send decimated/live display data and explicit viewport/history requests to the browser.

### P2 — frontend WebSocket client is still scope-owned in name and behavior

`ScopeWebSocketClient` is created once in `App` and passed to both the scope and DMM routes. It directly mutates `useScopeStore` for scope lifecycle, scope measurement polling and errors, but emits DMM lifecycle through listeners that `dmm-route-binding.ts` converts into DMM-store changes.

The transport therefore has two ownership models in one class. It also depends directly on `WaveformController`, scope run-state behavior, scope measurement polling and the scope Zustand store.

**Action:** split the persistent browser connection into an app-level transport/request broker and thin domain bindings for scope, DMM and later PPK2. Rename the transport away from `ScopeWebSocketClient`. Scope waveform handling can remain a scope adapter rather than becoming generic.

### P2 — browser transport state is duplicated across stores

`ScopeWebSocketClient` has its own `BrowserTransportState` and listener set. `useScopeStore` separately embeds `Connecting` and `TransportDisconnected` inside the scope connection union. `useDmmStore` then has another connection union with its own transport states populated through route binding.

This duplicates app-level transport truth and makes every new instrument repeat connection-state plumbing.

**Action:** keep one app transport state owned by the connection layer. Instrument stores should represent only their own lifecycle (`inactive/connecting/connected/disconnected`) plus domain state.

### P2 — server and browser protocol validation are asymmetric

The server performs explicit runtime validation of every client message field. The browser `asServerMessage()` validates only that the decoded JSON is an object with a numeric known `type`, then casts the entire object to `ServerJsonMessage`.

A malformed/partial server message can therefore enter scope/DMM state handling with unchecked fields.

**Action:** share explicit wire validators or implement corresponding browser-side decoders. Keep the TypeScript interfaces, but do not treat a numeric discriminant as full runtime validation.

### P2 — shutdown cleanup is not failure-isolated

`server.ts` performs `await instruments.stopAll(); await gateway.close(); await closeHttpServer();` inside one `try` block.

If `stopAll()` rejects, WebSocket and HTTP closure are skipped. Likewise a gateway-close error skips HTTP close.

**Action:** attempt every shutdown phase regardless of earlier failures, collect/report errors, then set failure exit status. Shutdown paths should be best-effort cleanup, not fail-fast sequencing.

### P2 — registry stop state compresses an uncertain runtime into `running=false`

During reconciliation, `InstrumentRegistry` sets `entry.running = false` before awaiting `entry.runtime.stop()`. If stop rejects, registry state says stopped even though the runtime may be partially active/uncertain.

The current runtimes are written to make repeated start/stop mostly idempotent, so this is not an immediate rewrite issue, but the state model does not represent stop failure accurately.

**Action:** either make runtime stop contract explicitly "state is considered dead once stop begins" and ensure implementations enforce that, or set `running=false` only after successful stop and add an explicit failed/unknown state for failed teardown.

### P2 — protocol/docs are drifting from current source

Current source protocol is version 5. `docs/websocket-protocol.md` still says protocol version 4 and `docs/architecture.md` still says protocol version 2. The protocol unit test also still asserts 4.

This is exactly the kind of drift that makes the docs less useful as architecture authority.

**Action:** update protocol docs with every hard-cut protocol version bump in the same commit as the source/test. Prefer wording that points to `PROTOCOL_VERSION` when a prose copy of the number is not operationally useful.

### P2 — DHO804 control surface is much narrower than the state model

`ScopeState` reads and exposes substantially more instrument state than `ControlChange` can write.

Current writable scope controls are:

- channel enable/scale/offset;
- horizontal scale/position;
- Edge trigger type/source/slope/level;
- Run/Stop/Single;
- measurement selection;
- raw SCPI.

Important state already modeled but without typed controls includes:

- channel coupling;
- channel unit;
- probe ratio;
- timebase mode;
- acquisition type;
- averages;
- memory depth;
- trigger sweep;
- trigger coupling;
- all non-Edge trigger configuration.

`TriggerType` models many returned trigger types, but `ControlChange` permits only selecting `Edge`.

**Action:** add typed controls in order of bench usefulness rather than attempting full DHO firmware parity. Channel coupling/probe ratio, acquisition type/depth/averages and trigger sweep/coupling are the highest-value obvious gaps.

### P2 — DM858E still has major typed-control gaps

The existing 2026-09-02 DM858E control-surface audit remains valid. Current typed UI covers all 12 primary functions plus range/rate, but not:

- trigger source/count/sample count/external trigger slope and explicit trigger/abort;
- Relative/NULL;
- secondary measurement;
- instrument statistics/limits/dB/dBm;
- temperature probe configuration/unit;
- finite reading-memory acquisition/export.

The existing audit's recommended order is sensible: trigger/acquisition, Relative, secondary measurement, instrument math, temperature configuration, then finite memory/export.

Cost impact remains **A$0**.

### P2 — acquisition/history/export is not yet a first-class backend capability

DHO deep capture retains the latest completed capture in server memory. DMM trend is explicitly a browser-sampled latest-reading visual history, not one point per physical conversion, and is kept only in component memory. There is no durable acquisition/session model or general CSV/data export.

That is acceptable for the current two-device UI but not for the PPK2 roadmap, which explicitly assigns storage/decimation and charge integration to RigolWeb.

**Action:** before PPK2 UI work, define a server-side time-series acquisition contract with sample sequence/loss accounting, bounded RAM buffering, optional persistence, range/viewport reads and export. Keep DMM `DATA:LAST?` snapshots separate from true finite acquisitions until unique-sample semantics are proven.

### P3 — dev/deployment ergonomics contain machine-specific assumptions

`npm run dev:external` hard-codes `fabian@192.168.1.12` and port 3018. This is fine for one personal deployment but means the repository's dev command is not self-contained for another machine.

**Action:** either document that it is intentionally host-specific or move those values to environment variables. Do not build a large configuration system for this.

### P3 — static-file serving is deliberately minimal

The production HTTP server reads each requested asset from disk and sends no cache validators/cache-control/security headers. `/health` checks only that Node responds, not instrument connectivity; README already documents the latter behavior.

For a local bench UI this is not a performance priority. If the service remains behind Caddy, let Caddy own TLS/security headers/caching rather than reproducing a web platform in Node.

## Recommended architecture before PPK2

Keep the current explicit supported-device model, but move boundaries so the third instrument does not make the existing god objects worse.

Suggested server ownership:

```text
HTTP server / WebSocket server
  -> protocol decoder + request broker
  -> client session/subscription manager
  -> explicit Scope message adapter
  -> explicit DMM message adapter
  -> explicit PPK2 message adapter

InstrumentRegistry
  -> ScopeRuntime
  -> DmmRuntime
  -> Ppk2Runtime

ScopeRuntime -> SCPI scheduler/transport -> DHO804 driver
DmmRuntime   -> SCPI scheduler/transport -> DM858E driver
Ppk2Runtime  -> TCP stream/session       -> PPK2 decoder/acquisition store
```

The runtime layer must not import WebSocket gateway types. Each adapter translates domain state/results to/from wire messages.

Suggested browser ownership:

```text
AppWebSocketClient
  -> request IDs / deadlines / reconnect / desired subscriptions
  -> app transport state
  -> scope binding -> scope store + WaveformController
  -> DMM binding   -> DMM store
  -> PPK2 binding  -> PPK2 store/plot controller
```

Do not put large waveform/sample arrays in Zustand.

## Recommended work order

1. Fix protocol-v5 test/docs and add CI.
2. Bound/remove production SCPI detailed metrics accumulation.
3. Fix interaction pause ownership and request timeouts.
4. Make the LAN/auth/origin deployment trust boundary explicit.
5. Extract gateway-domain connection types and split `WebSocketGateway` responsibilities.
6. Split/rename the browser transport client and centralise transport state.
7. Define the PPK2 server-side acquisition/storage/decimation contract.
8. Add PPK2 as an explicit third runtime and protocol domain.
9. Continue DHO/DM858E typed-control surface expansion.

## Relevant source/doc references

- `src/shared/websocket-protocol.ts`
- `src/shared/websocket-protocol.test.ts`
- `src/server/scpi/scpi-scheduler.ts`
- `src/server/websocket/websocket-gateway.ts`
- `src/server/scope-runtime.ts`
- `src/server/dmm/dmm-runtime.ts`
- `src/server/instruments/instrument-registry.ts`
- `src/server/waveform/live-waveform-service.ts`
- `src/server/server.ts`
- `src/server/http-handler.ts`
- `src/web/websocket-client.ts`
- `src/web/scope-store.ts`
- `src/web/dmm/dmm-store.ts`
- `src/web/dmm/dmm-route-binding.ts`
- `src/web/components/dmm/dmm-trend.tsx`
- `src/shared/scope-types.ts`
- `docs/architecture.md`
- `docs/testing.md`
- `docs/changes/2026-09-02-dm858e-control-surface-gap-audit.md`
- Toxicboards `projects/PPK2Wireless/PROJECT.yaml`
