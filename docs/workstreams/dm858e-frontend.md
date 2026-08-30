# DM858E D — Frontend

## Audience

This workstream starts after `dm858e-instrument-foundation.md` is complete and merged. It may proceed in parallel with `dm858e-backend.md`.

Implement the DM858E browser UI against the shared DMM/protocol contracts. Use fakes/mocked WebSocket messages where necessary; do not wait for the physical instrument.

## Implementation status

Implemented in draft PR #10 from merged backend head `22bd0ac`.

The current implementation includes:

- a separate Zustand DMM store with explicit browser-transport, runtime-waiting, instrument-disconnected and connected states;
- route-owned subscribe/unsubscribe lifecycle binding to the shared browser WebSocket;
- a stable tabular primary-reading display with engineering-unit formatting and explicit unavailable/overload states;
- protocol-v4 numeric snapshots with a required authoritative `resolution` quantum captured with the reading; the browser rounds to that quantum rather than inferring precision from rate, digit class or Auto-range state;
- explicit `Unavailable/ResolutionUnavailable` when the backend cannot establish a trustworthy numeric quantum rather than fabricating display precision;
- stale-function snapshot rejection in both the store and presentation layer;
- immediate local invalidation of a retained numeric reading whenever authoritative function, range or rate context changes, including same-function range/rate changes;
- one server-side latest-reading owner: `DmmPoller` samples and forwards non-null snapshots, while `DmmRuntime.currentSnapshot` is the sole dedupe/replay baseline;
- runtime invalidation that replaces the retained current snapshot with explicit `Unavailable/ConfigurationChanged` on every real `DmmStateStore` change before replay; because dedupe uses that same runtime baseline, an equal numeric value measured after the change is published again rather than suppressed;
- resolution-aware runtime dedupe, so an equal numeric value with a different authoritative resolution is published as a changed display snapshot;
- lifecycle-generation plus request-token ownership for pending controls so completion/failure from an old DMM session or old route mount cannot mutate a newer request;
- direct controls for every shared DM858E measurement function;
- typed Auto/fixed range choices from the single shared `src/shared/dm858e-capabilities.ts` source used by both frontend and backend, including the 3 A current maximum and 1 mF capacitance maximum;
- Slow/Medium/Fast controls carrying their originating measurement-function context;
- active function/range/rate choices are disabled and the route also guards redundant controls, preventing no-op selections from issuing physical SCPI configuration writes;
- no optimistic mutation of authoritative function/range/rate state while a request is pending;
- control-failure presentation while normal backend polling supplies authoritative follow-up state;
- reuse of the shared instrument-aware SCPI console, targeted to `DM858E` with a DMM-specific prompt;
- responsive desktop/lab and narrow-window layouts;
- focused store, lifecycle, control-generation, rendered-control, runtime snapshot, poller ownership, WebSocket replay and reading-format/presentation tests.

The snapshot channel remains display-only. No statistics, history, persistence, CSV export or logging UI has been added.

No package or hardware dependency was added for this workstream; incremental cost is $0.

Repository `pnpm typecheck`, `pnpm test` and `pnpm build` still need to be run from an environment with the repository dependencies available. This execution environment has Node/Corepack but cannot resolve `registry.npmjs.org`, so Corepack cannot activate pnpm or install the dependency tree. The PR therefore remains draft until the full repository gate is green.

## Read before changing code

- `docs/dm858e-ui-plan.md`
- `docs/dm858e-scpi.md`
- `docs/workstreams/dm858e-instrument-foundation.md`
- `docs/frontend.md`
- `docs/websocket-protocol.md`
- `docs/testing.md`
- `src/shared/dmm-types.ts`
- `src/shared/dm858e-capabilities.ts`
- `src/shared/websocket-protocol.ts`
- existing scope store/client/component patterns

## Objective

Build a fast bench-DMM-oriented `/dm858e` UI with:

- large stable latest-reading display
- function selection
- Auto/fixed range control when applicable
- Slow/Medium/Fast rate selection when applicable
- connection and active-state feedback
- explicit unavailable/overload display states
- raw SCPI console bound to the DM858E route

No logging UI is included. Statistics/trend are deferred until the backend exposes a verified sample stream rather than only a latest-reading snapshot.

