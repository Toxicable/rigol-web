# DM858E UI plan

Status: initial planning

## Goal

Add the Rigol DM858E to Rigol Web as a second instrument UI.

Before adding the DMM route/runtime, refactor the existing SCPI layer into a genuinely shared instrument foundation. Do not make the scope implementation itself generic; only extract the pieces that are actually common to SCPI instruments.

Supported devices remain explicit:

- Rigol DHO804
- Rigol DM858E

Reference material:

- `Toxicable/toxic-boards/docs/lab-gear/rigol-dm858e-capabilities.md`
- `Toxicable/toxic-boards/docs/lab-gear/rigol-dm858-ui-issues.md`
- Rigol DM858 Series Programming Guide / User Guide

## Phase 1: SCPI foundation refactor

Do this before adding DM858E-specific UI or runtime code.

### Keep generic/shared

`ScpiTransport` is already mostly instrument-agnostic and should remain the common TCP/SCPI framing layer.

`ScpiScheduler` should become fully instrument-agnostic:

- remove scope types from the scheduler
- remove scope-specific `ScpiCoalesceKind` values
- accept an opaque caller-provided coalescing key
- retain priority scheduling, coalescing, superseding, metrics and transport serialization
- keep binary/text response handling generic

Scope code then owns scope-specific scheduler keys such as channel scale/offset, horizontal scale/position and trigger level.

DMM code will own its own keys such as range, function or rate where coalescing is useful.

Also extract/share any browser/server request-correlation or raw-SCPI plumbing that is currently scope-specific but is actually identical for both instruments.

The raw SCPI console must always go through the selected instrument's scheduler.

### Keep device-specific

Do not create a generic instrument state model or generic driver API merely because both devices use SCPI.

Keep these separate:

- `src/server/scope/**`
- `src/server/dmm/**`
- `src/shared/scope-types.ts`
- new `src/shared/dmm-types.ts`
- scope store/client facade
- DMM store/client facade
- DHO804 SCPI command mapping
- DM858E SCPI command mapping

The shared boundary is transport/scheduling/session plumbing, not measurement semantics.

## Route and shell

Use a real React router.

Routes:

- `/` -> DHO804
- `/dm858e` -> DM858E

Add a persistent instrument switcher:

- DHO804
- DM858E

Production static serving must fall back to `index.html` for application routes while still returning real 404s for missing static assets.

## Instrument registration and activation lifecycle

Both instruments are registered with the server at startup, but registration does not open their SCPI transport.

Each instrument owns its own independent SCPI session:

- DHO804 -> `ScpiTransport` + `ScpiScheduler` + scope runtime
- DM858E -> `ScpiTransport` + `ScpiScheduler` + DMM runtime

The browser route controls activation:

1. entering an instrument route subscribes that browser session to the instrument
2. the first subscriber starts that instrument runtime and SCPI transport
3. leaving the route unsubscribes that browser session
4. the last subscriber stops that runtime and closes its SCPI transport

Use per-instrument subscription/reference counts rather than a global `activeInstrument` singleton so multiple tabs cannot shut down each other's sessions.

Browser disconnect releases its subscriptions automatically.

Runtime start/stop must be idempotent and safe against rapid route changes so stale asynchronous lifecycle work cannot reopen an instrument after its final subscriber has left.

## Browser WebSocket lifecycle

Keep one browser/server WebSocket connection for the application shell.

Route changes do not reconnect the browser WebSocket. Route components subscribe/unsubscribe instrument runtimes over the existing socket.

The protocol should gain explicit instrument subscription messages plus DMM-specific messages. Generic request completion/failure and raw-SCPI result handling can be shared.

Scope commands are accepted only from sessions subscribed to the scope. DMM commands are accepted only from sessions subscribed to the DMM.

## Server configuration

Use explicit configuration per registered instrument, for example:

- `RIGOL_SCOPE_HOST`
- `RIGOL_SCOPE_PORT`
- `RIGOL_DMM_HOST`
- `RIGOL_DMM_PORT`

This should be a hard cut from the existing single `RIGOL_HOST` / `RIGOL_PORT` configuration when implementation begins.

## DM858E backend shape

Initial modules:

```text
src/server/dmm/dm858e-driver.ts
src/server/dmm/dmm-runtime.ts
src/server/dmm/dmm-state-store.ts
src/server/dmm/dmm-poller.ts
```

The driver owns exact DM858E SCPI commands and parsing.

The runtime owns:

- transport lifecycle while route-subscribed
- identity validation
- authoritative DMM state
- reading acquisition
- browser publication

When the final route subscriber leaves, acquisition/polling stops and the SCPI transport closes.

Do not add background logging lifecycle exceptions yet.

Exact SCPI acquisition strategy must be verified against the Programming Guide and benchmarked on the physical DM858E. Do not assume repeated `READ?` is the optimal sustained acquisition path.

## Primary DM858E screen

The main screen should behave like a good bench DMM rather than a settings dashboard.

Show prominently:

- large stable primary reading
- unit
- selected function
- active range / Auto
- acquisition mode/resolution
- optional secondary reading
- connection state

Use tabular/fixed-width numerals and stable layout geometry so changing readings do not visibly shift horizontally.

### Function selection

Fast-access controls for:

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

Secondary-measurement choices must match combinations actually supported by the DM858E programming model.

### Measurement controls

Context-sensitive controls for:

- Auto or fixed range
- rate/resolution
- trigger source
- samples per trigger
- function-specific settings

Make the documented rate/resolution relationship explicit:

- Slow = 5.5 digits
- Medium/Fast = 4.5 digits
- DM858E maximum specified rate = 80 readings/s

## Host-side analysis

Host-side analysis is useful because it avoids limitations in the meter's own UI.

Initial analysis can include:

- min
- max
- average
- standard deviation
- sample count
- elapsed time
- trend plot
- limits

Statistics should operate on the streamed readings rather than relying on the DM858E's built-in math screen, so they can remain available while the instrument is in Auto range.

Plot refresh rate should be independent from instrument acquisition rate.

No persistent/background logging is required in the current scope.

## First implementation slices

1. Refactor `ScpiScheduler` and related SCPI plumbing so the shared layer contains no scope-domain types or keys.
2. Keep the DHO804 working entirely through that refactored shared SCPI layer; run existing tests before adding DMM code.
3. Add the router, persistent instrument shell and `/dm858e` route.
4. Add server instrument registration plus browser-session subscribe/unsubscribe/ref-count lifecycle.
5. Split server configuration into scope and DMM endpoints and move scope runtime start/stop under subscription ownership.
6. Add DM858E `*IDN?`, state model and one primary reading.
7. Add function/range/rate controls.
8. Add host-side statistics and trend plot.
9. Add trigger/sample configuration, secondary measurement and sensor workflows.
10. Benchmark real DM858E SCPI acquisition throughput and adjust acquisition strategy.

## Non-goals for the first pass

- persistent/background logging
- generic VISA abstraction
- arbitrary instrument discovery
- generic plug-in driver framework
- generic cross-instrument state model
- multi-user tenancy
- reimplementing every DM858E front-panel menu before basic reading/control works

## Open verification items

Before locking the exact DMM control model, verify against the current Programming Guide and then the physical unit:

- SCPI port and LAN connection behaviour
- exact function/range/rate command/response forms
- allowed secondary measurement combinations
- best sustained reading acquisition strategy over LAN
- behaviour when front-panel controls change during host streaming
- which DMM state benefits from polling versus explicit readback
