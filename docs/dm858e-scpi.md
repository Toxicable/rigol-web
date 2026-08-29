# DM858E SCPI backend notes

This document records the specification-backed choices used by the first Rigol DM858E backend implementation.

Primary specification:

- Rigol, **DM858 Series Programming Guide**: https://download.rigol.com/en/Manual/Digital%20Multimeters/DM858/DM858_ProgrammingGuide_EN.pdf

The DM858 and DM858E share the command set, but they do not share every range/capability. The backend validates the DM858E subset rather than accepting the larger DM858 limits.

## Identity

The backend starts a session with `*IDN?` and requires the returned model field to be `DM858E`.

The Programming Guide documents the response as:

```text
RIGOL TECHNOLOGIES,<model>,<serial number>,<software version>
```

## Authoritative state

`CONFigure?` is the starting point for each state snapshot. It reports the current measurement function and, where applicable, range and resolution.

A state validation pass is kept inside one `ScpiScheduler` operation so an Immediate control write cannot be inserted halfway through the snapshot and produce a mixed old/new state.

For range-capable functions, the driver also reads the corresponding `RANGe:AUTO?` and `RANGe?` values so the shared state distinguishes Auto from a fixed range.

Non-applicability is explicit in the shared contract:

- `range` is `null` when the selected function has no range control;
- `acquisitionRate` is `null` when the selected function does not expose the shared Slow/Medium/Fast control.

The backend does not send placeholder Auto ranges or carry an old rate through a function where those values have no meaning.

For temperature, the driver reads `UNIT:TEMPerature?`. The Programming Guide defines the returned unit as `C`, `F`, or `K`. Browser-facing temperature values would be normalized to Celsius, but a numeric snapshot is published only when the backend also has an authoritative numeric measurement resolution for the same observation. A parameter such as `TEMP FRTD,385` is sensor configuration, not permission to treat `385` as a measurement resolution.

## Measurement function mapping

| Shared function | DM858E function token |
| --- | --- |
| DC voltage | `VOLT` / `VOLT:DC` |
| AC voltage | `VOLT:AC` |
| DC current | `CURR` / `CURR:DC` |
| AC current | `CURR:AC` |
| 2-wire resistance | `RES` |
| 4-wire resistance | `FRES` |
| Continuity | `CONT` |
| Diode | `DIOD` |
| Frequency | `FREQ` |
| Period | `PER` |
| Capacitance | `CAP` |
| Temperature | `TEMP` |

Writes use `SENSe:FUNCtion` and the Programming Guide's long-form function names.

## DM858E range set

The backend validates these fixed ranges before sending a command:

| Function | Fixed ranges |
| --- | --- |
| DC voltage | 0.1 V, 1 V, 10 V, 100 V, 1000 V |
| AC voltage | 0.1 V, 1 V, 10 V, 100 V, 750 V |
| DC current | 100 µA, 1 mA, 10 mA, 100 mA, 1 A, 3 A |
| AC current | 100 µA, 1 mA, 10 mA, 100 mA, 1 A, 3 A |
| 2-wire resistance | 100 Ω, 1 kΩ, 10 kΩ, 100 kΩ, 1 MΩ, 10 MΩ, 50 MΩ |
| 4-wire resistance | 100 Ω, 1 kΩ, 10 kΩ, 100 kΩ, 1 MΩ, 10 MΩ, 50 MΩ |
| Frequency input voltage | 0.1 V, 1 V, 10 V, 100 V, 750 V |
| Period input voltage | 0.1 V, 1 V, 10 V, 100 V, 750 V |
| Capacitance | 1 nF, 10 nF, 100 nF, 1 µF, 10 µF, 100 µF, 1 mF |

Important DM858E limits from the guide:

- the 10 A current range is DM858-only; DM858E stops at 3 A;
- the 10 mF capacitance range is DM858-only; DM858E stops at 1 mF.

Continuity, diode and temperature have no first-pass numeric `DmmRange`; their shared `range` state is `null` and range writes are rejected.

## Acquisition-rate mapping

Programming Guide Table 3.14 defines:

| Shared rate | Resolution | Integration time |
| --- | --- | --- |
| Slow | 10 ppm × range | 20 PLC |
| Medium | 100 ppm × range | 5 PLC |
| Fast | 1000 ppm × range | 0.4 PLC |

DC voltage, DC current, 2-wire resistance and 4-wire resistance expose direct `NPLC` commands, so the backend writes and reads the exact 20 / 5 / 0.4 PLC values.

AC voltage/current speed is represented through the `CONFigure` resolution relationship from Table 3.14. Because `CONFigure:* <range>,<resolution>` also writes range, an AC rate-only request must not reuse a range captured by an earlier runtime state read. Inside the same Immediate scheduler operation that will perform `CONFigure:*`, the driver samples physical `RANGe:AUTO?` mode plus effective `RANGe?` repeatedly and requires two adjacent observations to agree on both mode and effective range before constructing the command. Up to three observations are allowed so a single front-panel transition can settle; if no adjacent pair is stable, the rate write fails without sending `CONFigure:*`. The driver then re-checks the measurement function immediately before the command.

