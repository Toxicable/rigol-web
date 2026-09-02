# DM858E control-surface gap audit

Date: 2026-09-02

## Summary

RigolWeb currently exposes all 12 primary DM858E measurement functions plus Auto/fixed range and the shared Slow/Medium/Fast acquisition-rate control. That is only a subset of the DM858E's documented remote-control surface.

The original `docs/dm858e-ui-plan.md` also called for optional secondary measurement, trigger source, samples per trigger, and function-specific settings. Those controls are not present in the current shared `DmmState` / `DmmControlChange` contract or `/dm858e` controls.

Incremental hardware/package cost for completing these software controls is **A$0**.

## Implemented today

- DC voltage
- AC voltage
- DC current
- AC current
- 2-wire resistance
- 4-wire resistance
- continuity
- diode
- frequency
- period
- capacitance
- temperature
- Auto/fixed range where the current function exposes a documented range
- shared Slow/Medium/Fast rate control where the current function exposes the existing rate model
- latest-reading snapshot display and browser-side snapshot trend
- raw SCPI console

## Missing documented control groups

### 1. Trigger and explicit acquisition control

Programming Guide commands exist for:

- `TRIGger:SOURce {IMMediate|BUS|EXTernal}`
- `TRIGger:COUNt` — 1 to 1000 triggers in Bus/single-trigger mode
- `SAMPle:COUNt` — 1 to 2000 measurements per trigger
- `OUTPut:TRIGger:SLOPe {POSitive|NEGative}`
- `INITiate[:IMMediate]`
- `ABORt`
- `*TRG`
- `READ?`, `FETCh?`, `R?`

The initial UI plan explicitly requested trigger source and samples per trigger, but the current DMM shared state has no trigger/acquisition model.

### 2. Relative / NULL

The Programming Guide documents per-function relative controls using `SENSe:<function>:NULL:*` for capacitance, AC/DC current, frequency, period, 2-wire/4-wire resistance, and AC/DC voltage. The common operations are:

- enable/disable relative mode
- set/query relative value
- auto-capture the relative value

The Programming Guide's math table also says sensor measurements support Relative, but the command reference does not document `TEMPerature:NULL:*`. Do not invent a temperature-relative SCPI mapping until that mismatch is verified on the physical DM858E or in a newer authoritative guide.

Continuity and diode are explicitly excluded from the documented math table.

### 3. Instrument math

The DM858E exposes instrument-side math that is independent of any future host sample stream:

- Statistics: average, standard deviation, minimum, maximum and count
- Limit test: lower/upper limits and limit state
- dBm: voltage only
- dB: voltage only
- clear/reset math state

The Programming Guide states the supported matrix as:

- DCV/ACV: Statistics, Limit, dBm, dB, Relative
- DCI/ACI: Statistics, Limit, Relative
- 2WR/4WR: Statistics, Limit, Relative
- CAP: Statistics, Limit, Relative
- SENSOR: Statistics, Limit, Relative
- FREQ/PER: Statistics, Limit, Relative
- CONT/DIODE: none

This is different from host-side statistics computed from the existing latest-snapshot polling path. Instrument statistics can be surfaced without pretending snapshots are unique physical samples.

### 4. Secondary measurement

The Programming Guide provides function-specific `SENSe:<function>:SECondary` controls and `SENSe:DATA2?` for the second reading.

Important documented combinations include:

- AC voltage secondary: Off, pre-math primary (`CALCulate:DATA`), Frequency, Period
- Frequency/Period secondary: Off, pre-math primary, AC voltage
- DC voltage/current and resistance functions: Off or pre-math primary
- other functions must follow their exact command-specific allowed set; do not generalize combinations across functions

The DM858E capability record in `Toxicable/toxic-boards` notes the 7-inch UI supports concurrent dual-measurement display, and the original RigolWeb UI plan already reserved an optional secondary reading.

### 5. Temperature probe configuration

`CONFigure:TEMPerature` / `MEASure:TEMPerature?` support documented probe configuration:

- 4-wire RTD: coefficients 385, 389, 391, 392
- 2-wire RTD: coefficients 385, 389, 391, 392
- 4-wire thermistor: 2.2 kΩ, 3 kΩ, 5 kΩ, 10 kΩ, 30 kΩ
- 2-wire thermistor: 2.2 kΩ, 3 kΩ, 5 kΩ, 10 kΩ, 30 kΩ
- thermocouple: B, E, J, K, N, R, S, T
- `UNIT:TEMPerature {C|F|K}`

The current shared state only reports `Temperature` as a function and normalizes the browser-facing value to Celsius. It does not expose the probe type/configuration or selectable display unit.

### 6. Reading memory / finite acquisition

The DM858E has a documented 20,000-reading volatile reading memory. Relevant commands include:

- `DATA:POINts?`
- `DATA:REMove?`
- `R?`
- `READ?`
- `FETCh?`
- `MMEMory:STORe:DATA`

This is the correct area to investigate for explicit finite acquisitions and data export. It must remain separate from the current `DATA:LAST?` display-snapshot contract until sample identity/consumption semantics are deliberately defined and tested.

## Front-panel features that are not automatically SCPI features

The User Guide/capability record also describes features such as adjustable continuity threshold, reading hold, histogram/bar/trend display, and user-defined sensors. The current Programming Guide command index does not expose a documented continuity-threshold or HOLD command. Do not create undocumented commands merely to mirror the front panel.

Host-side histogram/bar/trend can be implemented once the acquisition contract supplies unique samples. The existing browser trend is a rolling history of latest-reading snapshots, not a verified one-event-per-measurement stream.

## Recommended implementation order

1. **Trigger/acquisition state** — trigger source, sample count, trigger count, external slope, explicit trigger/abort.
2. **Relative/NULL** — high-value everyday bench function with a straightforward per-function SCPI mapping.
3. **Secondary measurement** — add typed function-specific choices plus a secondary-reading snapshot.
4. **Instrument math** — statistics/limits first, then dB/dBm for voltage.
5. **Temperature probe configuration** — parse and expose the existing `CONFigure?` temperature parameters instead of discarding them.
6. **Finite reading-memory acquisition/export** — design separately from the latest-reading display path.

Each control should be authoritative-state/readback driven like the existing function/range/rate controls. Keep function-bound controls carrying the function context that created them so front-panel or multi-tab changes cannot reinterpret stale writes.

## Sources

- Rigol DM858 Series Programming Guide V1.1: https://download.rigol.com/en/Manual/Digital%20Multimeters/DM858/DM858_ProgrammingGuide_EN.pdf
- Rigol DM858 Series User Guide: https://www.rigol.com/dam/global/downloads/brochures/en/user-manual/multimeters/DM858_UserGuide_EN.pdf
- `docs/dm858e-ui-plan.md`
- `docs/dm858e-scpi.md`
- `src/shared/dmm-types.ts`
- `src/shared/dm858e-capabilities.ts`
- `src/web/components/dmm/dmm-controls.tsx`
- Toxicable/toxic-boards `docs/lab-gear/rigol-dm858e-capabilities.md`
