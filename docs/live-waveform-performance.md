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

## Issue #15: background state-poll contention

Issue #15 identifies a second source of avoidable SCPI traffic: `ScopePoller` performs a full `readScopeState()` every second. For the current edge-trigger state this is roughly 39 serialized text queries per reconciliation pass.

The scheduler gives waveform work priority 3 and background state reads priority 4, so queued waveform work wins. However, each individual SCPI operation is non-preemptible, and the live waveform service deliberately yields with `setTimeout(..., 0)` between channel reads. This gives pending background work opportunities to start between waveform transactions; once a background query starts, the next waveform must wait for it to finish. A large 1 Hz reconciliation therefore consumes scope/link round trips and can reduce or jitter live waveform cadence even though it is nominally lower priority.

Do not keep a monolithic 1 Hz full-state reconciliation if benchmarking confirms material contention. Prefer optimistic/local state for our own writes and stagger or target background reconciliation for front-panel/external changes. A slower periodic full reconciliation can remain as a safety net.

## Optimisation target

Implement in this order:

1. remove `:CHANnel<n>:UNITs?` from the steady-state live waveform path and use known channel state;
2. cache waveform preamble metadata and invalidate it only when waveform/timebase/acquisition configuration changes or the connection/raw-SCPI path invalidates it;
3. reduce the 1 Hz full-state poll: stagger/target state reads and use a slower full reconciliation rather than issuing ~39 text queries every second;
4. benchmark whether source selection plus `:WAVeform:DATA?` can be combined safely in one DHO804 SCPI program message;
5. only then benchmark smaller live point counts if `DATA?` transfer time remains significant.

The target warm live path is ideally one binary `:WAVeform:DATA?` transaction per channel frame, plus the minimum unavoidable source-selection traffic. Do not optimise uPlot rendering unless a later trace shows browser main-thread or paint/composite pressure after acquisition cadence is increased.
