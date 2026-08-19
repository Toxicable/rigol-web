# Integration Implementation Workstream

## Audience

This is the final composition/hardware-verification handoff after the foundation, SCPI backend, server-control, waveform and frontend workstreams have landed.

The goal is to wire the already-defined components together, run Rigol Web as one application, fix narrow contract mismatches and verify the real DHO804 behaviour/performance.

Do not use this workstream as an excuse for a broad refactor.

## Read first

Read all architecture documents, especially:

- `docs/architecture.md`
- `docs/development-practices.md`
- `docs/typescript-practices.md`
- `docs/server-architecture.md`
- `docs/scpi-scheduler.md`
- `docs/scope-model.md`
- `docs/frontend.md`
- `docs/waveforms.md`
- `docs/websocket-protocol.md`
- `docs/waveform-protocol.md`
- `docs/testing.md`

Read every implementation handoff under `docs/workstreams/` and inspect the actual code before changing anything.

## Preconditions

The following workstreams should already be complete:

- foundation
- SCPI backend
- server control/WebSocket
- waveforms
- frontend

Normal checks should already pass independently:

```text
pnpm typecheck
pnpm test
pnpm build
```

If one stream is incomplete, fix the smallest missing contract rather than redesigning the whole project during integration.

## File ownership

This workstream owns final composition/root integration files, especially:

```text
src/server/server.ts
src/server/scope-runtime.ts
vite.config.ts
package.json
```

It may add focused bench scripts such as:

```text
scripts/benchmark-scope.ts
scripts/test-scope.ts
```

It may make narrow fixes in workstream-owned modules where real integration proves a documented contract mismatch, but keep those fixes tightly scoped and preserve module boundaries.

Do not reorganize directories simply because all streams are now present.

## Runtime configuration

Version 1 uses server configuration rather than browser-side arbitrary instrument selection.

Require:

```text
RIGOL_HOST
RIGOL_PORT
```

Both identify the DHO804 raw SCPI/TCP endpoint.

The supplied Programming Guide confirms LAN SCPI support but does not specify a raw-socket port in the material used for this architecture. Therefore do not guess or silently hard-code a port such as 5555 before the actual DHO804 connection has been verified.

Validation:

- `RIGOL_HOST` must be a non-empty string
- `RIGOL_PORT` must be an integer from 1 through 65535

Fail configuration clearly if either is invalid.

For the Rigol Web HTTP server, use a small ordinary setting such as:

```text
PORT=3000
```

with 3000 as a reasonable default.

Do not add a configuration framework.

## HTTP server

Use Node's built-in HTTP server.

The final server should:

- keep `GET /health`
- serve the built frontend assets in production
- host the WebSocket upgrade endpoint at `/ws`

Do not add Express/Fastify merely for these routes.

### Health

`/health` reports whether the Rigol Web process is alive. It should not become unavailable merely because the scope is switched off.

A simple `200` response is sufficient. Scope connection state is reported through the WebSocket/application UI.

## Vite development proxy

The frontend uses same-origin `/ws`.

Configure Vite development so browser code does not need a different WebSocket URL in development.

Proxy `/ws` WebSocket upgrades to the Node server, initially `localhost:3000` unless the existing dev scripts choose another explicit server port.

If useful, proxy `/health` too.

Do not add frontend environment-specific WebSocket URL logic unless the proxy proves inadequate.

## `ScopeRuntime`

`ScopeRuntime` owns the live scope session and simple reconnection lifecycle.

It composes:

```text
ScpiTransport
ScpiScheduler
Dho804Driver
ScopeStateStore
ScopeController
ScopePoller
LiveWaveformService
DeepCaptureService
```

The WebSocket gateway is the browser transport and is wired to the runtime through the explicit callbacks/connection-state interface already defined by the server-control stream.

## Startup order

Start the HTTP/WebSocket application even if the DHO804 is currently unavailable. The scope may simply be switched off when the local web app starts.

Then begin one scope connection attempt:

```text
create fresh transport/scheduler/driver
    -> connect TCP
    -> *IDN?
    -> require model DHO804
    -> read complete initial ScopeState
    -> create connected session services
    -> publish ScopeConnected
    -> start ScopePoller
    -> start/enable live waveform service
```

A partially initialized device is never published as connected.

