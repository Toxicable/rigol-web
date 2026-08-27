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

For temperature, the driver reads `UNIT:TEMPerature?`. The Programming Guide defines the returned unit as `C`, `F`, or `K`. Browser-facing primary temperature readings are normalized to Celsius because the first shared DMM contract exposes `DmmUnit.Celsius`, not an arbitrary temperature-unit field.

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

AC voltage/current speed is represented through the `CONFigure` resolution relationship from Table 3.14. The first implementation keeps the selected Auto/fixed range while changing that resolution.

The first shared state requires an acquisition-rate value even for functions where the Programming Guide does not expose this three-rate control. For continuity, diode, frequency, period, capacitance and temperature, the backend preserves the last meaningful shared rate in state and rejects rate writes instead of claiming to configure an unsupported control.

## Primary reading acquisition

The first backend uses `DATA:LAST?` for the live primary value.

This is intentional: `READ?` starts a measurement group and waits for the requested trigger/results, while `DATA:LAST?` asks for the last performed measurement. Using `DATA:LAST?` therefore avoids silently changing the meter's front-panel trigger workflow just to refresh the browser display.

The Programming Guide defines the normal `DATA:LAST?` return as measurement data plus measurement function, and separately defines the bare numeric response `9.90000000E+37` when **no measurement data is available**. The backend therefore suppresses only a bare sentinel response. A sentinel-sized reading that also carries the normal measurement-function suffix is represented as `DmmReadingKind.Overload` so an overrange/open-circuit condition does not leave the browser displaying an earlier valid reading. The exact real-instrument suffix spellings for every function remain part of physical integration verification.

The initial poll cadence is deliberately conservative and simple:

- primary-reading check: 100 ms;
- state/front-panel validation: 500 ms.

This is not a claim of 10 readings/s effective acquisition or an optimized path. Real-device throughput, duplicate-last-reading behavior and any buffered/triggered replacement belong to DM858E integration benchmarking.

## Raw SCPI

Raw SCPI commands use the same per-instrument `ScpiScheduler` as state, controls and readings. Nothing writes around the scheduler directly.

After a raw SCPI operation, the runtime performs an authoritative state readback because the raw command may have changed function, range, rate or temperature unit.

## Integration verification still required

The physical DM858E integration stream must verify at minimum:

- LAN SCPI port/connection behavior;
- exact real-instrument response spelling for every supported state query;
- exact `DATA:LAST?` function suffixes and overload/open-circuit forms for every supported measurement function;
- `DATA:LAST?` duplicate/update behavior at Slow/Medium/Fast rates;
- sustained acquisition throughput and whether a buffered/triggered strategy materially improves it;
- front-panel changes while the browser is subscribed;
- temperature/sensor combinations beyond the first shared function selector.
