# Stream A — server application-service boundary

Implemented 2026-09-07.

## Result

The server now has explicit `ScopeService` and `DmmService` application boundaries between WebSocket request routing and physical instrument runtimes.

- `ScopeService` owns scope application semantics and per-session `ScopeController` access, including controls, acquisition actions, measurements, raw SCPI, and deep/live waveform operations.
- `DmmService` owns DMM mutation serialization, stale function-bound request validation, authoritative post-mutation readback, and current display-snapshot invalidation/deduplication/replay.
- `ScopeRuntime` and `DmmRuntime` now mean physical connection/session composition and recovery. They do not import `websocket-gateway.ts` or wire-result types.
- Scope/DMM connection status is represented by data-only `ScopeConnection` / `DmmConnection` values in `src/server/instruments/instrument-connection.ts`.
- `WebSocketGateway` depends on the two explicit application-service surfaces and projects their domain results to the existing wire protocol.
- `server.ts` is a composition root for services, runtimes, registry, HTTP and WebSocket delivery; runtime publication no longer requires a forward `let gateway!` reference.
- Browser subscription still owns runtime activation in this stream. Changing that lifetime belongs to Stream D.
- DHO804 sleep/wake orchestration remains in its existing HTTP/composition path. Moving it belongs to Stream B.

No compatibility shim, feature flag, generic instrument service, DI framework or event bus was added.
