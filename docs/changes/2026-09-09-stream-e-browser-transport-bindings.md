# Stream E — browser transport + instrument bindings

Implemented 2026-09-09 on `stream-e-browser-transport-bindings`.

## Result

Rigol Web now has one application-wide browser transport boundary instead of a scope-shaped global WebSocket client.

- `AppConnection` owns WebSocket connect/reconnect, protocol handshake, request IDs/correlation, desired publication subscriptions, JSON/binary fanout, and instrument-targeted raw SCPI request correlation.
- `app-transport-store.ts` is the single browser transport-state owner. Scope and DMM stores no longer duplicate WebSocket connecting/disconnected state.
- `ScopeBinding` owns DHO804 lifecycle/state message projection, scope request construction, measurement/deep-capture coordination, waveform decode/controller handoff, and DHO804 publication subscription.
- `DmmBinding` owns DM858E lifecycle/state/snapshot projection, DMM request construction, DMM raw SCPI targeting, and DM858E publication subscription.
- Route mount/unmount now activates/deactivates publication subscriptions only; it does not recreate the application WebSocket or affect server-owned physical runtime lifetime.
- DHO804 binary waveform bytes remain outside generic transport semantics and outside React/Zustand. `AppConnection` only fans out the binary payload; `ScopeBinding` performs DHO804 decoding and waveform-controller delivery.
- The old `ScopeWebSocketClient`, its direct tests, and the superseded shared-client subscription tests were removed as a hard cut. No compatibility alias remains.
- The server-owned lifetime integration test now exercises `AppConnection` with `ScopeBinding` / `DmmBinding` instead of the removed legacy client.
- Dedicated `AppConnection` tests cover handshake/subscription replay, application-wide request correlation, reconnect subscription restoration, protocol mismatch, and cancellation of a pending reconnect during application teardown.
- A reconnect teardown race was fixed: `dispose()` now cancels a scheduled reconnect, so unmount/application shutdown cannot recreate the browser transport after disposal.

Protocol version 6 is unchanged; Stream E changes browser ownership boundaries, not the wire contract.

## Deliberately deferred

Stream E does not move ordinary React control orchestration behind domain action layers. That is Stream F. Acquisition-operation ownership and PPK2 integration remain Streams G and H.

## Validation

The branch was reviewed against the Stream E acceptance criteria and the remaining legacy-client dependencies were removed. This session cannot execute `pnpm typecheck`, `pnpm test`, or `pnpm build` because the available environment has GitHub repository access but no runnable checkout/dependency environment, and this repository has no CI workflow available to substitute for those commands. Those executable validation gates therefore remain pending rather than being claimed as passed.

Incremental software/package/hardware cost: **A$0**.