## Source ownership

Primary ownership:

```text
src/web/dmm/**
src/web/components/dmm/**
src/shared/dmm-types.ts
src/shared/dm858e-capabilities.ts
src/shared/websocket-protocol.ts
DM858E route component(s)
DMM-specific tests/styles
```

The server driver/runtime may supply authoritative snapshot context and consume shared typed device capabilities, but SCPI command strings, parsing and instrument behavior stay server-only.

Reuse shared app-shell/router code. Do not redesign the global router, subscription protocol or server lifecycle.

Avoid edits to scope-specific components unless a tiny shared visual primitive is clearly useful to both.

## DMM store/client

Create a separate DMM store rather than expanding `scope-store.ts` into a mixed instrument store.

The DMM browser layer should own:

- current DMM connection state
- current authoritative DMM state snapshot
- latest `DmmReadingSnapshot`
- pending/request result state needed for controls
- route subscription hookup using the shared client/protocol foundation

`DmmReadingSnapshot` is display state, not a uniquely identified sample. Do not build sample counters/history/statistics from snapshot arrivals or snapshot changes.

Pending control completion/failure must be owned by the route/session generation and request that created it. A promise from a replaced session or unmounted route must not clear or fail a newer pending control.

Any authoritative change to function, range or rate invalidates a retained numeric reading before the new metadata is rendered with it. Equivalent periodic state snapshots may retain the reading.

The server has one retained-snapshot owner. `DmmPoller` must not maintain a second dedupe cache; it forwards sampled snapshots to `DmmRuntime`, and `DmmRuntime.currentSnapshot` owns dedupe plus subscription replay. A real `DmmStateStore` change replaces that baseline with `Unavailable/ConfigurationChanged`. Therefore a subsequent valid reading must be compared against the invalidated runtime baseline and republished even when its numeric value equals the pre-change reading.

For numeric snapshots, `resolution` is part of snapshot identity. An equal value with a changed resolution must not be deduplicated away.

## Primary reading presentation

The primary reading is the visual focus.

Requirements:

- large numeric value when `DmmReadingKind.Value`
- every numeric `Value` carries a positive authoritative `resolution` quantum from the backend measurement observation
- round the value to `snapshot.resolution` before engineering-prefix formatting
- never derive display precision from the Slow/Medium/Fast label, digit-class names, the numeric value's magnitude, or `DmmState.range`
- Auto range remains `{ mode: Auto }`; its effective physical range does not need to be exposed in state because the numeric snapshot itself carries the resulting resolution quantum
- if the backend cannot establish a trustworthy numeric quantum, render explicit `Unavailable/ResolutionUnavailable` instead of guessing
- explicit unavailable/overload presentation rather than retaining a stale numeric value
- unit visually attached but not competing with the number
- fixed-width/tabular numerals
- stable width/alignment as digits/sign/exponent change
- selected function visible
- Auto or selected fixed range visible only when `state.range !== null`
- rate visible only when `state.acquisitionRate !== null`
- disconnected/connecting state cannot be mistaken for a valid reading
- do not append trailing zeroes that imply precision not carried by the measurement value

A concrete correctness example is 100 V AC Fast: the configured quantum is 0.1 V, so a raw numeric `12.345678` must display as `12.3 V`, not `12.346 V`. The same rule applies under Auto range using the snapshot's authoritative quantum.

The web UI should specifically avoid the owner-reported DM858 numeric-layout jumping problem.

Do not animate digits in a way that harms readability.

## Function selection

Provide direct controls for the supported function enum established in the shared DMM contract.

Keep common functions one action away. Do not bury DCV/ACV/current/resistance behind a generic configuration modal.

Controls that are not meaningful for the selected function must not remain active. `null` range/rate state means not applicable; it is not an Auto/default value.

Selecting the already-active function must be a no-op; it must not send another instrument configuration write.

## Range control

When `state.range !== null`, show:

- Auto
- supported fixed ranges for the current function

When `state.range === null`, do not show an active range selector.

The browser and backend must consume the same shared typed DM858E range table rather than maintaining independent copies.

A range request must include the function under which its value was selected:

```ts
{
  kind: DmmControlKind.Range,
  function: state.function,
  value: nextRange,
}
```

