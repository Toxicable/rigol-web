# DM858E D — Frontend

## Audience

This workstream starts after `dm858e-instrument-foundation.md` is complete and merged. It may proceed in parallel with `dm858e-backend.md`.

Implement the DM858E browser UI against the shared DMM/protocol contracts from stream B. Use fakes/mocked WebSocket messages where necessary; do not wait for the real backend implementation.

## Read before changing code

- `docs/dm858e-ui-plan.md`
- `docs/workstreams/dm858e-instrument-foundation.md`
- `docs/frontend.md`
- `docs/websocket-protocol.md`
- `docs/testing.md`
- `src/shared/dmm-types.ts`
- `src/shared/websocket-protocol.ts`
- existing scope store/client/component patterns

## Objective

Build a fast bench-DMM-oriented `/dm858e` UI with:

- large stable primary numeric display
- function selection
- Auto/fixed range control
- Slow/Medium/Fast rate selection
- connection and active-state feedback
- optional basic statistics/trend display if included in the current plan/contracts
- raw SCPI console bound to the DM858E route

No logging UI is included.

## Source ownership

Primary ownership:

```text
src/web/dmm/**
src/web/components/dmm/**
src/web/dmm-store.ts
DM858E route component(s)
DMM-specific tests/styles
```

Reuse shared app-shell/router code from stream B. Do not redesign the global router, subscription protocol or server lifecycle.

Avoid edits to scope-specific components unless a tiny shared visual primitive is clearly useful to both.

## DMM store/client

Create a separate DMM store rather than expanding `scope-store.ts` into a mixed instrument store.

The DMM browser layer should own:

- current DMM connection state
- current authoritative DMM state snapshot
- latest primary reading
- pending/request result state needed for controls
- route subscription hookup using the shared client/protocol foundation

Do not put a high-frequency history array into React state if a plotted reading stream later becomes large. For the first pass, keep the architecture simple and only optimize when required.

## Primary reading presentation

The primary reading is the visual focus.

Requirements:

- large numeric value
- unit visually attached but not competing with the number
- fixed-width/tabular numerals
- stable width/alignment as digits/sign/exponent change
- selected function visible
- Auto or selected fixed range visible
- rate/resolution visible
- disconnected/connecting state cannot be mistaken for a valid reading

The web UI should specifically avoid the owner-reported DM858 numeric-layout jumping problem.

Do not animate digits in a way that harms readability.

## Function selection

Provide direct controls for the supported function enum established in stream B.

Keep common functions one action away. Do not bury DCV/ACV/current/resistance behind a generic configuration modal.

Controls that are not meaningful for the selected function should not remain active with invalid stale values.

## Range control

Show:

- Auto
- supported fixed ranges for the current function

The browser must render range options from typed domain knowledge/capabilities rather than allowing arbitrary numeric SCPI strings.

When the backend reconciles to a different actual value, authoritative state wins.

## Rate/resolution

Expose the three documented modes clearly:

- Slow — 5.5 digit
- Medium — 4.5 digit
- Fast — 4.5 digit

The UI may also mention the DM858E 80 readings/s maximum in Fast mode where useful, but do not imply all functions necessarily deliver exactly that rate under all configurations.

## Statistics / trend

If host-side statistics are part of the shared first-pass contract, implement them from streamed readings rather than invoking Rigol's built-in math/statistics UI.

Useful first metrics:

- min
- max
- average
- standard deviation
- sample count

A compact trend plot is useful, but it is secondary to the main reading. Plot redraw cadence should be decoupled from reading arrival if needed for smooth UI behaviour.

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
- function selection messages
- range selection messages
- rate selection messages
- authoritative state overwrites stale optimistic control state
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
