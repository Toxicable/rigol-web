# DM858E UI plan

Status: initial planning

## Goal

Add the Rigol DM858E to Rigol Web as a second instrument UI while reusing the existing SCPI transport/scheduling foundation.

Do not turn the project into a generic arbitrary-instrument framework. The supported devices are explicitly the existing DHO804 and the new DM858E.

Reference material:

- `Toxicable/toxic-boards/docs/lab-gear/rigol-dm858e-capabilities.md`
- `Toxicable/toxic-boards/docs/lab-gear/rigol-dm858-ui-issues.md`
- Rigol DM858 Series Programming Guide / User Guide

## Route and shell

Keep the existing scope UI at `/` and add the DMM at `/dm858e`.

Add a small persistent instrument switcher in the app shell:

- DHO804
- DM858E

Do not add a routing dependency yet. A small pathname switch is enough for two fixed routes.

Production static serving must explicitly serve `index.html` for `/dm858e`; the current built-web handler otherwise treats it as a file path and returns 404.

## Server ownership

The server must own two completely independent instrument connections:

- DHO804 runtime -> its own `ScpiTransport` + `ScpiScheduler`
- DM858E runtime -> its own `ScpiTransport` + `ScpiScheduler`

Do not share a scheduler or TCP stream between instruments.

Configuration should become explicit per instrument, for example:

- `RIGOL_SCOPE_HOST`
- `RIGOL_SCOPE_PORT`
- `RIGOL_DMM_HOST`
- `RIGOL_DMM_PORT`

This should be a hard cut from the current single `RIGOL_HOST` / `RIGOL_PORT` surface when implementation begins.

## What should be shared

### Keep shared

`ScpiTransport` is already instrument-agnostic and should remain shared.

`ScpiScheduler` is mostly reusable. Generalize only the scope-specific coalescing boundary:

- the scheduler should accept an opaque caller-provided coalescing key
- scope code owns scope-specific keys such as channel scale/offset
- DMM code owns DMM-specific keys such as range/rate/function

Do not move scope or DMM command construction into the scheduler.

A small shared WebSocket request/correlation layer is also worth extracting if it avoids duplicating request IDs, pending promises and error handling.

### Keep separate

Keep domain state and command mapping separate:

- `src/server/scope/**`
- `src/server/dmm/**`
- `src/shared/scope-types.ts`
- new `src/shared/dmm-types.ts`
- existing `scope-store.ts`
- new `dmm-store.ts`

Do not force DMM state into `ScopeState` or create one huge all-instrument state union.

## DM858E backend shape

Initial server modules:

```text
src/server/dmm/dm858e-driver.ts
src/server/dmm/dmm-runtime.ts
src/server/dmm/dmm-state-store.ts
src/server/dmm/dmm-poller.ts
```

The DM858E driver owns exact SCPI commands and parsing.

The runtime owns:

- connection/reconnect lifecycle
- identity validation
- authoritative DMM state
- reading acquisition
- host-side statistics/logging state
- browser publication

Exact SCPI acquisition strategy needs to be benchmarked on the physical DM858E. Do not assume repeated single `READ?` queries are the best way to reach the useful reading rate; buffered/triggered acquisition may be better.

## Browser protocol

Keep the existing single browser WebSocket if practical, but add explicit DMM messages rather than mutating the scope messages.

Likely DMM lifecycle/data messages:

- connected / disconnected
- state snapshot
- current reading / reading batch
- control set
- acquisition configuration
- logging start/stop
- raw SCPI request/result

Generic command success/failure handling can remain shared.

The browser should keep a separate DMM store and a DMM client facade.

## Primary DMM screen

### Top/main reading area

The first screen should behave like a good bench DMM, not like a settings dashboard.

Show:

- very large primary reading
- unit
- selected function
- active range / Auto
- acquisition mode/resolution
- optional secondary reading when enabled
- connection state

Use fixed-width/tabular numerals and a stable layout so changing values do not make the reading jump horizontally.

The local DM858 UI has owner-reported moving/jumping numeric rendering, so this is an explicit web-UI improvement target.

### Function selection

Fast-access function controls for the DM858E-supported measurement families:

- DC voltage
- AC voltage
- DC current
- AC current
- resistance 2-wire
- resistance 4-wire
- continuity
- diode
- frequency / period
- capacitance
- temperature / sensor

Secondary-measurement options must be limited to combinations actually supported by the DM858E programming model; do not infer arbitrary combinations from the fact that the meter can display two measurements.

### Right-side measurement controls

Context-sensitive controls for the selected function:

- Auto or fixed range
- rate/resolution
- trigger source
- samples per trigger
- relevant function-specific options

Make the rate/resolution tradeoff explicit:

- Slow = 5.5 digits
- Medium/Fast = 4.5 digits
- DM858E maximum specified rate is 80 readings/s

Do not label Fast as a 5.5-digit 80 readings/s mode.

## Host-side analysis

A major reason for the web UI is to avoid the meter UI's artificial restrictions.

Implement statistics over the streamed readings in Rigol Web rather than relying on the meter's math screen:

- min
- max
- average
- standard deviation
- sample count
- elapsed time

This keeps statistics available while the instrument itself is in Auto range. Rigol's built-in math/statistics functions are disabled in Auto range.

The host should also own:

- trend plot
- limit checking
- reading history visible in the current session

The plot refresh rate should be independent from the instrument reading rate. A fast acquisition stream does not require repainting the graph for every sample.

## Logging

Host-side logging is more useful than treating the DM858E's internal 20,000-reading storage as the primary workflow.

Initial logging UI:

- start / stop
- elapsed time
- reading count
- current sample rate
- export CSV

Prefer server-owned logging so logging continues if the browser tab is reloaded or closed.

Persistent session/file format can be decided separately; do not add a database just to get the first DMM route working.

## Raw SCPI console

Reuse the existing console UI, but bind it to the currently selected instrument runtime.

The console must never bypass the instrument's scheduler.

## First implementation slices

1. Route shell and instrument switcher.
2. Split server configuration into scope and DMM endpoints.
3. Generalize only the SCPI scheduler's scope-specific coalescing key.
4. Add DM858E connection, `*IDN?`, state model and one primary reading.
5. Add function/range/rate controls.
6. Add host-side stats and trend plot.
7. Add server-owned logging/export.
8. Add trigger/sample configuration, secondary measurement and sensor workflows.
9. Benchmark real DM858E SCPI acquisition throughput and adjust acquisition strategy.

## Non-goals for the first pass

- generic VISA abstraction
- arbitrary instrument discovery
- multi-user tenancy
- generic plug-in driver framework
- reimplementing every DM858E front-panel menu before basic reading/control/logging works

## Open verification items

Before locking the exact control model, verify against the current Programming Guide and then the physical unit:

- SCPI port and connection behaviour used by the DM858E LAN interface
- exact function/range/rate command/response forms
- allowed secondary measurement combinations
- best sustained reading acquisition strategy over LAN
- behaviour when controls are changed from the physical front panel during host streaming
- whether any meter state needs a validation poll versus event/readback-only reconciliation
