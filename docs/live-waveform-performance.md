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

## Optimisation target

Measure scope-side latency for `DATA?`, `PREamble?`, `UNITs?`, and source switching separately. The strongest likely improvement is to remove invariant metadata queries from the per-frame hot path: use already-known scope state for channel units and cache/refresh waveform preamble metadata only when settings that affect it change. The target live hot path is ideally one binary `:WAVeform:DATA?` transaction per channel frame, plus source selection when required.

Also measure delivered WebSocket frame cadence for 1, 2, 3 and 4 enabled channels, preferably per channel sequence number. This will quantify how close the real behaviour is to inverse-N scaling and how much additional cost comes from source switching and metadata queries.

Do not optimise uPlot rendering unless a later trace shows browser main-thread or paint/composite pressure after the acquisition rate is increased.
