# Stream C — WebSocket broker + explicit instrument adapters

Implemented on `stream-c-websocket-broker-adapters` on 2026-09-08.

## Result

The server WebSocket layer is now split at the instrument application boundary.

- `WebSocketGateway` is the common session/protocol broker. It owns socket accept/close, protocol handshake, browser session identity, publication subscriptions, `InstrumentRegistry` subscription calls, common JSON/binary delivery, common command completion/failure framing, and the common socket backpressure threshold.
- `ScopeWebSocketAdapter` owns DHO804 request validation/dispatch, lifecycle/state projection, measurements, raw SCPI mapping, deep-capture mapping, waveform header validation, viewport supersession, and live-waveform latest-frame replacement/backpressure state.
- `DmmWebSocketAdapter` owns DM858E request validation/dispatch, lifecycle/state/snapshot projection, raw SCPI mapping, and connection-revision checks.
- `websocket-validation.ts` contains only validation primitives shared by the broker/adapters; instrument-specific validation remains in the relevant adapter.
- The adapter/host contract is deliberately tiny and transport-only. The two adapters remain fixed server composition; no plugin registry, DI framework, generic instrument capability model, or event bus was added.
- Scope/DMM application services are unchanged and remain independent of WebSocket types.
- Wire protocol remains version 6. No compatibility path or protocol migration was introduced.
- Physical runtime activation remains browser-subscription-owned. Moving runtime lifetime to server ownership remains Stream D.

## Tests

Added adapter-level tests that dispatch scope and DMM commands without real WebSocket connections and verify publication projection through the adapter host.

Existing socket-level gateway tests remain the end-to-end coverage for handshake, subscription lifecycle, service routing, deep viewport delivery, live waveform publication, DHO804 Sleep, and DMM snapshot replay.

During the refactor, an existing main-branch mismatch was found between the stale-DMM test expectation (`connection changed`) and the old gateway error text (`session changed`). The new adapter uses the tested `connection changed` wording.

Full `pnpm typecheck`, `pnpm test`, and `pnpm build` were not run from this session because the connected GitHub repository is not mounted into the execution sandbox. Do not treat this branch as validated until those commands pass in a checkout-capable environment.

Incremental software/package/hardware cost: **A$0**.
