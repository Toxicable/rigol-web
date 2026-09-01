# Live waveform performance

## Current conclusion

The browser is not the live-waveform bottleneck. Real DHO804 captures show substantial scope-side SCPI latency:

- ordinary text queries commonly take about 22-30 ms;
- warm 999-byte `:WAVeform:DATA?` calls commonly take about 29-41 ms;
- `:WAVeform:PREamble?` has been observed around 23-27 ms;
- reducing NORMAL/BYTE data from 999 to 500 points did not materially improve `DATA?` latency and cropped the displayed time span instead of decimating it.

Live acquisition therefore uses a fixed 999-point NORMAL/BYTE path. There is no live point-count option.

All software changes in this workstream cost $0.

## Multi-channel compound result

A four-channel capture of the original loop showed strict serial traffic:

`SOURCE CH1 -> DATA? -> SOURCE CH2 -> DATA? -> SOURCE CH3 -> DATA? -> SOURCE CH4 -> DATA?`

Representative groups consumed about 133-139 ms in `DATA?` time alone, giving roughly 7.2-7.5 complete four-channel sweeps per second before other scheduler work.

A later hard-cut experiment sent every enabled channel in one SCPI program message:

`SOURCE CH1;DATA?;SOURCE CH2;DATA?;SOURCE CH3;DATA?;SOURCE CH4;DATA?`

The real DHO804 repeatedly returned four syntactically valid IEEE488.2 blocks but only 999 payload bytes in total. CH1 contained the expected 999-byte waveform and CH2 was a zero-length block; because total payload was still 999 bytes, the remaining blocks were also empty. Representative transaction times were roughly 89-111 ms, with occasional runs above 120 ms. The result was stable across many repetitions.

This proves that the DHO804 accepts the multi-query syntax but does **not** provide multiple usable waveform payloads from one program message. Do not use multi-channel `DATA?` chaining for live acquisition.

The production live path now uses one program message per enabled channel:

`SOURCE CHx;DATA?`

That keeps source selection and waveform query combined while giving the scheduler and live-service pause logic a boundary between channels. It is the only live acquisition path; there is no multi-channel batching option or fallback mode.

NORMAL/BYTE preambles remain cached per channel. Channel units are seeded by the initial scope snapshot and cached.

## Interaction stability

A real-scope run proved that horizontal writes must not be interleaved with live waveform transfer. During repeated `:TIMebase:MAIN:OFFSet` writes, one `DATA?` returned zero bytes and a later 999-byte block stopped after 985 total bytes, eventually timing out.

Interactive drags therefore pause live waveform acquisition. Commit resumes acquisition after a 200 ms settle delay. Horizontal scale/position writes invalidate cached preambles so the first resumed read obtains fresh X metadata; the drag itself does not issue repeated live `DATA?`/`PREamble?` traffic.

App-driven vertical scale/offset changes update warm Y metadata locally:

- scale: multiply `YINCrement` by `newScale / oldScale` and divide `YORigin` by the same ratio;
- offset: `YORigin = VerticalOffset / YINCrement`.

RIGOL's DHO800/DHO900 Programming Guide defines NORMAL-mode `YINCrement = VerticalScale/7500`, `YORigin = VerticalOffset/YINCrement`, and the waveform preamble fields. The implementation transforms the preamble returned by the actual scope rather than hard-coding that divisor.

Source: https://download.rigol.com/en/Manual/Digital%20Oscilloscope/DHO800/DHO800900_ProgrammingGuide_EN.pdf

## Connected-session query policy

The server reads one complete hardware snapshot when a scope session is established and does not run the former 1 Hz full-state poller. App-driven control writes are optimistic and do not perform routine post-write readbacks. Run, Stop, and Single update local run state without `:TRIGger:STATus?` readback.

Steady-state query policy:

- live waveform: one `SOURCE CHx;DATA?` compound transaction per enabled channel;
- vertical metadata: `PREamble?` only on a cache miss;
- horizontal metadata: one fresh `PREamble?` after a committed horizontal interaction;
- measurements: six native statistic queries per selected measurement;
- trigger-type transition: complete trigger-state readback because Edge-specific fields may not be known locally;
- deep capture: still performs a fresh hardware-state read before RAW capture;
- raw SCPI: invalidates waveform setup and metadata caches because arbitrary commands may alter scope state.

## Measurement occupancy

With four live channels active, an earlier serial-live capture showed individual statistic queries around 23-35 ms while `measurements:complete` spanned roughly 312-375 ms because measurement operations were interleaved with waveform work.

The failed four-channel compound experiment produced a much larger example, about 718 ms for one selected measurement, because each statistic query was interleaved with another roughly 90-105 ms invalid compound waveform attempt. Do not use that failed-run aggregate as the steady-state measurement baseline.

## SCPI timing instrumentation

`ScpiTransport` times a query from immediately before the program-message write until the complete response is parsed.

Normal live response example:

`[SCPI] query:complete {"command":":WAVeform:SOURce CHANnel1;:WAVeform:DATA?","elapsedMs":...,"responseKind":"binary","responseBytes":999}`

The rejected multi-channel experiment looked like:

`[SCPI] query:complete {"command":"SOURCE CH1;DATA?;SOURCE CH2;DATA?;SOURCE CH3;DATA?;SOURCE CH4;DATA?","elapsedMs":93.402,"responseKind":"binary-blocks","responseBlocks":4,"responseBytes":999}`

The corresponding driver failure was `Expected 999 live waveform samples for CH2, received 0`.

Measurement reads also emit:

`[SCPI] measurements:complete {"measurements":N,"queries":6*N,"elapsedMs":...}`

## Other batching evidence

The DHO804 accepts compound text queries and returns semicolon-separated results. The first observed pair was 45.739 ms for combined timebase scale+offset versus 24.008 ms and 24.731 ms for later separate reads. That single comparison is within normal run-to-run variation and is not evidence of a 6% performance gain; it only proves compound text syntax works.

A community DHO driver also uses compound text queries:

- https://github.com/eicorg/epicsdev/blob/e9bc3ad122d3e0e0526a9d7e050325d2ed1ce405/oscilloscope/rigol_dho/rigol_dho/__main__.py

Compound text-query support must not be generalized to multiple binary waveform queries; the real DHO804 result above is authoritative for this deployment.

## Transport

Rigol Web is LAN-only for the scope. USB is not available in this deployment and is not a candidate transport.

The TCP transport uses `NODELAY`. Moving 999 bytes over LAN is negligible compared with the observed tens of milliseconds of DHO804 SCPI response latency.