A concrete example is fixed 100 V AC Fast: Table 3.14 gives `100 V × 1e-3 = 0.1 V` configured resolution. A browser must not display a finer quantum simply because the JavaScript numeric value contains more digits.

Continuity, diode, frequency, period, capacitance and temperature do not expose the shared three-rate control, so their `acquisitionRate` state is `null` and rate writes are rejected.

## Latest-reading snapshot

The browser display path uses `DATA:LAST?` as a **latest-reading snapshot**, not as a stream of uniquely identified samples.

This boundary is deliberate. The Programming Guide defines:

- `DATA:LAST?` as the last performed measurement data plus measurement function;
- `DATA:POINts?` as the number of readings currently stored in reading memory;
- `DATA:REMove?` / `R?` as consuming/removing stored readings;
- DM858E reading memory as limited to 20,000 readings, after which new readings overwrite the oldest.

Those commands do not provide a coherent sample identity when queried independently. In particular, a point-count change cannot safely be paired with a separately queried `DATA:LAST?`, and raw SCPI can change the reading-memory count without creating a measurement. The backend therefore does **not** use `DATA:POINts?` to infer freshness and does not attach a browser sequence number to `DATA:LAST?`.

`DmmPoller` does not own a retained snapshot or dedupe baseline. It forwards every non-null sampled observation to `DmmRuntime`. `DmmRuntime.currentSnapshot` is the single server-side latest-display owner and performs display dedupe plus subscriber replay. This one-owner rule is important because runtime-generated invalidation must immediately change the same baseline used for later dedupe.

A stable current snapshot can be published immediately, including an existing stopped/single-trigger reading present when the route first subscribes. When another browser session subscribes while that runtime is already active, the runtime republishes `currentSnapshot`, so a second tab or reconnecting browser receives the current stopped/stable display without restarting the instrument session.

Snapshot state is session-scoped. Disconnect, stop, transport failure and session replacement clear the retained snapshot before a later session can replay anything.

Every real `DmmStateStore` change invalidates a retained snapshot immediately, including same-function range or acquisition-rate changes. The runtime replaces `currentSnapshot` with `DmmReadingKind.Unavailable` / `ConfigurationChanged`, publishes the new state, then publishes the invalidation. Equivalent state replacements are suppressed by `DmmStateStore`, so unchanged periodic polls do not blank a valid reading.

Because the invalidation updates the same runtime baseline used for dedupe, the next valid numeric reading is published even if its numeric value equals the pre-change value. There is no second poller cache that can suppress it.

Host-side sample count, statistics and trend calculations must wait for a separately verified acquisition path that establishes one event per physical measurement. They must not infer samples from snapshot polling cadence or snapshot changes.

### Snapshot validity and resolution ownership

Each snapshot observation is one scheduler operation and reads:

1. `STATus:OPERation:CONDition?` before;
2. `CONFigure?` before;
3. `SENSe:FUNCtion?` before;
4. `DATA:LAST?`;
5. `SENSe:FUNCtion?` after;
6. `CONFigure?` after;
7. `UNIT:TEMPerature?` in the same transaction when temperature is active;
8. `STATus:OPERation:CONDition?` after.

The before/after function must remain stable and match the function expected by the poller. The raw before/after `CONFigure?` response must also remain stable. A function or configuration transition during the observation returns no snapshot because the numeric value cannot safely be attributed to one configuration context.

Operation Status bit 8 (`256`) is documented as **Configuration change**. If bit 8 is present while function/configuration ownership is stable, the driver publishes `Unavailable/ConfigurationChanged` rather than a numeric value.

Protocol version 4 makes numeric display resolution part of the snapshot contract:

```ts
{
  kind: DmmReadingKind.Value,
  function,
  value,
  resolution,
  unit,
}
```

`resolution` is a positive finite measurement quantum authoritative for that stable observation. The browser rounds `value` to this quantum before engineering-prefix formatting. It does not reconstruct precision from digit class, acquisition-rate labels, numeric magnitude or `DmmState.range`.

This also closes the Auto-range problem. Shared `DmmState.range` intentionally remains `{ mode: Auto }`, but the stable `CONFigure?` observation can still carry the effective configuration range/resolution. The numeric snapshot transports the resulting resolution quantum directly, so the browser does not need to guess which physical range Auto selected.

The driver only emits a numeric `Value` when it can identify a trustworthy numeric resolution from that stable configuration observation. If it cannot, it publishes `Unavailable/ResolutionUnavailable` rather than fabricate precision. In particular, sensor configuration parameters such as the `385` in `TEMP FRTD,385` are not treated as measurement resolution. Continuity/diode/temperature therefore remain explicitly unavailable on the numeric display until a specification-backed or physically verified numeric resolution source is added.

