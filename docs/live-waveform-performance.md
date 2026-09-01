# Live waveform performance

## 2026-09-01 browser trace

A Chrome Performance capture of the deployed Rigol Web UI over 6.31 s showed approximately 22 ms scripting, 3 ms painting, and 2 ms rendering on the browser main thread. The UI was visually choppy despite the browser spending almost all of the interval idle.

Current conclusion: the observed choppiness is primarily an acquisition/publication cadence issue rather than a browser rendering bottleneck.

The design owner also observed that the live display subjectively becomes slower as more channels are enabled. This matches the serialized per-channel acquisition path: each extra enabled channel adds another scope transaction before a given channel is refreshed again.

## Implemented hot-path changes

The live waveform path now treats the server's connected-session state as authoritative rather than continuously re-reading scope configuration.

- `ScopeRuntime` reads one complete scope snapshot while establishing a session and does not start the former 1 Hz `ScopePoller`. Front-panel/external-change reconciliation is intentionally deferred.
- `Dho804Driver.readChannelState()` seeds a per-channel unit cache during the initial snapshot, so steady-state live waveform reads do not issue `:CHANnel<n>:UNITs?`.
- NORMAL/BYTE waveform preambles are cached per channel and live point count. After the first frame for a channel, unchanged settings do not issue `:WAVeform:PREamble?` again.
- Channel scale/offset writes invalidate that channel's live preamble. Horizontal scale/position writes invalidate all live preambles.
- Raw SCPI invalidates waveform setup, live preamble, and unit caches because arbitrary commands may have changed the scope configuration.

The expected warm per-channel live path is therefore:

1. `:WAVeform:SOURce CHANnel<n>` when switching from another enabled channel;
2. `:WAVeform:DATA?`.

For one enabled channel after setup is warm, the expected path is just `:WAVeform:DATA?` per frame.

## Remaining limits

Enabled channels are still acquired serially, so per-channel cadence necessarily falls as more channels are enabled. The next benchmark should measure scope-side latency of source selection and `:WAVeform:DATA?` separately before changing the renderer or point count.

Possible later work:

- verify on real DHO804 hardware whether source selection and `:WAVeform:DATA?` can safely be combined in one SCPI program message;
- benchmark a smaller live point count only if binary transfer time is material;
- design an explicit strategy for detecting front-panel/external changes without restoring high-rate full-state polling.

Do not optimise uPlot rendering unless a later trace shows browser main-thread or paint/composite pressure after acquisition cadence is increased.
