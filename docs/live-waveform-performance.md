# Live waveform performance

## Current conclusion

The browser is not the live-waveform bottleneck. Real DHO804 captures show substantial scope-side SCPI latency:

- ordinary text queries commonly take about 22-30 ms;
- warm 1000-byte `:WAVeform:DATA?` calls commonly take about 29-41 ms;
- `:WAVeform:PREamble?` has been observed around 23-27 ms;
- reducing NORMAL/BYTE data from 999 to 500 points did not materially improve `DATA?` latency and cropped the displayed time span instead of decimating it.

Live acquisition therefore uses a fixed 1000-point NORMAL/BYTE path. There is no live point-count option.

All software changes in this workstream cost $0.

## Retrospective: what helped

The biggest gains came from reducing the number of scope transactions rather than trying to move fewer waveform bytes. The useful changes were:

- instrument the transport first: log the exact SCPI command, elapsed time, response kind and returned byte count so scope-side latency and malformed responses are visible;
- use real DHO804 captures as the deciding evidence instead of assuming that SCPI syntax support, another Rigol family, or a programming-guide example implies equivalent runtime behavior;
- remove the 1 Hz full-state poller and keep the connected-session state authoritative for app-originated writes;
- cache channel units and NORMAL waveform preambles so the warm live path does not spend another 20-30 ms on metadata queries every frame;
- combine source selection and waveform read for one channel as `SOURCE CHx;DATA?`, removing a separate source-write transaction without changing binary-response semantics;
- keep one scheduler operation per channel, which gives interactive work a safe boundary between channel reads;
- pause live waveform acquisition while horizontal interaction writes are in flight instead of allowing timebase writes to interleave with binary transfers;
- invalidate horizontal metadata and refresh `PREamble?` once before the first resumed `DATA?`, rather than trying to make the binary read itself establish the new waveform context;
- update vertical cached metadata locally where the DHO800/DHO900 preamble relationships are explicit and the transform is deterministic;
- compare repeated or representative measurements and their spread. A single faster observation is evidence that a command works, not evidence of a meaningful performance improvement.

The debugging logs were especially valuable when a change failed. Zero-byte and truncated binary responses identified transaction-ordering problems that would have been easy to misdiagnose as browser rendering or parser faults.

## Retrospective: what did not help

Several plausible optimizations were tested and rejected:

- lowering NORMAL/BYTE live data from 999 to 500 points did not materially reduce `DATA?` latency and instead cropped the displayed time span;
- one-shot compound text-query timing did not establish a measurable batching gain. The observed difference was within ordinary run-to-run variability;
- chaining multiple channel `DATA?` queries into one SCPI program message was not usable on the real DHO804: four block headers were returned but only the first block contained the expected 999-byte waveform;
- synthesizing horizontal X metadata locally was too risky. Horizontal changes now invalidate the preamble and pay one real `PREamble?` after the gesture instead;
- allowing `:TIMebase:MAIN:OFFSet` writes to interleave with live waveform reads caused zero-byte and truncated waveform responses;
- resuming with `DATA?` before refreshing an invalidated preamble caused a 1744.384 ms post-pan read that returned zero bytes;
- reducing browser/network work was not a useful direction for this bottleneck: 999 bytes over the LAN is negligible compared with the DHO804's tens-of-milliseconds SCPI processing time;
- USB was not pursued because this deployment cannot use it. Do not carry it as a hypothetical optimization path;
- optional benchmark/fallback modes were not useful once hardware behavior was known. Production keeps one deterministic acquisition path and rejected experiments remain documented instead.

## Working method for future SCPI performance changes

Use the same sequence for future work:

1. Capture the current hot path on the real instrument with per-command timing and response-size logging.
2. Identify removable transactions before changing payload size or browser code.
3. Change one SCPI boundary at a time and keep the production behavior deterministic.
4. Validate both steady-state streaming and interactions that mutate the scope while streaming.
5. Require repeated measurements or representative ranges before claiming a performance gain.
6. Treat malformed/empty responses as instrument-protocol evidence and fix transaction ordering rather than hiding them with retries or fallbacks.
7. Record rejected experiments and their hardware evidence so the same idea is not repeatedly rediscovered.

The remaining obvious query-heavy areas are measurement statistics, which still use six native queries per selected measurement, and the fresh hardware-state read before deep RAW capture. Those are separate workstreams; neither should be changed without measuring its actual occupancy and semantics first.

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

A post-fix four-channel capture showed the expected stable single-channel transactions, generally about 28-38 ms each, with every returned block containing 999 bytes.

NORMAL/BYTE preambles remain cached per channel. Channel units are seeded by the initial scope snapshot and cached.

