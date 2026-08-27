# DM858E B — Multi-Instrument Foundation

## Audience

This is the second DM858E implementation handoff. Start only after `dm858e-scpi-foundation.md` is complete and merged.

The purpose is to establish the app-level multi-instrument shell and lifecycle so the DHO804 and DM858E can both be registered, while only the instrument associated with an active browser route has its SCPI transport running.

## Read before changing code

- `docs/dm858e-ui-plan.md`
- `docs/architecture.md`
- `docs/server-architecture.md`
- `docs/frontend.md`
- `docs/websocket-protocol.md`
- `docs/testing.md`
- `docs/development-practices.md`
- `src/server/server.ts`
- `src/server/http-handler.ts`
- `src/server/scope-runtime.ts`
- `src/server/websocket/**`
- `src/shared/websocket-protocol.ts`
- `src/web/app.tsx`
- `src/web/websocket-client.ts`

## Objective

After this stream:

- a real React router is installed and wired
- `/` is the DHO804 route
- `/dm858e` exists as a route shell, but does not yet implement real DMM behaviour
- both supported instruments are registered on the server
- registration does not open SCPI transports
- browser route subscription starts/stops the corresponding runtime
- the existing DHO804 runtime is converted from unconditional server-start ownership to subscription ownership
- shared protocol contracts needed by the backend/frontend DM858E streams are stable

All added software must be free/open-source. No hardware cost is introduced by this stream.

## Route shell

Add a router dependency appropriate for the current React application.

Routes:

```text
/         -> DHO804
/dm858e   -> DM858E
```

Add a persistent instrument switcher in the application shell.

Do not redesign the existing scope UI. Wrap it as the DHO804 route with minimal movement.

The `/dm858e` route should be a typed placeholder using the final DMM route/component boundary expected by the frontend stream, not a fake finished UI.

Production static serving must support direct navigation/refresh of application routes by serving `index.html` for known SPA routes while still returning normal 404s for missing static assets.

## Instrument identity and registration

Define an explicit supported-instrument identity for exactly:

- DHO804
- DM858E

Do not create arbitrary driver plug-in discovery or a generic instrument marketplace/framework.

The server registers both instruments with configuration, runtime factory/ownership and subscription state.

Use explicit per-instrument configuration. Make a hard cut from the current single endpoint environment variables to:

```text
RIGOL_SCOPE_HOST
RIGOL_SCOPE_PORT
RIGOL_DMM_HOST
RIGOL_DMM_PORT
```

If an instrument endpoint is required by the chosen startup model, fail clearly when its configuration is invalid. Do not keep legacy aliases.

## Subscription lifecycle

The browser/server WebSocket remains one application connection.

Add explicit instrument subscribe/unsubscribe messages.

Required semantics:

1. entering an instrument route subscribes that browser session
2. first subscriber starts that instrument runtime
3. additional subscribers do not create additional SCPI transports
4. leaving the route unsubscribes that browser session
5. last subscriber stops that runtime and closes its SCPI transport
6. browser disconnect releases all subscriptions owned by that browser session

Use reference-count/session-ownership semantics rather than one global active-instrument flag.

The implementation must support:

- two tabs on the same route
- two tabs on different instrument routes
- rapid route changes
- browser disconnect without explicit unsubscribe

Runtime start/stop must be idempotent and protected against stale asynchronous transitions. A delayed old `start()` or `stop()` must not resurrect or kill a runtime after subscription state has changed again.

There is no logging/background activation exception in this phase. Zero subscribers means the instrument runtime is stopped.

## DHO804 migration

Move the existing scope runtime under the new activation lifecycle without changing scope behaviour while active.

Do not change waveform, control or measurement semantics except where required for lifecycle ownership.

The DHO804 should no longer connect merely because the Node server started.

## Shared protocol contracts

This stream owns the shared cross-stream contract necessary for C and D to proceed independently.

Add the minimum DMM shared types needed for the first functional UI/backend:

- DMM identity/info
- connection state payloads
- primary measurement function enum
- range mode / selected range representation
- acquisition rate/resolution enum
- primary reading payload
- basic DMM state snapshot

Add explicit DMM protocol message discriminants for:

- DMM connected/disconnected
- DMM state snapshot
- DMM reading publication
- DMM control request
- raw SCPI request/result if the existing generic request path cannot cleanly target an instrument

Keep scope and DMM domain state separate. Do not replace `ScopeState` with one giant union.

Exact DM858E SCPI strings/parsing do not belong here.

## Source ownership

Primary ownership:

```text
src/shared/websocket-protocol.ts
src/shared/dmm-types.ts
src/server/server.ts
src/server/http-handler.ts
src/server/websocket/**
src/server/instruments/**   (if introduced)
src/web/app.tsx
src/web/main.tsx
routing/app-shell files
package.json / lockfile
```

Minimum edits to `src/server/scope-runtime.ts` and browser scope wiring are allowed for lifecycle migration.

Do not implement `src/server/dmm/dm858e-driver.ts` or the real DMM screen in this stream.

## Tests

Cover at least:

- first subscriber starts one runtime
- second subscriber does not start another runtime
- one of two subscribers leaving does not stop the runtime
- last subscriber leaving stops it
- disconnect releases owned subscriptions
- different instruments activate independently
- rapid subscribe/unsubscribe does not leave stale lifecycle state
- DHO804 remains disconnected until `/` is subscribed
- route refresh/direct navigation works for `/dm858e`
- protocol validation rejects commands for instruments a session is not subscribed to

Run:

```text
pnpm typecheck
pnpm test
pnpm build
```

## Completion criteria

This stream is complete when the app can navigate between two registered instrument routes, the DHO804 transport starts/stops based on route subscription, `/dm858e` has stable shared protocol/type contracts, and no actual DM858E SCPI implementation is required for the project to remain green.
