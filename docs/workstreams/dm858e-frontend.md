# DM858E D — Frontend

## Audience

This workstream starts after `dm858e-instrument-foundation.md` is complete and merged. It may proceed in parallel with `dm858e-backend.md`.

Implement the DM858E browser UI against the shared DMM/protocol contracts. Use fakes/mocked WebSocket messages where necessary; do not wait for the physical instrument.

## Read before changing code

- `docs/dm858e-ui-plan.md`
- `docs/dm858e-scpi.md`
- `docs/workstreams/dm858e-instrument-foundation.md`
- `docs/frontend.md`
- `docs/websocket-protocol.md`
- `docs/testing.md`
- `src/shared/dmm-types.ts`
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
src/web/dmm-store.ts
DM858E route component(s)
DMM-specific tests/styles
```

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

## Primary reading presentation

The primary reading is the visual focus.

Requirements:

- large numeric value when `DmmReadingKind.Value`
- explicit unavailable/overload presentation rather than retaining a stale numeric value
- unit visually attached but not competing with the number
- fixed-width/tabular numerals
- stable width/alignment as digits/sign/exponent change
- selected function visible
- Auto or selected fixed range visible only when `state.range !== null`
- rate/resolution visible only when `state.acquisitionRate !== null`
- disconnected/connecting state cannot be mistaken for a valid reading

The web UI should specifically avoid the owner-reported DM858 numeric-layout jumping problem.

Do not animate digits in a way that harms readability.

## Function selection

Provide direct controls for the supported function enum established in the shared DMM contract.

Keep common functions one action away. Do not bury DCV/ACV/current/resistance behind a generic configuration modal.

Controls that are not meaningful for the selected function must not remain active. `null` range/rate state means not applicable; it is not an Auto/default value.

## Range control

When `state.range !== null`, show:

- Auto
- supported fixed ranges for the current function

When `state.range === null`, do not show an active range selector.

The browser must render range options from typed domain knowledge/capabilities rather than allowing arbitrary numeric SCPI strings.

A range request must include the function under which its value was selected:

```ts
{
  kind: DmmControlKind.Range,
  function: state.function,
  value: nextRange,
}
```

If another tab or the physical front panel changes function before the request is applied, the server rejects the stale request and authoritative state wins.

## Rate/resolution

When `state.acquisitionRate !== null`, expose the three documented modes clearly:

- Slow — 5.5 digit
- Medium — 4.5 digit
- Fast — 4.5 digit

When `state.acquisitionRate === null`, do not show an active rate selector.

A rate request likewise includes `function: state.function` so a stale request cannot be reinterpreted under a different measurement function.

The UI may mention the DM858E 80 readings/s maximum in Fast mode where useful, but do not imply all functions necessarily deliver exactly that rate under all configurations.

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
- unavailable snapshot clears/replaces the prior numeric presentation
- function selection messages
- range selection messages include the current function context
- rate selection messages include the current function context
- range/rate controls are absent or disabled when shared state is `null`
- authoritative state overwrites stale optimistic control state
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

This stream is complete when `/dm858e` is a usable fake-data DMM interface driven entirely through the shared protocol/contracts, with no dependency on the physical DM858E and no edits required to backend driver logic.
