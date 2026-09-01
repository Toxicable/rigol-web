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

## SCPI timing instrumentation

`ScpiTransport` measures every query from immediately before the program-message write until a complete SCPI response has been parsed. Routine performance logging is intentionally compact: `query:start`, per-chunk `query:data`, and binary-progress records are suppressed, while each completed query emits one single-line `[SCPI] query:complete` JSON record containing the command, `elapsedMs`, response kind, and response byte count. Timeout/error/connect records remain available.

This is the measurement to use when deciding whether query count is actually a throughput problem; query count alone is not sufficient.

For measurement statistics, one selected measurement currently performs six serialized statistic queries once per second. The relevant cost is the sum of the six observed `elapsedMs` values, not simply the fact that there are six queries. Because SCPI is serialized, time spent waiting for measurement responses is time during which a waveform query cannot be in flight.

## 2026-09-01 real-scope timing capture

A DHO804 log capture after the first hot-path changes showed 999-byte `:WAVeform:DATA?` queries commonly taking roughly 28-40 ms, with occasional values just above 40 ms. This makes the waveform query itself a material throughput limit: one channel is bounded to roughly the high-20s frames/s before event-loop and source-switch overhead, while four enabled channels necessarily reduce each channel to roughly single-digit Hz because four serialized `DATA?` responses are required per cycle.

Text queries were also expensive. Typical timebase readbacks were about 22-25 ms each. A horizontal-position interaction commit issued four reconciliation queries (`XY:ENABle?`, `MODE?`, `MAIN:SCALe?`, `MAIN:OFFSet?`) totalling about 93 ms in one capture and about 113 ms in another. Because the horizontal write invalidates the live preamble, the first following frame then paid another roughly 23-25 ms `:WAVeform:PREamble?` query in addition to a roughly 37-41 ms `DATA?` query. The observed post-interaction query work before/around the first fresh waveform was therefore roughly 156-175 ms, excluding the preceding write commands themselves.

The same capture showed long runs of `:TIMebase:MAIN:OFFSet <value>` interaction writes with no waveform query interleaved in the displayed interval. The gateway was explicitly pausing live waveform service during interactions, and Interactive scheduler priority also outranked Waveform priority.

## Throughput pass 2

The following changes are now implemented for the next real-scope benchmark:

- live NORMAL/BYTE reads are hard-set to 500 points;
- routine controls and interactive commits use optimistic/local state and no longer perform post-write readback bursts; trigger-type transitions retain their readback because a complete Edge trigger state is not otherwise known;
- the server no longer wires the gateway's optional live-waveform pause/resume callbacks, so control interactions do not explicitly suspend live acquisition;
- if both another Interactive write and a Waveform operation are pending after an Interactive operation, the scheduler services the Waveform before allowing another Interactive write; Immediate work still always wins;
- SCPI timing logs are reduced to compact one-line completion records for normal query performance tracking.

The next capture should compare 500-point `:WAVeform:DATA?` timing directly with the prior 999-point roughly 28-40 ms result. If the query remains around 30 ms, the dominant cost is likely fixed instrument/SCPI processing rather than transferring approximately 1 kB of payload. If it falls substantially, live point count is a useful direct frame-rate control.

## DHO800 command knobs and prior art

RIGOL's DHO800/DHO900 Programming Guide documents `:WAVeform:POINts` as 1-1000 points in NORMAL mode. `:WAVeform:DATA?` itself has no arguments; source, reading mode, format, and point count are configured separately with `:WAVeform:SOURce`, `:WAVeform:MODE`, `:WAVeform:FORMat`, and `:WAVeform:POINts`. Rigol Web already uses the lowest-payload documented live combination: NORMAL mode plus BYTE format. Source: https://download.rigol.com/en/Manual/Digital%20Oscilloscope/DHO900/DHO800900_ProgrammingGuide_EN.pdf

There is no documented per-`DATA?` option such as a chunk-size, compression, or fast-response flag. TCP `NODELAY` is already enabled in `ScpiTransport`, so Nagle buffering is not a likely source of the observed 20-40 ms response times. At 500-1000 bytes, raw LAN transfer time itself is negligible compared with the measured scope response latency.

Existing DHO800 community code follows the same basic SCPI path rather than exposing a known faster waveform command. `MasterJubei/pydho800` connects directly to TCP port 5555, configures NORMAL mode, point count and source, then requests preamble and waveform data serially. Its current implementation uses ASCII waveform format for this path, so Rigol Web's cached metadata plus BYTE data path is already materially leaner. Source: https://github.com/MasterJubei/pydho800

`scopebench-mcp` independently reports verified DHO804D access over both USB/VISA and raw LAN SCPI port 5555. This makes a USB-vs-LAN timing comparison a reasonable later experiment if 500-point `DATA?` remains around 30 ms, but there is not yet evidence that changing transport will beat the instrument's own command-processing latency. Source: https://pypi.org/project/scopebench-mcp/

A DHO waveform gist from `steveway` also uses the documented source/mode/format/data sequence and queries scaling metadata separately; it does not show a hidden lower-latency `DATA?` variant. Source: https://gist.github.com/steveway/fbdd6be4c572919d45460cf3114abdf7

## Remaining opportunities

1. Benchmark 500-point `DATA?` and compare it against the 999-point baseline before reducing resolution further.
2. Measure measurement-statistic query RTTs before changing their 1 Hz cadence.
3. If `DATA?` remains mostly fixed-latency, compare raw TCP 5555 against USBTMC/VISA on the same scope. Raw TCP is already a low-overhead transport, so this should be measurement-led rather than assumed.
4. Narrow preamble invalidation. Horizontal and vertical interactive writes can currently invalidate cached scaling metadata; keeping live acquisition running may therefore expose repeated `PREamble?` costs during a drag. A safe cache-update strategy needs to preserve correct X/Y conversion rather than merely hiding the query.
5. Remove the duplicate zero-delay event-loop yields only after real SCPI timing confirms they are material relative to the 20-40 ms device latency.
6. A compound source-select plus `DATA?` SCPI program message may save a host write but cannot remove the `DATA?` response latency; treat it as a minor experiment.

Avoid multiple simultaneous scope sockets as a first-line optimisation. It is not documented as a way to parallelise per-channel waveform reads and would complicate command ordering/state ownership.

Do not optimise uPlot rendering unless a later trace shows browser main-thread or paint/composite pressure after acquisition cadence is increased.
