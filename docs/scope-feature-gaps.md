# DHO804 feature gaps

Last reviewed: 2026-09-20

This is a practical gap list for the Rigol Web scope route. The goal is not to mirror every DHO804 menu. Prefer scope-backed features when they affect acquisition/instrument state, and browser-native features when the browser can provide a better interaction or presentation without changing the instrument.

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
- `src/web/waveform/waveform-plot.tsx`
- `src/web/waveform/waveform-cursor-overlay.tsx`
- `src/web/waveform/waveform-cursors.ts`

## Product direction

Do not assume a useful oscilloscope workflow must be implemented through a native scope feature.

Browser-owned presentation and analysis are preferred when they are simpler and more useful than remotely driving the matching front-panel feature. Examples include plot markers/cursors, trace visibility indicators, labels/legends, screenshots, and view-local analysis.

Scope-owned implementation remains preferable for features whose correctness depends on acquisition-time data or hardware state, such as trigger configuration, protocol decode, acquisition modes, native math, and deep waveform capture.

## Rigol Web-native gaps

| Area | Current state | Desired behavior |
| --- | --- | --- |
| Plot markers / cursors | Covered | Browser-only cursor mode. `C` or the toolbar arms it; hover snaps a dotted X/Y crosshair to the nearest delivered CH/MATH sample, clicks place A then B, and A/B handles can be dragged while armed. The compact readout retains source, X and Y plus Δt, 1/Δt and same-unit Δy. `Escape` disarms without clearing markers. No DHO cursor SCPI is used. Incremental hardware/software purchase cost: A$0. |
| Offscreen trace indication | Partial | Current CH reference markers clamp to the top/bottom edge and show an arrow when the channel reference is offscreen. Also detect delivered trace samples outside the visible Y range and clearly indicate an enabled trace is above/below the plot. |
| Channel labels / legend | Missing | User-visible names such as `VCC`, `Gate`, or `Current`. Labels should appear next to CH identity in controls and in a compact plot/screenshot legend. Treat presentation labels as Rigol Web metadata unless a concrete need to mirror the scope label is identified. |
| Math remove/reset UX | Covered | Reset disables the fixed MATH slot and restores `A + B`, CH1/CH2, scale 1 and offset 0. Reset is blocked while any later MATH slot consumes the target, including disabled dependents, so stored configurations are not silently broken. |

## Scope-backed major gaps

| Area | Current Rigol Web state | DHO804 capability / gap |
| --- | --- | --- |
| Reference waveforms | Missing | Ref1-Ref10, save from CH1-CH4 or MATH1-MATH4, display/scale/offset controls. |
| Protocol decode | Missing | Four decode buses; Parallel, RS232/UART, I2C, SPI, and CAN decoding, including event tables. |
| Advanced trigger configuration | Mostly missing | Rigol Web identifies non-Edge trigger types but only fully configures Edge. Pulse, Slope, Video, Pattern, Duration, Timeout, Runt, Window, Delay, Setup/Hold, Nth Edge, RS232, I2C, SPI, and CAN detail is not modelled. |
| Search / navigation | Missing | Edge/pulse event search, mark table, time/search-event/segment navigation. Prefer browser-side search when complete acquisition data is already available; use the scope where only the instrument has the required acquisition context. |
| Waveform recording / playback | Missing | Scope-native waveform record and playback with interval/frame controls. |
| Pass/fail / mask testing | Missing | Mask generation/load/save, pass/fail statistics and stop/beeper/screenshot actions. |
| Histogram | Missing | Horizontal, vertical, and measurement histogram analysis. Browser-local implementations may be preferable where the required waveform data is already available. |
| DVM | Missing | Scope-native digital voltmeter analysis. |
| Frequency counter | Missing | Dedicated frequency/period/totalize counter with statistics. |
| Power analysis | Missing | Scope Analyse-menu power-analysis functions are not modelled. |
| Auto scale | Missing | Scope Auto function and Auto configuration are not exposed. |
| Full automatic measurements | Partial | Rigol Web currently models 23 measurement kinds; the DHO800 exposes more automatic waveform parameters plus related result-table features. |
| Math operations | Partial | MATH1-MATH4 are modelled and streamed; browser editing is currently limited to +, -, ×, and ÷. Other native operators are read/display-only. |
| Channel vertical options | Partial | Enable, scale, offset, coupling, 20 MHz BW limit and basic probe ratio are present. Fine mode, unit selection, bias, channel-channel skew, invert, and the full probe attenuation set are not exposed. Channel naming is tracked separately as a browser-owned presentation feature. |
| Display controls | Low priority | Scope display/intensity/persistence/grid settings are not modelled. Prefer browser rendering controls where possible instead of mirroring scope presentation state. |
| Store/load | Mostly missing | Scope setup, waveform/reference data and scope-side file operations are not exposed as first-class Rigol Web features. Screenshot capture is intentionally a browser feature. |

## Already covered well enough for normal remote use

The current scope route covers the core analog workflow: CH1-CH4 enable/scale/offset/coupling/bandwidth/probe ratio, Main/Roll/XY timebase selection, time/div and horizontal position, acquisition mode/averaging/memory depth, run/stop/single, live waveform display, stopped deep capture, Edge trigger controls, measurements/statistics, raw SCPI console, scope sleep, MATH1-MATH4 including dependency-safe reset, and local A/B waveform cursors.

## Suggested implementation order

For day-to-day electronics debugging, prioritize user value rather than scope feature parity:

1. browser-native channel labels/legend and offscreen trace indication;
2. protocol decode plus serial trigger detail;
3. reference waveforms;
4. search/navigation and waveform recording;
5. channel invert/skew/full probe options;
6. pass/fail, histogram, DVM/counter and remaining measurements;
7. lower-priority display, storage and utility surfaces.

This ordering is product priority, not protocol/API dependency order.