## Simple reconnect behaviour

Keep reconnection deliberately boring.

When startup connection fails, or an established connection becomes unusable:

1. publish scope-disconnected state/reason to browser clients
2. stop poll/live work associated with that connection
3. reject/discard stale queued work
4. close/dispose the old transport/session
5. wait a fixed short interval, initially about 2 seconds
6. create an entirely fresh scope session and try again

Only one connection attempt may run at a time.

No exponential backoff, circuit breaker, persistent command queue, command replay or per-operation retry policy.

A clear disconnected state plus fixed retry is enough for a personal bench application.

If the configured endpoint identifies a non-DHO804 device, report that exact mismatch. Retrying may continue at the same simple interval, but do not silently accept it as compatible.

## No stale command replay

Commands submitted to a dead/old scope session fail.

They are never replayed automatically after reconnect.

This is especially important for:

- stale interaction values
- Run/Stop/Single
- raw SCPI console commands

After reconnect, browser state begins from a fresh complete `ScopeState` read.

## Gateway wiring

Wire the server-control workstream's `WebSocketGateway` to the current runtime/session through required callbacks.

The callbacks should fail clearly with the current disconnected reason when there is no connected session.

Do not make every lower-layer service optional simply because the runtime can be disconnected. Keep lifecycle optionality at the connection/session boundary.

State-store subscriptions from the current session broadcast complete `ScopeState` snapshots.

When a session is replaced, detach subscriptions from the old one before attaching the new session.

## Waveform wiring

For the connected session:

- `LiveWaveformService.publishFrame` calls the gateway binary publication method
- deep capture requests call `DeepCaptureService.capture()` and are wrapped as `DeepCaptureReadyMessage`
- viewport requests call `DeepCaptureService.getViewport()` and send the returned binary frame

Do not copy binary frames through Zustand or JSON.

After the scope disconnects, a currently in-progress deep capture fails.

It is acceptable for version 1 to discard the previous server deep-capture object when a completely new connected session is created. Preserving historical captures across reconnect is not important enough to complicate runtime ownership.

## Browser connection lifecycle

Verify the frontend receives sensible transitions:

```text
transport connecting
    -> ScopeDisconnected while scope unavailable
    -> ScopeConnected with full state
    -> ScopeDisconnected if connection is lost
    -> fresh ScopeConnected after reconnect
```

The browser does not keep using the old connected `ScopeState` as though it were live after a scope disconnect.

Deep display samples may remain visually present if the frontend chooses, but control state must show disconnected.

## Production static serving

After `pnpm build`, the Node process should be able to serve the built browser app without requiring a second Vite server.

Use a small static-file implementation rather than adding an HTTP framework.

Requirements:

- serve the built `index.html` for the app root
- serve built JS/CSS/assets with appropriate basic content types
- prevent path traversal outside the web build directory
- return a normal 404 for unrelated files

There is no need for SPA routing machinery if the app only uses the root route.

## Shutdown

Handle normal `SIGINT`/`SIGTERM` sufficiently to:

- stop reconnect timer
- stop scope poll/live work
- close the WebSocket/HTTP server
- disconnect the scope transport

Do not build a generalized lifecycle framework.

## Scope bench script

Add a separate explicit real-scope command if useful, for example:

```text
pnpm test:scope
```

It should use the same `RIGOL_HOST`/`RIGOL_PORT` configuration and run a small deterministic verification suite against the configured physical DHO804.

It must not run as part of ordinary `pnpm test`.

The real-scope check should print the `*IDN?` result/firmware version and fail visibly at the first serious protocol mismatch.

## Benchmark script

Add an explicit benchmark command, for example:

```text
pnpm benchmark:scope
```

The benchmark follows `docs/testing.md` and records actual measured timings for:

- simple write/query round trips
- focused interactive writes/readbacks
- latest-value-wins throughput and final commit latency
- NORMAL waveform transfer for 1, 2 and 4 enabled channels
- representative RAW transfer depths
- deep Float32 conversion cost/memory
- min/max viewport generation cost

Print structured JSON or a compact table. No monitoring platform is needed.

If results are worth retaining, add a dated real result file under:

```text
docs/benchmarks/
```

Never commit invented benchmark placeholders.

## Required real-DHO804 verification