Runtime dedupe includes `resolution` as well as numeric `value`: an equal numeric value observed at a different resolution is a changed display snapshot and must be published.

The Programming Guide gives `VDC` as an explicit `DATA:LAST?` function-token example. The backend does not invent other spellings. Unknown suffixes are treated as opaque and associated with a function only while `SENSe:FUNCtion?` is stable and authoritative; a token later observed under a different function is rejected.

### No-data and overload

The Programming Guide documents the **bare** numeric response `9.90000000E+37` when `DATA:LAST?` has no available measurement data. The backend publishes an explicit `Unavailable/NoData` snapshot for that condition so the UI does not leave a previous numeric value looking current.

The guide does not document a suffixed `DATA:LAST?` sentinel as overload. A sentinel-sized suffixed response is therefore represented as `Unavailable/UnclassifiedSentinel`, not guessed to be overload.

The Questionable Data register has documented overload event bits, but the event register is asynchronous to `DATA:LAST?` and is clear-on-read. The background poller therefore does not query `STATus:QUEStionable:EVENt?`; explicit raw SCPI remains free to inspect it with its documented semantics.

`DmmReadingKind.Overload` remains available in the shared contract for a future measurement-correlated mechanism, but this backend does not emit it without specification or physical-device evidence that ties the overload condition to the reported measurement.

The initial cadence remains:

- latest-reading snapshot observation: 100 ms;
- full state/front-panel validation: 500 ms.

This is not a claim of 10 samples/s effective acquisition.

## Function-bound controls

Multiple browser tabs can share one DM858E runtime. Range and acquisition-rate values are function-dependent, so those requests carry the measurement function under which the UI created them.

Every browser mutation is also bound to the active DMM session at the moment it is enqueued. The runtime mutation queue re-checks that exact session before the queued operation is allowed to execute. If the instrument disconnects, the route stops, or a reconnect creates a replacement session while a request is waiting behind another mutation, the stale queued request is rejected before any SCPI reaches the replacement session. This applies to normal controls and raw SCPI alike; queued work is never replayed across reconnect.

Under the runtime mutation queue, a function-dependent request:

1. captures the active DMM session before entering the queue;
2. verifies that the captured session is still current when it reaches the front of the queue;
3. reads authoritative current DMM state;
4. rejects the request if its expected function no longer matches;
5. verifies the control is applicable to that function;
6. enters the driver write operation;
7. re-reads `SENSe:FUNCtion?` inside that same scheduler operation before deriving the write;
8. rejects instead of writing if the front panel changed function in the meantime;
9. for AC rate changes, samples physical Auto/fixed mode and effective range until two adjacent observations agree, retrying within a three-observation bound;
10. rejects the rate write without `CONFigure:*` if the range state does not stabilize;
11. re-checks `SENSe:FUNCtion?` immediately before `CONFigure:*`;
12. performs authoritative state readback after a successful write.

This prevents a stale range value from being reinterpreted under another function, prevents a stale AC-rate `CONFigure:*` request from restoring an old AC function, prevents a rate-only change from overwriting a newer same-function front-panel range choice or a mixed Auto/fixed observation created while the front panel is changing, and prevents queued mutations from crossing a DMM reconnect/session boundary.

Function-change requests themselves are not function-bound because selecting a new function is their explicit intent, but they are still session-bound at queue entry.

## Raw SCPI

Raw-SCPI mutations share the runtime mutation queue because they may alter DMM state. Each raw request captures the active session before entering that queue and is rejected if that session has been replaced before execution. After a raw command/query that executes successfully, the runtime performs authoritative state readback.

Program-message validation and command/query classification are generic SCPI infrastructure in `src/server/scpi/scpi-program-message.ts` and are shared by the DHO804 and DM858E drivers. The classifier rejects empty/multiline messages and detects query markers outside SCPI quoted strings.

## Integration verification still required

Physical DM858E integration must verify at minimum:

- LAN SCPI port/connection behavior;
- exact real-instrument response spelling for every supported state query;
- exact `DATA:LAST?` function suffixes beyond the guide's `VDC` example;
- `CONFigure?` effective range/resolution behavior under fixed and Auto range for every function that currently emits numeric snapshots;
- whether continuity, diode and temperature expose a separate authoritative numeric resolution source suitable for enabling numeric browser display;
- a measurement-correlated overload/open-circuit representation for every supported function;
- a coherent acquisition path if the frontend needs sample count/statistics/trends rather than only latest-value display;
- sustained acquisition throughput for that future sample path;
- front-panel changes while the browser is subscribed;
- temperature/sensor combinations beyond the first shared function selector.
