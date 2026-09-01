# Live waveform performance

## Current conclusion

The browser is not the live-waveform bottleneck. Real DHO804 captures show substantial scope-side SCPI latency:

- ordinary text queries commonly take about 22-30 ms;
- warm 999-byte `:WAVeform:DATA?` calls commonly take about 29-41 ms;
- `:WAVeform:PREamble?` has been observed around 23-27 ms;
- reducing NORMAL/BYTE data from 999 to 500 points did not materially improve `DATA?` latency and cropped the displayed time span instead of decimating it.

Live acquisition therefore uses a fixed 999-point NORMAL/BYTE path. There is no live point-count option.

All software changes in this workstream cost $0.

## Compound live waveform transaction

A four-channel capture of the old loop showed strict serial traffic:

`SOURCE CH1 -> DATA? -> SOURCE CH2 -> DATA? -> SOURCE CH3 -> DATA? -> SOURCE CH4 -> DATA?`

Representative groups consumed about 133-139 ms in `DATA?` time alone, giving roughly 7.2-7.5 complete four-channel sweeps per second before other scheduler work.

The production path now hard-cuts to one SCPI program message per live cycle containing every enabled channel in display order:

`SOURCE CH1;DATA?;SOURCE CH2;DATA?;...`

This is not a feature flag or optional probe. `ScpiTransport` parses the expected number of IEEE488.2 binary blocks from that one transaction. It accepts semicolon-separated, line-separated, or directly adjacent length-delimited blocks and rejects unexpected trailing data. Each returned payload must be exactly 999 bytes and is mapped back to the corresponding requested channel.

For one enabled channel the same rule still applies: `SOURCE CHx;DATA?` is sent as one program message.

NORMAL/BYTE preambles remain cached per channel. A missing preamble selects that channel and queries `PREamble?` before the live batch; once warm, the steady live cycle is only the compound waveform transaction. Channel units are seeded by the initial scope snapshot and cached.

## Interaction stability

A real-scope run proved that horizontal writes must not be interleaved with live waveform transfer. During repeated `:TIMebase:MAIN:OFFSet` writes, one `DATA?` returned zero bytes and a later 999-byte block stopped after 985 total bytes, eventually timing out.

Interactive drags therefore pause live waveform acquisition. Commit resumes acquisition after a 200 ms settle delay. Horizontal scale/position writes invalidate cached preambles so the first resumed cycle obtains fresh X metadata; the drag itself does not issue repeated live `DATA?`/`PREamble?` traffic.

App-driven vertical scale/offset changes update warm Y metadata locally:

- scale: multiply `YINCrement` by `newScale / oldScale` and divide `YORigin` by the same ratio;
- offset: `YORigin = VerticalOffset / YINCrement`.

RIGOL's DHO800/DHO900 Programming Guide defines NORMAL-mode `YINCrement = VerticalScale/7500`, `YORigin = VerticalOffset/YINCrement`, and the waveform preamble fields. The implementation transforms the preamble returned by the actual scope rather than hard-coding that divisor.

Source: https://download.rigol.com/en/Manual/Digital%20Oscilloscope/DHO800/DHO800900_ProgrammingGuide_EN.pdf

## Connected-session query policy

The server reads one complete hardware snapshot when a scope session is established and does not run the former 1 Hz full-state poller. App-driven control writes are optimistic and do not perform routine post-write readbacks. Run, Stop, and Single update local run state without `:TRIGger:STATus?` readback.

Steady-state query policy:

- live waveform: one compound multi-channel waveform transaction per cycle;
- vertical metadata: `PREamble?` only on a cache miss;
- horizontal metadata: one fresh `PREamble?` after a committed horizontal interaction;
- measurements: six native statistic queries per selected measurement;
- trigger-type transition: complete trigger-state readback because Edge-specific fields may not be known locally;
- deep capture: still performs a fresh hardware-state read before RAW capture;
- raw SCPI: invalidates waveform setup and metadata caches because arbitrary commands may alter scope state.

## Measurement occupancy

With four live channels active, one selected measurement showed individual statistic queries around 23-35 ms while `measurements:complete` spanned roughly 312-375 ms because measurement operations were interleaved with waveform work. Treat the aggregate elapsed time as scheduler latency/occupancy rather than six back-to-back query durations.

## SCPI timing instrumentation

`ScpiTransport` times a query from immediately before the program-message write until the complete response is parsed.

Single response example:

`[SCPI] query:complete {"command":"...","elapsedMs":...,"responseKind":"binary","responseBytes":999}`

Compound live response example:

`[SCPI] query:complete {"command":"...","elapsedMs":...,"responseKind":"binary-blocks","responseBlocks":4,"responseBytes":3996}`

Measurement reads also emit:

`[SCPI] measurements:complete {"measurements":N,"queries":6*N,"elapsedMs":...}`

## Other batching evidence

The DHO804 accepts compound text queries and returns semicolon-separated results. The first observed pair was 45.739 ms for combined timebase scale+offset versus 24.008 ms and 24.731 ms for later separate reads. That single comparison is within normal run-to-run variation and is not evidence of a 6% performance gain; it only proves compound text syntax works.

A community DHO driver also uses compound text queries:

- https://github.com/eicorg/epicsdev/blob/e9bc3ad122d3e0e0526a9d7e050325d2ed1ce405/oscilloscope/rigol_dho/rigol_dho/__main__.py

## Transport

Rigol Web is LAN-only for the scope. USB is not available in this deployment and is not a candidate transport.

The TCP transport uses `NODELAY`. Moving 999 bytes over LAN is negligible compared with the observed tens of milliseconds of DHO804 SCPI response latency.
