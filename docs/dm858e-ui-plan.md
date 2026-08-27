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

Use a real React router. Adding a routing dependency is acceptable and has no hardware cost.

Routes:

- `/` -> DHO804
- `/dm858e` -> DM858E

Add a small persistent instrument switcher in the app shell:

- DHO804
- DM858E

Production static serving must fall back to `index.html` for application routes such as `/dm858e` while still returning real 404s for missing static assets.

## Instrument registration and activation lifecycle

Both supported instruments are registered with the server at startup, but registration does not open their SCPI transport.

Each registered instrument has its own configuration and runtime:

- DHO804 -> its own `ScpiTransport` + `ScpiScheduler` + scope runtime
- DM858E -> its own `ScpiTransport` + `ScpiScheduler` + DMM runtime

The browser route controls activation:

1. entering an instrument route subscribes the browser session to that instrument
2. the first active subscriber starts that instrument runtime and SCPI transport
3. leaving the route unsubscribes that browser session
4. the last active subscriber stops that instrument runtime and closes its SCPI transport

This means navigating from `/` to `/dm858e` normally stops the DHO804 transport and starts the DM858E transport.

Use subscription/reference-count semantics rather than a global `activeInstrument` singleton. That preserves the route-driven start/stop behaviour while allowing two browser tabs to use different instruments, or the same instrument, without one tab unexpectedly shutting down another tab's transport.

Browser disconnect must automatically release all subscriptions owned by that browser session.

A fast route change must not leave a stale pending start/stop operation able to resurrect the wrong runtime. Runtime start/stop needs explicit lifecycle state and idempotent transitions.

## Browser WebSocket lifecycle

Keep one browser/server WebSocket connection for the application shell.

Do not reconnect the browser WebSocket merely because the React route changes. Route components subscribe/unsubscribe instrument runtimes over the existing socket.

This keeps browser request correlation and error handling shared while allowing the instrument-side TCP/SCPI connection to be started and stopped independently.

The protocol should gain explicit instrument subscription messages, for example conceptually:

- subscribe DHO804
- unsubscribe DHO804
- subscribe DM858E
- unsubscribe DM858E

The exact wire names remain to be designed with the protocol update.

Scope-specific commands must only be accepted while that browser session is subscribed to the scope. DMM-specific commands must only be accepted while subscribed to the DMM.

## Server configuration

Configuration becomes explicit per registered instrument, for example:

- `RIGOL_SCOPE_HOST`
- `RIGOL_SCOPE_PORT`
- `RIGOL_DMM_HOST`
- `RIGOL_DMM_PORT`

This should be a hard cut from the current single `RIGOL_HOST` / `RIGOL_PORT` surface when implementation begins.

The registry owns configuration/runtime lookup; it does not collapse the two device domains into one generic state model.

## What should be shared

### Keep shared

`ScpiTransport` is already instrument-agnostic and should remain shared.

`ScpiScheduler` is mostly reusable. Generalize only the scope-specific coalescing boundary:

- the scheduler should accept an opaque caller-provided coalescing key
- scope code owns scope-specific keys such as channel scale/offset
- DMM code owns DMM-specific keys such as range/rate/function

Do not move scope or DMM command construction into the scheduler.

A small shared WebSocket request/correlation layer is also worth extracting if it avoids duplicating request IDs, pending promises and error handling.

Instrument subscription/ref-count management can also be shared at the server shell level.

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

- transport connection/reconnect lifecycle while activated
- identity validation
- authoritative DMM state
- reading acquisition
- host-side statistics/logging state
- browser publication

When the final route subscription disappears, ordinary live acquisition and polling stop and the SCPI transport closes.

Logging is a special case: if server-owned logging is active, the DMM runtime must remain active even with zero UI-route subscribers. A running logging job therefore counts as an activation lease until it is stopped.

Exact SCPI acquisition strategy needs to be benchmarked on the physical DM858E. Do not assume repeated single `READ?` queries are the best way to reach the useful reading rate; buffered/triggered acquisition may be better.

## Browser protocol

Keep the existing single browser WebSocket, but add explicit DMM messages rather than mutating the scope messages.

Likely shared lifecycle messages:

- instrument subscribed / unsubscribed
- command completed / failed
- raw SCPI result

Likely DMM lifecycle/data messages:

- connected / disconnected
- state snapshot
- current reading / reading batch
- control set
- acquisition configuration
- logging start/stop

The browser should keep a separate DMM store and DMM client facade.

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

Logging is server-owned so it can survive route changes, browser reloads and closing the browser tab. An active logging session holds the DMM runtime/transport open even when `/dm858e` has no active browser subscribers.

Persistent session/file format can be decided separately; do not add a database just to get the first DMM route working.

## Raw SCPI console

Reuse the existing console UI, but bind it to the instrument associated with the current route.

The console must never bypass the instrument's scheduler.

## First implementation slices

1. Add the router, persistent instrument shell and `/dm858e` route.
2. Add server instrument registration plus browser-session subscribe/unsubscribe/ref-count lifecycle.
3. Split server configuration into scope and DMM endpoints.
4. Generalize only the SCPI scheduler's scope-specific coalescing key.
5. Move existing scope runtime start/stop under route subscription ownership.
6. Add DM858E connection, `*IDN?`, state model and one primary reading.
7. Add function/range/rate controls.
8. Add host-side stats and trend plot.
9. Add server-owned logging/export with a logging activation lease.
10. Add trigger/sample configuration, secondary measurement and sensor workflows.
11. Benchmark real DM858E SCPI acquisition throughput and adjust acquisition strategy.

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
