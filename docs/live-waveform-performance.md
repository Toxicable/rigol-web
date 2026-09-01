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

## Existing SCPI timing instrumentation

`ScpiTransport` already measures every query from immediately before the program-message write until a complete SCPI response has been parsed. Each completed query emits a `[SCPI] query:complete` debug record containing the full command, `elapsedMs`, response kind, and response byte count. This is the measurement to use when deciding whether query count is actually a throughput problem; query count alone is not sufficient.

For measurement statistics, one selected measurement currently performs six serialized statistic queries once per second. The relevant cost is therefore the sum of the six observed `elapsedMs` values, not simply the fact that there are six queries. Compare that summed time directly with `:WAVeform:DATA?` timings and with the one-second polling interval. Because SCPI is serialized, time spent waiting for measurement query responses is time during which a waveform query cannot be in flight, although higher-priority waveform work may run between individual measurement queries.

A useful benchmark is to capture `query:complete` records for approximately 10 seconds with no measurements selected, then repeat with one and several measurements selected. Group total elapsed time by command family, especially `:WAVeform:DATA?` and `:MEASure:STATistic:ITEM?`, before changing measurement polling behavior.

## 2026-09-01 real-scope timing capture

A DHO804 log capture after the hot-path changes shows steady 999-byte `:WAVeform:DATA?` queries commonly taking roughly 28-40 ms, with occasional values just above 40 ms. This makes the waveform query itself a material throughput limit: one channel is bounded to roughly the high-20s frames/s before event-loop and source-switch overhead, while four enabled channels necessarily reduce each channel to roughly single-digit Hz because four serialized `DATA?` responses are required per cycle.

The same capture also shows text queries are not cheap. Typical timebase readbacks were about 22-25 ms each. A horizontal-position interaction commit issued four reconciliation queries (`XY:ENABle?`, `MODE?`, `MAIN:SCALe?`, `MAIN:OFFSet?`) totalling about 93 ms in one capture and about 113 ms in another. Because the horizontal write invalidates the live preamble, the first following frame then paid another roughly 23-25 ms `:WAVeform:PREamble?` query in addition to a roughly 37-41 ms `DATA?` query. The observed post-interaction query work before/around the first fresh waveform was therefore roughly 156-175 ms, excluding the preceding write commands themselves.

The capture also shows long runs of `:TIMebase:MAIN:OFFSet <value>` interaction writes with no waveform query interleaved in the displayed interval. This is consistent with the scheduler assigning Interactive priority above Waveform priority. Even though these writes are response-less and therefore cheaper than queries, sustained drag traffic can temporarily starve waveform acquisition, making interaction look less live than the steady-state frame rate alone would suggest.

These measurements elevate two optimisations from speculative to high-confidence:

- remove post-write reconciliation reads for controls whose UI state is intentionally authoritative;
- ensure sustained interaction writes cannot starve waveform reads indefinitely, for example by allowing periodic waveform service between interactive updates rather than relying only on priority ordering/coalescing.

## Remaining limits

Enabled channels are still acquired serially, so per-channel cadence necessarily falls as more channels are enabled. The DHO800 waveform source is a single selected source, so there is no documented all-analog-channel `:WAVeform:DATA?` request. The source-select command is write-only in our transport and does not wait for a scope response; therefore combining source selection with `DATA?` can save a small host write/packet cost but does not remove a SCPI response round trip. The unavoidable steady-state cost is one `DATA?` response per enabled channel.

## Next opportunities

Prioritise these before renderer work:

1. **Remove post-write control reconciliation traffic where local state is sufficient.** `ScopeController` still performs readbacks after discrete controls and interaction commits. Real-scope captures show horizontal-position commits spending roughly 93-113 ms on four text readbacks before the next fully refreshed waveform path. If local state is authoritative for normal UI writes, remove these bursts and perform authoritative reads only for operations that genuinely need them (for example deep capture already reads fresh scope state).
2. **Prevent interactive-write starvation of waveform acquisition.** Interactive operations currently outrank waveform work. During a sustained drag, the log shows dozens of response-less horizontal offset writes with no waveform read interleaved. Preserve responsive control writes, but guarantee waveform service periodically during long interactions so the visual feedback remains live.
3. **Reduce explicit event-loop yield overhead without sacrificing I/O fairness.** `LiveWaveformService` currently uses `setTimeout(..., 0)` after every channel and again after each completed cycle, meaning the last channel gets two explicit timer yields. Prefer one fairness yield per channel/cycle boundary, and benchmark `setImmediate` on Node rather than zero-delay timers.
4. **Treat measurement statistics as optional SCPI load.** When measurements are selected, the browser polls once per second and the driver issues six statistic queries per measurement (`current`, `min`, `max`, `average`, `deviation`, `count`). Real-scope timebase text queries are already around 22-25 ms, so measurement query count could be significant if statistic queries have similar latency; measure them before changing cadence.
5. **Benchmark live point count.** NORMAL mode allows at most 1,000 points and Rigol Web currently requests 999. Compare `DATA?` duration at 999, 750, 500 and 250 points. With current 999-point reads commonly around 28-40 ms, this experiment is now high value: if latency falls materially with point count, a lower live resolution could directly improve frame rate.
6. **Preamble invalidation can be narrower.** Horizontal writes currently clear every channel's complete preamble cache. A real interaction therefore adds roughly another 23-25 ms preamble query on the first following frame. X metadata is common horizontal state while each channel's Y metadata remains valid; avoid forcing one full preamble query per affected channel where possible.
7. **Compound source-select + data query is a minor experimental optimisation.** Verify whether the DHO804 accepts a compound program message such as `:WAVeform:SOURce CHANnel2;:WAVeform:DATA?`. Because source selection currently has no response, the likely gain is small compared with the observed 28-40 ms `DATA?` latency.

Avoid multiple simultaneous scope sockets as a first-line optimisation. It is not documented as a way to parallelise per-channel waveform reads and would complicate command ordering/state ownership; only bench it if single-socket `DATA?` latency proves to be the hard ceiling.

Do not optimise uPlot rendering unless a later trace shows browser main-thread or paint/composite pressure after acquisition cadence is increased.
