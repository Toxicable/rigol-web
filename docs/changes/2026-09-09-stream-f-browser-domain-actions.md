# Stream F — browser domain actions

Implemented 2026-09-09 on `stream-f-browser-domain-actions`.

## Result

Ordinary browser controls now express scope/DMM domain intent rather than constructing protocol-shaped commands or coordinating request errors in React components.

- `ScopeActions` owns concrete scope control methods, optimistic scope presentation, 50 ms latest-value coalescing for interactive drag updates, final interaction commit, ordinary command failure presentation, Sleep pending state, and displayed-measurement configuration/polling.
- `DmmActions` owns concrete function/range/acquisition-rate controls, construction of function-dependent controls from current authoritative DMM state, redundant-write suppression, and generation-safe pending/error completion.
- `App` composes one scope action object and one DMM action object above the routes. The action APIs remain separate; no generic dispatcher/reducer/event bus was introduced.
- Scope channel/horizontal/trigger controls and toolbar no longer import WebSocket control/request discriminants. They call domain-valued action methods.
- DMM controls are presentation-only and emit function/range/acquisition-rate values rather than `DmmControlChange` objects.
- The waveform view retains pointer geometry and imperative uPlot rendering but emits horizontal/channel/trigger intent to `ScopeActions`; it no longer owns optimistic mutation, interaction coalescing, protocol interaction objects, or command error handling.
- Scope route unmount cancels any queued browser-side interaction update before publication unsubscribe, preventing an app-owned coalescing timer from sending an update after route exit.
- Measurement polling was removed from `ScopeBinding` so `ScopeActions` is the single browser owner of ordinary measurement orchestration.
- The Stream E-era stale DMM toolbar/store/route tests were corrected to use the shared application transport state and current instrument lifecycle enums.
- Raw SCPI remains an explicit exception: the generic SCPI console is intentionally a transport diagnostic surface and continues to use instrument-targeted `AppConnection.executeScpi(...)` rather than a fake domain action wrapper.

Authoritative server state remains decisive: scope optimistic state is replaced by later complete `ScopeState`; DMM actions do not mutate authoritative `DmmState` locally and later server state remains authoritative.

Protocol version 6 is unchanged.

## Tests

Added direct action tests for:

- scope optimistic update followed by authoritative replacement;
- scope command failure presentation;
- latest-value interactive update coalescing;
- Sleep pending ownership;
- measurement configuration/polling;
- DMM control construction from authoritative state;
- redundant DMM write suppression;
- DMM pending/failure ownership;
- stale DMM session completion not overriding a newer control.

Existing lifecycle integration remains on `AppConnection` + `ScopeBinding` / `DmmBinding` and continues to cover server-owned physical runtime lifetime independently of route publication subscriptions.

## Deliberately deferred

Stream F does not introduce server-owned acquisition/recording operations or storage. That is Stream G. PPK2 remains Stream H after the acquisition-operation boundary exists.

## Validation

The branch was reviewed against the Stream F acceptance criteria and stale Stream E test/type assumptions encountered during the refactor were removed. The available environment still cannot execute `pnpm typecheck`, `pnpm test`, or `pnpm build`: it has connected GitHub repository access but no runnable checkout/dependency environment, and this repository has no GitHub Actions workflow available as a substitute. Executable validation therefore remains pending rather than being claimed as passed.

Incremental software/package/hardware cost: **A$0**.
