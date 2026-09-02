# Local waveform measurements

Rigol Web supports one measurement-source selector for the DHO804 measurement overlay:

- **Source: Scope** keeps the existing DHO804 measurement configuration and approximately 1 Hz SCPI measurement reads.
- **Source: Local** clears the configured scope measurements, stops measurement polling, and calculates the selected measurements in the browser from the waveform frames already used for plotting.

The measurement list and overlay are shared between both sources. Switching source clears displayed statistics so results from the two calculation paths are never mixed. Replies from an already in-flight scope measurement request are ignored after switching to Local.

## Local calculation basis

Local measurements operate on the calibrated `Float32` amplitude values and waveform time metadata received by the browser. They therefore describe the waveform representation available to Rigol Web, not necessarily every sample in the DHO804 acquisition memory. A narrow event omitted by the transmitted representation can consequently be absent from a local extrema or timing result.

The local path implements all measurement kinds currently exposed by the UI:

- extrema, peak-to-peak, arithmetic average and RMS directly from received samples;
- period/frequency from like-polarity 50% crossings;
- positive/negative width from 50% crossings;
- rise/fall time from 10%/90% crossings;
- duty cycle from width/period;
- time-at-maximum/minimum from waveform time metadata;
- top/base, amplitude, threshold levels, overshoot and preshoot from locally estimated signal levels.

Crossing times are linearly interpolated between adjacent received points. RIGOL documents default percentage thresholds of **Upper 90%, Mid 50%, Lower 10%** for DHO800 measurements.

## Top/base approximation

RIGOL exposes an amplitude-measurement method and a histogram-based mode, but the public DHO800 documentation does not specify an algorithm precise enough to reproduce the instrument's internal `Vtop`/`Vbase` result bit-for-bit.

Rigol Web therefore uses a deterministic local approximation: amplitude values are placed into 64 bins over the observed minimum-to-maximum range; `Vbase` is the mean of samples in the most-populated bin in the lower half and `Vtop` is the corresponding upper-half result. Min/max are deterministic fallbacks. `Vamp`, 10/50/90% levels, overshoot and preshoot are derived from those local top/base estimates.

Do not interpret close agreement between Scope and Local as proof that the algorithms are identical.

## Statistics and viewport changes

Local statistics use each newly accepted waveform frame once. Repeated notifications for the same frame do not increase the count.

Statistics for a channel reset if the represented waveform geometry changes, including live/deep mode, capture ID, represented source range, time transform, or point count. This prevents statistics from silently combining different deep-capture pan/zoom windows or changed live waveform representations.

## Sources

- RIGOL DHO800 User Guide, measurement settings and threshold definitions: https://www.rigol.com/dam/global/downloads/brochures/en/user-manual/oscilloscopes/DHO800_UserGuide_EN.pdf
- RIGOL DHO800 product/download page: https://www.rigol.com/intl/products/oscilloscope/DHO800.html

## Implementation

- `src/web/local-measurements.ts`
- `src/web/components/measurement-panel.tsx`
- `src/web/scope-store.ts`
- `src/web/components/measurement-overlay.tsx`
- `src/web/local-measurements.test.ts`
