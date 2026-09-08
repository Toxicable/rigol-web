# Stream D — Server-owned runtime lifetime + publication subscriptions

Implemented on `stream-d-server-owned-runtime-lifetime` on 2026-09-08, stacked on Stream C.

## Result

Physical DHO804 and DM858E runtime lifetime is now owned by the server rather than browser route subscriptions.

- `InstrumentRegistry` is now the deterministic server runtime manager for the two configured instruments. It owns idempotent/serialized `startAll()` and `stopAll()` only; it no longer tracks browser objects, subscriber counts, endpoints or subscriber callbacks.
- `server.ts` starts both known runtimes before accepting HTTP/WebSocket traffic and stops both during server shutdown.
- `WebSocketGateway` no longer depends on `InstrumentRegistry`. Browser `InstrumentSubscribe`/`InstrumentUnsubscribe` messages control publication/fanout state only.
- Closing a browser WebSocket releases only adapter/browser session state. It does not stop either physical runtime.
- Existing scope/DMM runtime reconnect loops remain unchanged and continue while the server-owned runtime is active, regardless of browser presence.
- DMM current-snapshot replay moved from the removed registry `subscriberAdded` hook to `DmmWebSocketAdapter.sendInitialPublications()`. A newly subscribed browser receives the current lifecycle plus retained current snapshot directly without rebroadcasting that snapshot to already-subscribed browsers.
- The DMM service still owns current-snapshot invalidation/deduplication. The presentation/session adapter owns replay to a newly subscribed browser.
- The old `DmmService.replayCurrentSnapshot()` browser-awareness was removed.

## Multi-browser semantics

Stream D makes the browser-session ownership rule explicit:

- atomic instrument commands remain global; the last accepted write wins;
- a DHO804 long-lived `InteractionUpdate`/`InteractionCommit` sequence has one browser-session owner while active;
- another browser cannot commit or release that active interaction;
- an atomic scope control remains accepted even while another browser owns an interaction;
- scope unsubscribe/socket-close releases an owned interaction and resumes live waveform acquisition;
- scope physical disconnect also clears the interaction owner;
- browser publication subscription is never a physical-runtime ownership lease.

No generic lock manager, collaborative-editing layer, runtime-lifetime configuration, compatibility alias or protocol migration was added.

## Tests updated/added

- `instrument-registry.test.ts`
  - both server-owned runtimes start exactly once;
  - startup is idempotent;
  - shutdown stops both runtimes and is idempotent;
  - a failed runtime start can retry without restarting the runtime that already started;
  - all runtimes receive shutdown even when one stop fails;
  - shutdown serializes behind an in-flight startup.
- `websocket-gateway.test.ts`
  - subscribe/unsubscribe is publication state only;
  - socket close releases adapter session state only.
- `instrument-lifecycle.integration.test.ts`
  - both runtimes are started before any browser subscribes;
  - route switching does not restart runtimes;
  - last route unsubscribe does not stop the scope runtime;
  - closing browser sockets does not stop either runtime;
  - browser transport reconnect does not restart physical runtimes.
- `dmm-snapshot-replay.test.ts`
  - newly subscribing/reconnecting clients receive the retained current snapshot directly;
  - existing subscribers do not receive a replay solely because another browser subscribed;
  - invalidated snapshots remain the replayed current state after same-function configuration changes.
- `scope-websocket-adapter.test.ts`
  - long-lived scope interaction ownership is browser-session-specific;
  - another browser cannot commit an interaction it does not own;
  - atomic scope controls remain globally accepted while an interaction is owned;
  - unsubscribe releases the interaction owner and live-waveform pause.

The obsolete registry subscriber-lifecycle test was removed because that API no longer exists.

## Active documentation

`docs/architecture.md`, `docs/server-architecture.md`, and `docs/frontend.md` describe browser subscriptions as publication-only and physical runtime lifetime as server-owned. Older DM858E planning/workstream documents describe the historical subscription-owned implementation phase and are not the active architecture source.

## Validation status

Source/caller and behavior-preservation review was completed against the branch, including removed registry APIs and direct `WebSocketGateway` construction sites.

`pnpm typecheck`, `pnpm test`, and `pnpm build` have **not** been executed in this session. The execution sandbox cannot resolve GitHub for a checkout/install, the connected repository is not mounted into the sandbox, and this repository currently has no `.github/workflows` CI configuration that can be used for remote validation.

Treat Stream D as **implementation-complete, execution-validation pending** until those three commands pass in a checkout-capable environment.

Incremental software/package/hardware cost: **A$0**.
