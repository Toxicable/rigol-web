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

For temperature, the driver reads `UNIT:TEMPerature?`. The Programming Guide defines the returned unit as `C`, `F`, or `K`. Browser-facing temperature snapshots are normalized to Celsius because the first shared DMM contract exposes `DmmUnit.Celsius`. Temperature snapshot transactions re-read the unit so a front-panel unit change cannot be converted using an older cached unit.

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

AC voltage/current speed is represented through the `CONFigure` resolution relationship from Table 3.14. The effective-range query required for Auto mode and the matching `CONFigure:*` write run inside one scheduler operation.

Continuity, diode, frequency, period, capacitance and temperature do not expose the shared three-rate control, so their `acquisitionRate` state is `null` and rate writes are rejected.

## Latest-reading snapshot

The browser display path uses `DATA:LAST?` as a **latest-reading snapshot**, not as a stream of uniquely identified samples.

This boundary is deliberate. The Programming Guide defines:

- `DATA:LAST?` as the last performed measurement data plus measurement function;
- `DATA:POINts?` as the number of readings currently stored in reading memory;
- `DATA:REMove?` / `R?` as consuming/removing stored readings;
- DM858E reading memory as limited to 20,000 readings, after which new readings overwrite the oldest.

Those commands do not provide a coherent sample identity when queried independently. In particular, a point-count change cannot safely be paired with a separately queried `DATA:LAST?`, and raw SCPI can change the reading-memory count without creating a measurement. The backend therefore does **not** use `DATA:POINts?` to infer freshness and does not attach a browser sequence number to `DATA:LAST?`.

A stable current snapshot can be published immediately, including an existing stopped/single-trigger reading present when the route first subscribes. The poller may suppress a byte-for-byte equivalent snapshot to reduce WebSocket traffic, but this is only display deduplication; it is not a claim that a new physical sample did or did not occur.

Host-side sample count, statistics and trend calculations must wait for a separately verified acquisition path that establishes one event per physical measurement. They must not infer samples from snapshot polling cadence or snapshot changes.

### Snapshot validity

Each snapshot observation is one scheduler operation and reads:

- `STATus:OPERation:CONDition?` before and after;
- `SENSe:FUNCtion?` before and after `DATA:LAST?`;
- `DATA:LAST?`;
- `UNIT:TEMPerature?` inside the same transaction when temperature is active.

Operation Status bit 8 (`256`) is documented as **Configuration change**. If that bit is present, the function changes during the transaction, or the authoritative function no longer matches the state snapshot used by the poller, the observation is discarded and retried later rather than being labelled with stale state.

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

Under the runtime mutation queue, a function-dependent request:

1. reads authoritative current DMM state;
2. rejects the request if its expected function no longer matches;
3. verifies the control is applicable to that function;
4. enters the driver write operation;
5. re-reads `SENSe:FUNCtion?` inside that same scheduler operation immediately before the physical write;
6. rejects instead of writing if the front panel changed function in the meantime;
7. performs authoritative state readback after a successful write.

This prevents a stale range value from being reinterpreted under another function and prevents a stale AC-rate `CONFigure:*` request from restoring an old AC function.

Function-change requests themselves are not function-bound because selecting a new function is their explicit intent.

## Raw SCPI

Raw-SCPI mutations share the runtime mutation queue because they may alter DMM state. After a raw command/query, the runtime performs authoritative state readback.

Program-message validation and command/query classification are generic SCPI infrastructure in `src/server/scpi/scpi-program-message.ts` and are shared by the DHO804 and DM858E drivers. The classifier rejects empty/multiline messages and detects query markers outside SCPI quoted strings.

## Integration verification still required

Physical DM858E integration must verify at minimum:

- LAN SCPI port/connection behavior;
- exact real-instrument response spelling for every supported state query;
- exact `DATA:LAST?` function suffixes beyond the guide's `VDC` example;
- a measurement-correlated overload/open-circuit representation for every supported function;
- a coherent acquisition path if the frontend needs sample count/statistics/trends rather than only latest-value display;
- sustained acquisition throughput for that future sample path;
- front-panel changes while the browser is subscribed;
- temperature/sensor combinations beyond the first shared function selector.
