# DHO804 feature gaps

Last reviewed: 2026-09-20

This is a practical gap list between the DHO804 features exposed by the current Rigol Web scope route and the DHO800 feature set. It is not intended to mirror every Utility/System setting on the instrument.

Primary hardware references:

- RIGOL DHO800 User Guide, 2025-02-13: https://www.rigol.com/dam/global/downloads/brochures/en/user-manual/oscilloscopes/DHO800_UserGuide_EN.pdf
- RIGOL DHO800/DHO900 Programming Guide, 2025-05-09, linked from: https://www.rigol.com/intl/products/oscilloscope/DHO800.html

Current implementation references:

- `src/shared/scope-types.ts`
- `src/web/components/channel-controls.tsx`
- `src/web/components/horizontal-controls.tsx`
- `src/web/components/acquisition-controls.tsx`
- `src/web/components/trigger-controls.tsx`
- `src/web/components/measurement-panel.tsx`
- `src/web/components/math-controls.tsx`

## Current major gaps

| Area | Current Rigol Web state | DHO804 capability / gap |
| --- | --- | --- |
| Cursors | Missing | Manual, Track, and XY cursor measurements are available on the scope. |
| Reference waveforms | Missing | Ref1-Ref10, save from CH1-CH4 or MATH1-MATH4, display/scale/offset controls. |
| Protocol decode | Missing | Four decode buses; Parallel, RS232/UART, I2C, SPI, and CAN decoding, including event tables. |
| Advanced trigger configuration | Mostly missing | Rigol Web identifies non-Edge trigger types but only fully configures Edge. Pulse, Slope, Video, Pattern, Duration, Timeout, Runt, Window, Delay, Setup/Hold, Nth Edge, RS232, I2C, SPI, and CAN detail is not modelled. |
| Search / navigation | Missing | Edge/pulse event search, mark table, time/search-event/segment navigation. |
| Waveform recording / playback | Missing | Scope-native waveform record and playback with interval/frame controls. |
| Pass/fail / mask testing | Missing | Mask generation/load/save, pass/fail statistics and stop/beeper/screenshot actions. |
| Histogram | Missing | Horizontal, vertical, and measurement histogram analysis. |
| DVM | Missing | Scope-native digital voltmeter analysis. |
| Frequency counter | Missing | Dedicated frequency/period/totalize counter with 3-6 digit resolution and statistics. |
| Power analysis | Missing | Scope Analyse-menu power-analysis functions are not modelled. |
| Auto scale | Missing | Scope Auto function and Auto configuration are not exposed. |
| Full automatic measurements | Partial | Rigol Web currently models 23 measurement kinds; the DHO800 exposes 41 automatic waveform parameters plus related result-table features. |
| Math operations | Partial | MATH1-MATH4 are modelled and streamed; browser editing is currently limited to +, -, ×, and ÷. Other native operators are read/display-only. |
| Channel vertical options | Partial | Enable, scale, offset, coupling, 20 MHz BW limit and basic probe ratio are present. Fine mode, unit selection, bias, channel-channel skew, label, invert, and the full probe attenuation set are not exposed. |
| Display controls | Missing | Waveform/grid display settings, intensity/persistence-related controls and other display presentation settings are not modelled. |
| Store/load | Mostly missing | Scope setup, waveform/reference data and scope-side file operations are not exposed as first-class Rigol Web features. Screenshot copy is a browser feature rather than full scope store/load support. |

## Already covered well enough for normal remote use

The current scope route already covers the core analog workflow: CH1-CH4 enable/scale/offset/coupling/bandwidth/probe ratio, Main/Roll/XY timebase selection, time/div and horizontal position, acquisition mode/averaging/memory depth, run/stop/single, live waveform display, stopped deep capture, Edge trigger controls, measurements/statistics, raw SCPI console, scope sleep, and the MATH1-MATH4 work in progress.

## Suggested implementation order

For embedded/electronics debugging, the highest-value remaining work is:

1. protocol decode plus serial trigger detail;
2. reference waveforms and cursors;
3. search/navigation and waveform recording;
4. channel invert/skew/label/full probe options;
5. pass/fail, histogram, DVM/counter and the remaining measurement set;
6. lower-priority display, storage and utility surfaces.

This ordering is about user value and does not imply protocol/API dependency order.