The mocks/unit tests cannot prove these facts. Check them on the actual DHO804 before calling the implementation hardware-verified:

### Transport

- configured TCP port works
- command/response terminator assumptions are correct
- persistent connection remains stable
- `TCP_NODELAY` causes no compatibility issue

### Scope model

- `*IDN?` exact model/firmware parsing
- all initial state query return spellings
- channel unit return values
- XY/Main mode quirk
- run-status values
- trigger type/sweep/Edge details
- memory depth/sample rate queries

### Physical controls and poll

While Rigol Web is connected, change on the scope itself:

- CH enable
- V/div
- offset
- time/div
- horizontal position
- Edge source/slope/level
- Run/Stop

Verify the browser reconciles through the approximately 1 Hz validation path without fighting an active web drag.

### Interactive latency

Exercise continuous:

- channel offset
- trigger level
- horizontal position

Verify:

- local UI movement is immediate
- scope follows at maximum useful pace rather than building backlog
- stale intermediate values are coalesced
- final committed value lands quickly
- final readback reflects scope rounding/clamping

### Waveform NORMAL

Verify:

- 1,000-point NORMAL reads while running
- X metadata and time alignment
- normalized Y values
- 1/2/4-channel behaviour
- browser plot scale/offset sign matches the physical scope presentation

### Native WORD decoding

This is a required verification item.

The Programming Guide states WORD uses two bytes per sample but the byte ordering/signedness is not sufficiently explicit in the waveform command material used for design.

Verify the isolated driver WORD decoder against the real DHO804 using a known waveform and one or more independent comparisons, such as:

- BYTE data for the same waveform
- ASCII data where practical
- known DC levels / probe compensation waveform

Once verified:

- lock the behaviour with a captured fixture/unit test
- document the observed encoding in the decoder/test
- remove any temporary uncertainty comment

Do not alter the browser binary protocol because of native WORD representation. The native format is a driver concern.

### RAW/deep

Verify:

- RAW read succeeds while stopped
- attempted RAW read while running fails/behaves as expected
- chunked `STARt`/`STOP` reads reconstruct the expected full sample count
- representative 1k/100k/1M/5M/10M/25M valid configurations
- multiple enabled channels produce internally consistent capture metadata
- deep viewport can pan/zoom without any additional scope read

## Performance acceptance philosophy

Do not set arbitrary pass/fail numbers before measuring the actual DHO804.

The important qualitative requirements are:

- browser interactions feel immediate locally
- interactive SCPI work is never stuck behind queued waveform/poll work
- stale interaction values do not accumulate
- final commit latency is low and measured
- live waveform stream stays fresh rather than queueing history
- deep panning/zooming is browser/server-memory work after acquisition

Use the first benchmark pass to decide whether further optimization is warranted.

Only then consider changes such as:

- fewer NORMAL live points
- different live channel cycle strategy
- SCPI query batching
- multiresolution deep min/max cache

Do not add these merely because they sound faster.

## Integration tests

Add only tests that genuinely exercise component boundaries not already covered in workstream unit tests.

Useful cases:

- server starts with scope unavailable and `/health` still works
- fake local TCP DHO + real transport/scheduler/driver/controller/gateway can reach a mock browser client
- disconnect rejects current work and browser receives disconnected state
- reconnect creates a fresh state rather than replaying stale queued work
- live binary frame passes server pipeline to a WebSocket client
- deep request/viewport passes through gateway to service and binary result

Keep the fake TCP DHO scripted and small.

## Definition of done

Integration is complete when:

1. one command starts the built Rigol Web server and serves the browser UI.
2. browser `/ws` works in development and production.
3. server can remain running while the scope is off and reconnects using the simple fixed retry loop.
4. a successful connection verifies exact DHO804 identity and sends a complete initial state before controls enable.
5. all v1 controls, measurements, raw SCPI console, live waveform and deep capture work end-to-end.
6. stale work is not replayed after a transport failure/reconnect.
7. direct drag interactions remain responsive while live waveform acquisition and polling are active.
8. native WORD decoding has been verified on the real DHO804 and locked into a test fixture.
9. real-scope latency/waveform benchmarks have been run and any justified first optimizations recorded.
10. `pnpm typecheck`, `pnpm test` and `pnpm build` pass.
11. no broad architecture rewrite was introduced during integration.