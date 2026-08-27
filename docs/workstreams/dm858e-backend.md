# DM858E C — Backend / Driver

Status: **In progress — draft PR #9 (`dm858e-backend`)**.

Implementation/specification notes: `../dm858e-scpi.md`.

## Audience

This workstream starts after `dm858e-instrument-foundation.md` is complete and merged. It may proceed in parallel with `dm858e-frontend.md`.

Implement the real DM858E server-side behaviour against the shared contracts established by stream B. Do not change those contracts unless they are genuinely impossible to implement; report such a contradiction rather than silently redesigning them.

## Read before changing code

- `docs/dm858e-ui-plan.md`
- `docs/workstreams/dm858e-scpi-foundation.md`
- `docs/workstreams/dm858e-instrument-foundation.md`
- `docs/scpi-scheduler.md`
- `docs/server-architecture.md`
- `docs/testing.md`
- `src/shared/dmm-types.ts`
- `src/shared/websocket-protocol.ts`
- `src/server/scpi/**`
- existing DHO804 driver/runtime patterns where useful

Use the current Rigol DM858 Series Programming Guide as the specification for exact commands and response forms. Do not infer SCPI commands from DHO804 command names merely because both instruments use SCPI.

## Objective

Implement a DM858E runtime that can:

- connect/disconnect under the shared subscription lifecycle
- validate identity using `*IDN?`
- read authoritative basic DMM state
- publish primary readings
- set measurement function
- set Auto/fixed range where supported
- set Slow/Medium/Fast acquisition rate/resolution
- execute raw SCPI through the same scheduler
- notice relevant front-panel state changes through a simple validation/readback strategy

No logging is included.

## Source layout

Primary ownership:

```text
src/server/dmm/dm858e-driver.ts
src/server/dmm/dmm-runtime.ts
src/server/dmm/dmm-state-store.ts
src/server/dmm/dmm-poller.ts   (only if a poller is actually required)
src/server/dmm/**/*.test.ts
```

Use the generic `ScpiTransport` and `ScpiScheduler`; do not create a second DMM-specific transport implementation.

Do not edit frontend source.

## Driver boundary

`Dm858eDriver` owns:

- exact SCPI command strings
- exact query response parsing
- Rigol-specific enum/string conversions
- model/identity validation
- function/range/rate mappings
- primary reading acquisition commands

Rigol-native response syntax should stop at this boundary. The runtime and browser should use shared typed DMM values.

## Runtime lifecycle

The runtime must be dormant until activated by the instrument registry/subscription layer.

On start:

1. create/connect transport
2. create/use scheduler
3. query identity
4. reject an unexpected model clearly
5. read initial state
6. publish connected state
7. begin primary reading acquisition and any minimal validation loop

On stop:

1. stop acquisition/poll work
2. stop/reject scheduler work cleanly
3. close transport
4. publish disconnected state as required by the shared lifecycle

Start/stop must be safe to call through the lifecycle guarantees established in stream B.

## Initial supported functions

Implement the shared first-pass function set defined in `dmm-types.ts`. At minimum this should cover the normal bench functions selected for the first UI, expected to include:

- DC voltage
- AC voltage
- DC current
- AC current
- 2-wire resistance
- 4-wire resistance
- continuity
- diode
- frequency / period
- capacitance
- temperature/sensor if already included in the shared contract

If stream B deliberately leaves advanced sensor details out of the first contract, do not expand scope here.

## Range and rate

Implement exact DM858E-supported range control for each function. Do not expose a range value that the selected function cannot use.

Implement the documented rate/resolution relationship faithfully:

- Slow -> 5.5 digit
- Medium -> 4.5 digit
- Fast -> 4.5 digit

Do not claim the DM858E performs 5.5-digit readings at its 80 readings/s maximum.

## Reading acquisition

Start with the simplest specification-correct primary reading acquisition mechanism that works reliably.

Do not prematurely optimize toward 80 readings/s by inventing buffering behaviour not verified by the Programming Guide or device.

Keep acquisition behind a small internal boundary so integration can replace repeated single queries with a buffered/triggered strategy later if real-device benchmarking shows that is materially better.

Reading publication should include enough information for the frontend to display a stable value and unit without parsing SCPI text.

## State reconciliation

The physical instrument is authoritative.

For discrete controls initiated by the web UI, perform useful readback/reconciliation rather than assuming the write succeeded.

For physical front-panel changes, use the smallest sensible periodic state validation strategy. Do not poll every possible meter setting at high rate.

If exact front-panel-change detection cannot be established without the physical instrument, keep that item clearly isolated for integration rather than guessing.

## Raw SCPI

Raw SCPI console operations must use the same scheduler as normal DMM operations. Nothing may write directly to the socket around the scheduler.

## Tests

Use typed fake transports/drivers as appropriate. Cover:

- IDN parsing/validation
- function command mappings
- range command mappings and invalid combinations
- rate/resolution mappings
- reading parsing including scientific notation and instrument sentinel/error values if documented
- startup initial state
- control write + readback behaviour
- scheduler use for raw SCPI
- stop during active acquisition
- reconnect/failure path expected by the shared runtime lifecycle

Run:

```text
pnpm typecheck
pnpm test
pnpm build
```

## Completion criteria

This stream is complete when a fake/specification-backed DM858E can connect through the real generic SCPI layer, publish primary readings/state, accept the first-pass controls and satisfy the shared browser protocol without any frontend implementation.

Real-device throughput tuning belongs to integration.