If another tab or the physical front panel changes function before the request is applied, the server rejects the stale request and authoritative state wins.

Selecting the already-active Auto/fixed range must be a no-op; it must not send another configuration write.

## Rate/resolution

When `state.acquisitionRate !== null`, expose the three documented modes clearly:

- Slow — 5.5 digit
- Medium — 4.5 digit
- Fast — 4.5 digit

These labels describe instrument modes only. They are not sufficient to format a numeric reading. The displayed least-significant increment always comes from `DmmReadingSnapshot.resolution`.

When `state.acquisitionRate === null`, do not show an active rate selector.

A rate request likewise includes `function: state.function` so a stale request cannot be reinterpreted under a different measurement function.

The UI may mention the DM858E 80 readings/s maximum in Fast mode where useful, but do not imply all functions necessarily deliver exactly that rate under all configurations.

Selecting the already-active rate must be a no-op; it must not send another configuration write.

## Statistics / trend

Do **not** compute min/max/average/standard deviation/sample count or a measurement timeline from `DmmSnapshot` messages.

The current snapshot path intentionally does not identify individual physical measurements. A future backend contract must establish one event per measurement before host-side statistics/trend are implemented.

Once that sample stream exists, useful metrics include:

- min
- max
- average
- standard deviation
- sample count
- elapsed time
- trend plot

Plot redraw cadence should be decoupled from sample arrival if needed for smooth UI behaviour.

Do not add persistence, CSV export or logging controls.

## Raw SCPI console

Reuse the existing console interaction/component where practical, but route commands to the current instrument using the shared instrument-aware protocol.

Do not duplicate an entire console implementation only to change its target.

## Responsive layout

Primary target is a desktop/lab display, but the route should remain usable in a narrower browser window.

Suggested hierarchy:

```text
instrument shell / route nav
primary reading
function controls
range + rate controls
secondary analysis area
raw SCPI console
```

Do not attempt to clone the physical DM858E front panel pixel-for-pixel.

## Tests

Cover at least:

- route mount subscribes to DM858E and unmount/navigation unsubscribes
- connection/disconnection rendering
- stable primary value formatting for positive, negative, small, large and exponent-form values
- 100 V AC Fast snapshot with `resolution: 0.1` displays `12.345678` as `12.3 V`
- Auto-range presentation uses the snapshot's authoritative resolution rather than inferring precision from the Fast/Slow label
- values such as `12.34` do not gain trailing zeroes when the snapshot quantum is finer than the supplied numeric representation
- no numeric display is emitted when authoritative resolution is unavailable
- unavailable snapshot clears/replaces the prior numeric presentation
- same-function range/rate state changes invalidate a retained numeric reading immediately
- a second subscriber after a same-function state change receives/replays `Unavailable/ConfigurationChanged`, never the pre-change numeric snapshot
- equivalent DMM state polls preserve a valid current snapshot
- poller forwards equal sampled snapshots and does not own a dedupe baseline
- runtime deduplicates unchanged snapshots using `currentSnapshot`
- runtime does not deduplicate an equal numeric value whose `resolution` changed
- `Value X -> same-function state change -> runtime Unavailable -> next physical Value X` republishes X without requiring an intervening driver-level configuration-change snapshot
- function selection messages
- range selection messages include the current function context
- rate selection messages include the current function context
- range/rate controls are absent or disabled when shared state is `null`
- active function/range/rate selections do not send redundant writes
- authoritative state overwrites stale optimistic control state
- old-session rejection cannot mutate a newer session's pending control
- old-route completion cannot mutate a newer route mount's pending control
- stale function-dependent control failure is surfaced and followed by authoritative state
- raw SCPI targets DM858E
- no DMM state leaks into the DHO804 route/store

Run:

```text
pnpm typecheck
pnpm test
pnpm build
```

## Completion criteria

This stream is complete when `/dm858e` is a usable fake-data DMM interface driven entirely through the shared protocol/contracts, with no dependency on the physical DM858E for browser development. Numeric readings must be range-safe through authoritative snapshot resolution rather than browser-side reconstruction. Backend/device paths that cannot yet prove a numeric resolution remain explicitly unavailable until physical/specification evidence closes them.