## Interaction stability

A real-scope run proved that horizontal writes must not be interleaved with live waveform transfer. During repeated `:TIMebase:MAIN:OFFSet` writes, one `DATA?` returned zero bytes and a later 999-byte block stopped after 985 total bytes, eventually timing out.

Interactive drags therefore pause live waveform acquisition. Commit resumes acquisition after a 200 ms settle delay. Horizontal scale/position writes invalidate cached preambles so the first resumed read obtains fresh X metadata; the drag itself does not issue repeated live `DATA?`/`PREamble?` traffic.

A later run exposed a second post-pan failure mode in the single-channel live path. After a horizontal drag, the first resumed CH1 `SOURCE;DATA?` took 1744.384 ms and returned a zero-length block. The immediately following CH1 read took 29.492 ms and returned all 999 bytes, after which `PREamble?` completed in 23.401 ms. The driver had been attempting binary data before refreshing the invalidated preamble.

The live read order is now deterministic on a metadata cache miss: select the channel, refresh `PREamble?`, then issue `SOURCE CHx;DATA?`. Warm steady-state reads still use only the single `SOURCE CHx;DATA?` transaction. This keeps the metadata refresh as the recovery/readiness step after horizontal mutation instead of using an empty binary transfer as the first probe.

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
- horizontal metadata: one fresh `PREamble?` per enabled channel after a committed horizontal interaction, before that channel's first resumed `DATA?`;
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

## rigol-mcp follow-up

These notes are retained in-repo as current implementation/research guidance rather than as a separate tracker item.

A second comparison against `erebusnz/rigol-mcp` after the waveform optimizations found no better live-waveform transport to adopt. Rigol Web's binary NORMAL/BYTE path, one `SOURCE CHx;DATA?` transaction per enabled channel, cached units/preambles, and interaction-aware pause/resume policy remain the preferred production design.

Useful remaining ideas:

- **Invalid measurement sentinel:** `rigol-mcp` treats values around `9.9E37` as Rigol's invalid/overflow sentinel, commonly caused by disabled or not-yet-acquired sources. Rigol Web currently parses finite statistic values directly, so this sentinel must not be allowed to appear as a real measurement. Add an explicit invalid measurement representation and define UI behavior for measurements targeting disabled channels.
- **Measurement batching benchmark:** measurements remain the clearest recurring SCPI hotspot at six text queries per selected measurement. Since compound text queries are known to work on the real DHO804, benchmark one semicolon-separated statistic query per measurement for CURR/MIN/MAX/AVG/DEV/CNT. Adopt only if repeated hardware timings show a material gain without harming interaction latency.
- **Just-enabled channel warm-up:** `rigol-mcp` observed temporary empty waveform data and stale/zero X metadata until the first sweep after enabling a channel. Reproduce this specifically on the DHO804. If present, model it as an expected warm-up state rather than a generic transport retry/fallback.
- **Native scope screenshot:** DHO uses `:DISPlay:DATA? PNG`. Keep this separate from the browser-page screenshot; it is useful as an authoritative A/B diagnostic between the physical scope display and Rigol Web rendering.
- **Low-priority diagnostics/utilities:** DHO `:AUToset`, cursor controls, and a manual SCPI error-queue drain remain useful. Do not automatically query the error queue after writes because the added round trips conflict with the measured latency work.

Ideas explicitly not carried forward:

- do not replace the live binary waveform path with `rigol-mcp`'s ASCII waveform transfer;
- do not pursue USBTMC for this LAN-only deployment;
- do not add a generic multi-family scope-driver abstraction while Rigol Web intentionally targets the DHO804.

Upstream references:

- `rigol-mcp` repository: https://github.com/erebusnz/rigol-mcp
- invalid sentinel/channel warm-up implementation: https://github.com/erebusnz/rigol-mcp/commit/22a8eda3d2952347816bfb2042e037f5fdd3d933
- DHO screenshot/autoset implementation: https://github.com/erebusnz/rigol-mcp/blob/main/src/rigol_mcp/drivers.py
- SCPI error-queue handling: https://github.com/erebusnz/rigol-mcp/blob/main/src/rigol_mcp/scope.py

Cost impact of these software changes and investigations: $0. `rigol-mcp` is MIT licensed; retain its copyright/license notice if implementation code is copied rather than independently reimplemented.

## Transport

Rigol Web is LAN-only for the scope. USB is not available in this deployment and is not a candidate transport.

The TCP transport uses `NODELAY`. Moving 999 bytes over LAN is negligible compared with the observed tens of milliseconds of DHO804 SCPI response latency.
