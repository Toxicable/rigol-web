# DM858E C — Backend / Driver

Status: **In progress — draft PR #9 (`dm858e-backend`)**.

Implementation/specification notes: `../dm858e-scpi.md`.

## Audience

This workstream starts after `dm858e-instrument-foundation.md` is complete and merged. It may proceed in parallel with `dm858e-frontend.md`.

Implement the real DM858E server-side behaviour against the shared contracts established by stream B. If a shared contract cannot represent specification-correct behaviour, make a hard-cut contract correction and update all consumers rather than adding placeholders or compatibility shims.

The backend review found three such cross-stream corrections that are now part of this workstream:

- latest `DATA:LAST?` display state is a snapshot, not a uniquely identified sample stream;
- range/rate non-applicability is explicit as `null`, not fabricated Auto/previous values;
- range/rate control messages carry the expected measurement function so stale UI intent can be rejected.

## Read before changing code

- `docs/dm858e-ui-plan.md`
- `docs/dm858e-scpi.md`
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
- publish latest-reading display snapshots
- set measurement function
- set Auto/fixed range where supported
- set Slow/Medium/Fast acquisition rate/resolution where supported
- reject stale function-dependent controls
- execute raw SCPI through the same scheduler/runtime serialization
- notice relevant front-panel state changes through a simple validation/readback strategy

No logging is included.

## Source layout

Primary ownership:

```text
src/server/dmm/dm858e-driver.ts
src/server/dmm/dmm-runtime.ts
src/server/dmm/dmm-state-store.ts
src/server/dmm/dmm-poller.ts
src/server/dmm/**/*.test.ts
```

Use the generic `ScpiTransport`, `ScpiScheduler` and shared SCPI program-message classifier; do not create a second DMM-specific transport/parser implementation.

Shared protocol/type and minimal browser-consumer edits are allowed when required by a genuine hard-cut contract correction. Frontend feature implementation remains stream D.

## Driver boundary

`Dm858eDriver` owns:

- exact SCPI command strings
- exact query response parsing
- Rigol-specific enum/string conversions
- model/identity validation
- function/range/rate mappings
- latest-reading snapshot acquisition commands
- immediate physical-function validation before function-dependent writes

Rigol-native response syntax should stop at this boundary. The runtime and browser use shared typed DMM values.

## Runtime lifecycle

The runtime must be dormant until activated by the instrument registry/subscription layer.

On start:

1. create/connect transport
2. create/use scheduler
3. query identity
4. reject an unexpected model clearly
5. read initial state
6. publish connected state
7. begin latest-reading snapshot acquisition and minimal validation loop

On stop:

1. stop acquisition/poll work
2. stop/reject scheduler work cleanly
3. close transport
4. publish disconnected state as required by the shared lifecycle

Start/stop must be safe to call through the lifecycle guarantees established in stream B.

## Initial supported functions

Implement the shared first-pass function set defined in `dmm-types.ts`:

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
- temperature

Advanced sensor configuration remains outside this first contract.

## Range and rate

Implement exact DM858E-supported range control for each function. Do not expose a range value that the selected function cannot use; shared state uses `range: null` for non-applicable functions.

Implement the documented rate/resolution relationship faithfully:

- Slow -> 5.5 digit
- Medium -> 4.5 digit
- Fast -> 4.5 digit

Functions that do not expose the shared three-rate control use `acquisitionRate: null`.

Do not claim the DM858E performs 5.5-digit readings at its 80 readings/s maximum.

Range/rate controls are function-bound. The request carries its expected measurement function, the runtime checks authoritative state under mutation ownership, and the driver checks `SENSe:FUNCtion?` again immediately before the physical write. A stale request fails rather than being reinterpreted or switching the meter back to an old function.

## Reading acquisition

The first path uses the simplest specification-correct **latest-reading snapshot** mechanism for the browser display.

`DATA:LAST?` does not establish sample identity. Do not combine `DATA:POINts?` and `DATA:LAST?` to fabricate one: the queries are asynchronous, reading-memory count can be changed by consuming commands, and the count saturates at the DM858E memory limit.

The current snapshot contract therefore has no sample sequence. It can publish an existing stable stopped/single-trigger value immediately and can explicitly publish unavailable state so a previous number does not look current.

Keep a future sample-acquisition boundary separate. Host statistics/trend require a specification/device-verified one-event-per-measurement stream and must not be derived from snapshot polling.

Do not prematurely optimize toward 80 readings/s by inventing buffering behaviour not verified by the Programming Guide or device.

## State reconciliation

The physical instrument is authoritative.

For discrete controls initiated by the web UI, perform authoritative readback/reconciliation rather than assuming the write succeeded.

For physical front-panel changes, use the smallest sensible periodic state validation strategy. Do not poll every possible meter setting at high rate.

Unstable snapshot observations are discarded and retried rather than published under stale function/unit state.

## Raw SCPI

Raw SCPI console operations use the same runtime mutation queue and SCPI scheduler as normal DMM operations. Nothing writes directly to the socket around them.

Program-message validation/query classification lives in generic `src/server/scpi/scpi-program-message.ts` and is shared with DHO804.

## Tests

Use typed fake transports/drivers as appropriate. Cover:

- IDN parsing/validation
- function command mappings
- range command mappings and invalid combinations
- rate/resolution mappings
- explicit null state for non-applicable controls
- latest-reading snapshot parsing including the documented no-data sentinel
- first stable stopped reading is immediately publishable
- no `DATA:POINts?` freshness inference
- stale function-dependent controls rejected before physical writes
- startup initial state
- control write + authoritative readback behaviour
- shared raw-SCPI classifier/scheduler use
- stop during active snapshot query
- reconnect/failure path expected by the shared runtime lifecycle

Run:

```text
pnpm typecheck
pnpm test
pnpm build
```

## Completion criteria

This stream is complete when a fake/specification-backed DM858E can connect through the real generic SCPI layer, publish authoritative state/latest-reading snapshots, accept/reject the first-pass controls correctly, and satisfy the shared browser protocol.

A true sample stream, measurement-correlated overload representation and real-device throughput tuning remain integration work until verified.
