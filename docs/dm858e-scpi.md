# DM858E SCPI backend notes

This document records the specification-backed choices used by the first Rigol DM858E backend implementation.

Primary specification:

- Rigol, **DM858 Series Programming Guide**: https://download.rigol.com/en/Manual/Digital%20Multimeters/DM858/DM858_ProgrammingGuide_EN.pdf

The DM858 and DM858E share the command set, but they do not share every range/capability. The backend validates the DM858E subset rather than accepting the larger DM858 limits.

## Identity

The backend starts a session with `*IDN?` and requires the returned model field to be `DM858E`.

The programming guide documents the response as:

```text
RIGOL TECHNOLOGIES,<model>,<serial number>,<software version>
```

See `*IDN?` in the IEEE 488.2 common-command section of the programming guide.

## Authoritative state

`CONFigure?` is the starting point for each state snapshot. It reports the current measurement function and, where applicable, range and resolution.

A state validation pass is kept inside one `ScpiScheduler` operation so an Immediate control write cannot be inserted halfway through the snapshot and produce a mixed old/new state.

For range-capable functions, the driver also reads the corresponding `RANGe:AUTO?` and `RANGe?` values so the shared state distinguishes Auto from a fixed range.

For temperature, the driver reads `UNIT:TEMPerature?`. The Programming Guide defines the returned unit as `C`, `F`, or `K`. Browser-facing primary temperature readings are normalized to Celsius because the first shared DMM contract exposes `DmmUnit.Celsius`, not an arbitrary temperature-unit field. Temperature primary-reading transactions re-read the unit so a front-panel unit change cannot make the browser convert with an older cached unit.

## Measurement function mapping

The first shared contract maps to these DM858E functions:

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

Continuity, diode and temperature do not use the first-pass numeric `DmmRange` control. Until the shared contract grows a separate not-applicable state, these functions carry the Auto-shaped range value as a protocol placeholder and the backend rejects range writes for them.

## Acquisition-rate mapping

Programming Guide Table 3.14 defines:

| Shared rate | Resolution | Integration time |
| --- | --- | --- |
| Slow | 10 ppm × range | 20 PLC |
| Medium | 100 ppm × range | 5 PLC |
| Fast | 1000 ppm × range | 0.4 PLC |

DC voltage, DC current, 2-wire resistance and 4-wire resistance expose direct `NPLC` commands, so the backend writes and reads the exact 20 / 5 / 0.4 PLC values.

AC voltage/current speed is represented through the `CONFigure` resolution relationship from Table 3.14. The range query required for Auto mode and the matching `CONFigure:*` write run inside one scheduler operation so no other SCPI operation can be inserted between those two steps.

The first shared state requires an acquisition-rate value even for functions where the Programming Guide does not expose this three-rate control. For continuity, diode, frequency, period, capacitance and temperature, the backend preserves the last meaningful shared rate in state and rejects rate writes instead of claiming to configure an unsupported control.

## Primary reading acquisition

The first backend uses `DATA:LAST?` for the live primary value.

This is intentional: `READ?` starts a measurement group and waits for the requested trigger/results, while `DATA:LAST?` asks for the last performed measurement. Using `DATA:LAST?` avoids silently changing the meter's front-panel trigger workflow just to refresh the browser display.

The Programming Guide defines normal `DATA:LAST?` output as measurement data plus measurement function and gives `-5.07000000E-01 VDC` as its example. It separately defines the **bare** numeric response `9.90000000E+37` when no measurement data is available. The backend therefore treats only the bare documented form as no data and does not infer an overload encoding from a suffixed `9.9E37` value.

Each primary-reading observation is one scheduler operation and also reads:

- `STATus:OPERation:CONDition?` before and after the observation;
- `SENSe:FUNCtion?` before and after `DATA:LAST?`;
- `DATA:POINts?` before `DATA:LAST?`;
- `UNIT:TEMPerature?` inside the same transaction when temperature is active.

Operation Status bit 8 (`256`) is documented as **Configuration change**: the configuration has changed since the last measurement and reading, whether from the front panel or SCPI. If this bit is present, the function changes during the transaction, or the authoritative function no longer matches the state snapshot used by the poller, that observation is suppressed rather than being published with a stale unit.

The Programming Guide only gives `VDC` as an explicit `DATA:LAST?` function-token example. The backend does not invent the other token spellings. Unknown tokens are treated as opaque and are associated with a function only while `SENSe:FUNCtion?` is stable and authoritative; a token later observed under a different function is rejected.

### Freshness and sequence numbers

`DATA:LAST?` is a last-value query, not proof that a new measurement occurred. The driver therefore establishes a baseline on the first observation and publishes only when there is evidence of a new measurement since the prior observation:

- `DATA:POINts?` changed; or
- the complete `DATA:LAST?` response changed.

Repeated polling of the same last measurement therefore returns no browser reading and does not advance the browser sequence number. This is deliberately conservative: if reading-memory count does not change and two legitimate consecutive measurements have exactly the same returned text, the first backend may under-count rather than fabricate a fresh sample. Integration can replace this observation strategy with a verified buffered/consuming acquisition path if the physical meter shows that is necessary.

### Overload remains UNKNOWN

The Questionable Data register contains documented overload event bits, but its event register is asynchronous to `DATA:LAST?`: the Programming Guide does not associate a latched event with a particular reading. `STATus:QUEStionable:EVENt?` also clears the latched event register when queried. The background poller therefore **does not query that register** and does not use it to classify an individual primary reading.

This is intentionally conservative. A latched overload may have come from an earlier measurement than the current `DATA:LAST?` value, especially at Fast acquisition rates where several measurements can occur between browser polls. Consuming the event register in the poller would also make those status events disappear before an explicit raw-SCPI query could inspect them.

For the current `DATA:LAST?` path:

- bare `9.90000000E+37` is the documented no-data form and is suppressed;
- a sentinel-sized value carrying a suffix has no documented `DATA:LAST?` meaning and is also suppressed;
- `DmmReadingKind.Overload` is not emitted until a measurement-correlated overload mechanism is established from the specification or physical-device verification;
- explicit raw SCPI remains free to query `STATus:QUEStionable:EVENt?` and accept its documented clear-on-read semantics.

The initial poll cadence remains:

- primary-reading observation: 100 ms;
- full state/front-panel validation: 500 ms.

This is not a claim of 10 readings/s effective acquisition or an optimized path.

## Control and raw-SCPI serialization

Multiple browser tabs may share one active DM858E runtime. A logical mutation therefore has to be serialized beyond the individual SCPI messages.

The runtime serializes each control request from prerequisite state through write and authoritative readback before another control or raw-SCPI mutation can begin. This prevents two clients from both reporting success after interleaving stale prerequisite state. Raw SCPI uses the same mutation queue because it may also change instrument state.

All individual SCPI operations still use the same per-instrument `ScpiScheduler`; nothing writes directly around it.

After a raw SCPI operation, the runtime performs an authoritative state readback because the raw command may have changed function, range, rate or temperature unit.

## Integration verification still required

The physical DM858E integration stream must verify at minimum:

- LAN SCPI port/connection behavior;
- exact real-instrument response spelling for every supported state query;
- exact `DATA:LAST?` function suffixes beyond the guide's `VDC` example;
- reading-memory point-count behaviour during ordinary front-panel continuous measurement and at memory saturation;
- a measurement-correlated overload/open-circuit representation for every supported function, including any real `DATA:LAST?` sentinel forms;
- sustained acquisition throughput and whether a buffered/triggered strategy materially improves it;
- front-panel changes while the browser is subscribed;
- temperature/sensor combinations beyond the first shared function selector.
