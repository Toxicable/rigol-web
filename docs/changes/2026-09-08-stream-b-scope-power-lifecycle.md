# Stream B — scope power/lifecycle ownership

Implemented 2026-09-08.

## Result

DHO804 Sleep now belongs to the scope application-service/runtime boundary instead of HTTP/server composition.

- Protocol version 6 adds `MessageType.ScopeSleep = 19` with normal request ID / `CommandCompleted` / `CommandFailed` framing.
- The browser toolbar calls `ScopeWebSocketClient.sleep()`; it no longer sends `POST /api/scope/sleep`.
- `WebSocketGateway` validates the request, requires a DHO804 subscription, and dispatches it to `ScopeService.sleep()`.
- `ScopeService` owns a concrete `ScopePowerLifecycle` using the existing `Dho804PowerControl` and offline-then-online TCP wake monitor.
- `ScopeRuntime.suspendForSleep()` stops the active physical SCPI session/reconnect loop while preserving registry activation and browser subscription ownership; `resumeAfterSleep()` restarts the physical session only when the runtime is still registry-active.
- A native Sleep failure releases the deliberate suspension immediately. A wake-monitor failure also releases it so the normal runtime recovery path can continue.
- `InstrumentRegistry.suspend()` / `resume()` and their suspended state were removed; the registry again owns subscription activation only.
- `server.ts` now only composes configuration/services/registry/HTTP/WebSocket and handles startup/shutdown. It no longer coordinates ADB or physical wake monitoring.
- `src/server/http-handler.ts` no longer exposes an instrument control API. `POST /api/scope/sleep` returns the normal static-handler 404, and the obsolete HTTP power-control test was removed.
- The unused Vite `/api` development proxy was removed.

The underlying DHO804 power mechanism is unchanged: native panel-power key injection, popup settle delay, immediate ADB re-check, one-way Sleep-button tap dispatch, then physical front-panel wake detected through the SCPI TCP endpoint.

No compatibility shim, feature flag, generic power abstraction, event bus or runtime-lifetime redesign was added. Subscription-driven physical runtime activation remains in place until Stream D.

Incremental software/package/hardware cost: **A$0**.
