# Rigol Web current gaps

Last reviewed: 2026-09-20, after merge of PR #45 (`99c059f9ee37770c56f6cc6a8910c56eb315de23`).

This is the living cross-instrument backlog for correctness, validation and product integration. Scope feature parity/details remain in `docs/scope-feature-gaps.md`; PPK2 behavior remains in `docs/ppk2.md`; DM858E command details remain in `docs/dm858e-scpi.md` and `docs/dm858e-ui-plan.md`.

## P0 — validation and release gates

### Add CI for the existing release checks

The repository currently has no `.github/workflows` directory, so `typecheck`, tests and builds are not automatically gated on pull requests or `main`.

Add one hardware-free workflow that runs:

```text
pnpm typecheck
pnpm test
pnpm build
```

Do not put physical-instrument tests in the required CI path.

Software/package purchase cost: **A$0**. GitHub-hosted Actions minute cost, if any, depends on the repository/account plan; a self-hosted runner is also possible but is not required by this recommendation.

### Complete the physical DHO804 regression pass

Toxicboards still tracks `RigolWeb: scope test; PPK2 Source Meter` as active software work. The current scope test should cover the merged main branch, especially:

- CH1-CH4 live display and interactive scale/offset/timebase controls;
- MATH1-MATH4 state, streaming, measurements and dependency-safe reset;
- browser-local A/B cursors on CH and MATH traces;
- stopped deep capture and viewport navigation;
- run/stop/single, Edge trigger and automatic measurements;
- disconnect/reconnect and front-panel state reconciliation.

Incremental hardware purchase cost: **A$0** if the existing DHO804 is used.

### Establish a true DM858E sample stream before conversion-counted analysis

`DATA:LAST?` is a latest-reading snapshot, not proof of one unique physical conversion per observation. A verified one-event-per-measurement acquisition path is still required before conversion-counted logging/statistics/export can be authoritative. Benchmark sustained LAN throughput on the physical DM858E as part of that work.

Incremental software cost: **A$0**.

## P1 — correctness and operational hardening

### Add browser request deadlines

`AppConnection.request()` stores pending requests until a matching response, socket close or disposal. There is no per-request deadline. A server operation that wedges while the WebSocket remains open can therefore leave browser state pending indefinitely.

Add explicit request deadlines, with operation-specific allowances where necessary; deep capture can have a longer deadline than ordinary controls.

### Bound SCPI scheduler metrics

`ScpiScheduler` still appends every successful operation to an in-memory `metrics` array for the lifetime of the scheduler. Long-running scope/DMM sessions therefore have unbounded diagnostic-memory growth.

Replace this with bounded recent history plus aggregate counters, or collect detailed metrics only during an explicit benchmark session.

### Make the deployment trust boundary explicit

`docker-compose.yml` publishes `3018:3000`, which binds on all host interfaces by default. The WebSocket server does not currently enforce an Origin/authentication policy and does not set a deliberately small client-message `maxPayload`.

Choose one deployment contract and document/enforce it:

- preferred when Caddy/reverse proxy is authoritative: bind Compose to loopback (`127.0.0.1:3018:3000`); or
- if direct LAN access is required: add explicit origin/authentication controls appropriate to the trusted LAN model.

No paid dependency is required. Incremental software cost: **A$0**.

### Validate server JSON messages in the browser

Server-side client-message parsing validates fields explicitly. Browser `AppConnection` currently accepts a server JSON object after checking only that `type` is a supported numeric discriminant, then casts the remaining payload.

Add explicit browser-side decoders/validators for server JSON messages so malformed fields cannot enter instrument stores as trusted typed data.

### Make shutdown cleanup failure-isolated

Server shutdown currently awaits PPK2 close, WebSocket close, instrument stop and HTTP close inside one `try` block. A failure in an earlier stage skips later cleanup.

Attempt all shutdown phases, collect/report errors, then set failure exit status.

## P1 — product integration

### PPK2 Source Meter mode

Ampere Meter integration is implemented end-to-end. The remaining Toxicboards project requirement is Source Meter control/presentation.

The project contract requires both Ampere Meter and Source Meter modes. Source Meter mode may use PPK2 VOUT to power the DUT, while PPK2Bridge must support the PPK2 POWER ONLY input for higher-current operation.

Rigol Web work includes mode control, voltage/current-limit presentation and state, command handling, safety/error behavior, and corresponding tests/docs.

Incremental Rigol Web software/package cost: **A$0**. Hardware purchase cost depends on whether the existing bench setup already provides the extra USB supply required by the PPK2/bridge design for higher-current Source Meter use.

### Remaining DHO804 product gaps

Use `docs/scope-feature-gaps.md` as the source of truth. Highest-value remaining items are currently:

1. channel labels/legend plus delivered-trace offscreen indication;
2. protocol decode and detailed serial triggers;
3. reference waveforms;
4. search/navigation and waveform recording;
5. channel invert/skew/full probe options;
6. pass/fail, histogram, DVM/counter and remaining measurements.

### Remaining DM858E typed controls

The shared DM858E state/control model still exposes only function, range and acquisition rate as typed controls. Important follow-up areas include:

- trigger source/count/sample count/external-trigger slope plus explicit trigger/abort;
- Relative/NULL;
- secondary measurement;
- instrument statistics/limits/dB/dBm;
- temperature probe configuration/unit;
- finite reading-memory acquisition and export after unique-sample semantics are established.

Incremental software/package cost: **A$0**.

## Closed or materially improved since the 2026-09-07 review

Do not keep treating these as current blockers:

- the browser now has app-level `AppConnection` and app transport state rather than a scope-owned WebSocket client;
- WebSocket handling is split into explicit scope, DMM, PPK2 and acquisition adapters;
- PPK2 has an explicit non-SCPI runtime/service/protocol/UI path with loss accounting, bounded retention and viewport reads;
- scope interactive live-waveform pause now has explicit browser-session ownership and unsubscribe/disconnect cleanup;
- DHO804 typed controls now cover substantially more of the analog/acquisition surface than the September 7 review described;
- MATH1-MATH4 and browser-local waveform cursors are implemented on `main`.

## Tracking

The GitHub issue tracker currently has no open issues. Until issue tracking is deliberately adopted, keep the actionable product backlog in the existing focused docs and keep Toxicboards `TODO.md` terse and current.
