# Stream C — WebSocket broker + explicit instrument adapters

Implemented on `stream-c-websocket-broker-adapters` on 2026-09-08.

## Result

The server WebSocket layer is now split at the instrument application boundary.

- `WebSocketGateway` is the common session/protocol broker. It owns socket accept/close, protocol handshake, browser session identity, publication subscriptions, `InstrumentRegistry` subscription calls, common JSON/binary delivery, common command completion/failure framing, and the common socket backpressure threshold.
- `ScopeWebSocketAdapter` owns DHO804 request validation/dispatch, lifecycle/state projection, measurements, raw SCPI mapping, deep-capture mapping, waveform header validation, viewport supersession, and live-waveform latest-frame replacement/backpressure state.
- `DmmWebSocketAdapter` owns DM858E request validation/dispatch, lifecycle/state/snapshot projection, raw SCPI mapping, and connection-revision checks.
- `server.ts` is the composition root for the two fixed adapters; the common broker does not construct or import concrete instrument services/adapters.
- `websocket-validation.ts` contains only validation primitives shared by the broker/adapters; instrument-specific validation remains in the relevant adapter.
- The adapter/host contract is deliberately tiny and transport-only. The two adapters remain fixed server composition; no plugin registry, DI framework, generic instrument capability model, or event bus was added.
- Scope/DMM application services are unchanged and do not depend on the WebSocket gateway/adapters. Existing shared request/domain types are not redesigned in this stream.
- Wire protocol remains version 6. No compatibility path or protocol migration was introduced.
- Physical runtime activation remains browser-subscription-owned. Moving runtime lifetime to server ownership remains Stream D.
- All direct `WebSocketGateway` callers were migrated to the explicit adapter constructor surface; there is no legacy service-based gateway constructor.

## Tests

Broker tests now use fake instrument adapters and cover handshake/version handling, subscription lifecycle, adapter delegation, common failure framing, and socket-close cleanup independently of scope/DMM services.

Scope adapter tests cover control dispatch, state projection, raw-SCPI targeting, live-waveform latest-frame replacement, deep-viewport request mapping/frame delivery, and rejection of non-live frames on the live publication surface.

DMM adapter tests cover control dispatch, snapshot projection, raw-SCPI targeting, and rejection of stale completion after a connection revision changes in flight.

Socket-level integration tests continue to cover DHO804 Sleep routing, DMM snapshot subscription replay, and browser route/subscription lifecycle through the real WebSocket server.

During the refactor, an existing main-branch mismatch was found between the stale-DMM test expectation (`connection changed`) and the old gateway error text (`session changed`). The new adapter uses the tested `connection changed` wording.

Full `pnpm typecheck`, `pnpm test`, and `pnpm build` could not be executed in this session: the execution sandbox cannot resolve GitHub to obtain the repository/dependencies and this repository has no GitHub Actions workflow to run branch CI. Do not treat execution validation as complete until those commands pass in a checkout-capable environment.

Incremental software/package/hardware cost: **A$0**.
