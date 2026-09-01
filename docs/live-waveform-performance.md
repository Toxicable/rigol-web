# Live waveform performance

## 2026-09-01 browser trace

A Chrome Performance capture of the deployed Rigol Web UI over 6.31 s showed approximately 22 ms scripting, 3 ms painting, and 2 ms rendering on the browser main thread. The UI was visually choppy despite the browser spending almost all of the interval idle.

Current conclusion: the observed choppiness is primarily an acquisition/publication cadence issue rather than a browser rendering bottleneck.

The design owner also observed that the live display subjectively becomes slower as more channels are enabled. This is consistent with the current serialized acquisition path and should be treated as supporting evidence until measured frame cadences are captured.

## Current live acquisition cost

`LiveWaveformService` continuously requests fresh channel data with no intentional frame-period delay beyond yielding with `setTimeout(..., 0)`.

For each enabled channel, `Dho804Driver.readLiveWaveform()` currently performs:

1. cached waveform setup commands when source/mode/format/point-count changed;
2. `:WAVeform:DATA?` binary query;
3. `:WAVeform:PREamble?` text query;
4. `:CHANnel<n>:UNITs?` text query.

Enabled channels are acquired serially. When multiple channels are enabled the waveform source changes between channels, adding source-selection traffic and dividing the effective per-channel refresh rate.

With approximately equal per-channel transaction cost, the first-order expectation is that per-channel refresh cadence scales roughly inversely with the number of enabled channels: one channel gets one acquisition per cycle, while four channels require four serialized acquisitions per cycle. Exact rates depend on SCPI query and source-switch latency and must be measured rather than assumed.

The browser accepts each newer live frame immediately and imperatively calls `uPlot.setData(..., false)` followed by `uPlot.redraw()`. There is no frontend live-waveform frame-rate throttle in this path.

## Solution plan

Prioritise reducing scope-side SCPI work; browser rendering is not the current bottleneck.

1. Remove `:CHANnel<n>:UNITs?` from every live waveform transaction. The authoritative channel state already contains the unit; pass/use that state instead of re-querying it for each frame.
2. Cache live waveform preamble metadata per channel. Refresh it only when a setting that can change waveform conversion/X metadata changes (for example channel scale/offset/probe settings, horizontal scale/position, acquisition changes, reconnect, or raw-SCPI invalidation). Do not issue `:WAVeform:PREamble?` after every `DATA?`.
3. Keep NORMAL/BYTE setup cached as it is now. Source selection is still required when round-robin acquisition moves between enabled channels.
4. Benchmark whether the DHO804 accepts a compound SCPI program message that combines source selection and the binary query, e.g. source-select plus `:WAVeform:DATA?` in one socket write. Treat this as an optimisation only after real-scope verification; do not assume parser support.
5. Benchmark lower NORMAL-mode live point counts (for example 500-800 versus the current 999). Keep 999 if command/query latency dominates; reduce only if binary transfer or scope processing time measurably improves.
6. Add explicit live-path timing/telemetry: acquisition duration per channel, source-switch/setup duration, binary `DATA?` duration, metadata-refresh duration, and delivered frames/s per channel. This should be available in development diagnostics rather than inferred from browser traces.
7. If aggregate SCPI throughput remains the hard limit after removing metadata queries, use scheduling policy rather than frontend changes: optionally prioritise the selected/actively manipulated channel while still refreshing other enabled channels fairly. This improves interaction responsiveness but does not increase total scope throughput.
8. Do not group all channels into one browser publish waiting for a full cycle; that would increase latency and cannot improve acquisition throughput. Continue publishing each fresh channel frame independently.
9. Do not add parallel scope sockets for live channels unless a dedicated real-scope experiment proves the DHO804 safely supports concurrent waveform reads. Current architecture intentionally serialises access.

The desired steady-state hot path after metadata is warm is therefore approximately:

`source select if changed -> :WAVeform:DATA? -> publish frame`

If source-select and `DATA?` can safely be combined into one program message, the ideal hot path becomes one scope request/response transaction per channel frame.

## Measurement target

Measure scope-side latency for `DATA?`, `PREamble?`, `UNITs?`, and source switching separately. Also measure delivered WebSocket frame cadence for 1, 2, 3 and 4 enabled channels, preferably per channel sequence number. This quantifies how much gain comes from each hot-path change and how close the remaining behaviour is to the unavoidable serialized multi-channel cost.

Do not optimise uPlot rendering unless a later trace shows browser main-thread or paint/composite pressure after the acquisition rate is increased.
