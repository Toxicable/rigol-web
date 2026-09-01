# Live waveform performance

## Current conclusion

A Chrome Performance capture showed the browser main thread almost entirely idle while the live trace was visibly choppy. The limiting path is scope acquisition/SCPI cadence rather than React/uPlot rendering.

Real DHO804 captures show a substantial fixed-looking SCPI cost:

- ordinary text queries commonly take about 22-30 ms;
- warm 999-byte `:WAVeform:DATA?` calls commonly take about 29-41 ms;
- `:WAVeform:PREamble?` has been observed around 23-27 ms;
- reducing NORMAL/BYTE waveform data from 999 to 500 bytes did not materially reduce `DATA?` latency and returned only the first part of the displayed waveform, so live reads remain at 999 points.

The practical optimization rule is therefore to eliminate avoidable queries first, then benchmark batching changes rather than assuming their value.

All software changes in this workstream cost $0.

## Connected-session behavior

The server reads one complete hardware snapshot when a scope session is established. It does not run the former 1 Hz full-state poller. The connected-session state is authoritative for app-driven controls; front-panel/external-change reconciliation is intentionally deferred.

Routine control writes and interactive commits are optimistic and do not perform post-write state readback bursts. Run, Stop, and Single now also update local run state directly instead of issuing a post-action `:TRIGger:STATus?` query. A trigger-type transition still reads the complete resulting trigger state because the Edge-only source/slope/level fields are not necessarily known from the prior state.

Deep capture remains an exception: it currently requests a full scope snapshot before RAW capture because it needs authoritative stopped/enabled-channel/memory-depth information. This is not steady-state live traffic, but it is a later query-reduction target; a narrower hardware-truth read would be preferable to the full snapshot.

## Interaction stability

A real-scope run after keeping live acquisition active during panning showed the scope/live path appearing to die while horizontal position was being dragged. Treat interleaving interactive scope mutation with repeated live `DATA?` acquisition as unsafe until proven otherwise.

The server therefore wires the gateway interaction pause/resume hooks again. Interactive drag updates pause live waveform acquisition; the interaction commit resumes it after the existing 200 ms settle delay. This restores the previously stable transaction boundary instead of asking the DHO804 to process live waveform reads while interactive writes are still arriving.

The experimental synthesized horizontal preamble update was also removed. Horizontal scale/position writes now invalidate cached live preambles. Because acquisition is paused for the gesture, those invalidations do not create one `PREamble?` query per drag update: the first live frame after commit performs one fresh hardware `PREamble?`, then the cache is warm again.

This is a stability rule, not evidence that the DHO804 fundamentally cannot interleave those operations. Revisit only with a controlled real-scope test.

## Live waveform hot path

Units are seeded from the initial channel snapshot and cached. NORMAL/BYTE preambles are cached per channel and live point count. After the first frame, a stable single-channel live path is therefore only:

1. `:WAVeform:DATA?`

With multiple enabled channels, source selection is also required when the active source changes.

App-driven vertical scale/offset writes update cached Y metadata locally:

- Vertical scale: `YINCrement` is scaled by `newScale / oldScale`; `YORigin` is inversely scaled so the existing vertical offset is preserved.
- Vertical offset: `YORigin = VerticalOffset / YINCrement`.

Horizontal scale/position writes deliberately invalidate the live preamble and take one fresh preamble after the interaction commits. Raw SCPI invalidates waveform setup, unit/scale metadata, and cached preambles because arbitrary commands may have changed the scope.

RIGOL's DHO800/DHO900 Programming Guide explicitly defines NORMAL-mode `YINCrement = VerticalScale/7500` and `YORigin = VerticalOffset/YINCrement`, and defines the preamble fields as `<xincrement>,<xorigin>,<xreference>,<yincrement>,<yorigin>,<yreference>`. Source:

- https://download.rigol.com/en/Manual/Digital%20Oscilloscope/DHO800/DHO800900_ProgrammingGuide_EN.pdf

The vertical relative-update implementation deliberately does not hard-code the documented divisor; it transforms the preamble already returned by the actual DHO804 firmware.

## SCPI timing instrumentation

`ScpiTransport` times every query from immediately before writing the program message until a complete text or binary response has been parsed. Normal performance tracking uses one compact line per completed query:

`[SCPI] query:complete {"command":"...","elapsedMs":...,"responseKind":"...","responseBytes":...}`

Measurement reads also emit one aggregate line after the complete poll:

`[SCPI] measurements:complete {"measurements":N,"queries":6*N,"elapsedMs":...}`

One selected measurement currently performs six native statistic queries: current, minimum, maximum, average, deviation, and count. The aggregate log lets the real DHO804 decide whether that is acceptable rather than inferring cost from query count alone.

## Compound-query batching: first observation and repeated probe

The first DHO804 test proved that compound text queries are supported:

- compound `:TIMebase:MAIN:SCALe?;:TIMebase:MAIN:OFFSet?`: 45.739 ms;
- later individual `SCALe?`: 24.008 ms;
- later individual `OFFSet?`: 24.731 ms.

That single comparison is **not** sufficient to claim a 3 ms / 6% batching gain; the observed difference is easily within the normal latency variation in the same log. Treat it only as proof that the DHO804 returns both text values in a semicolon-separated response.

The temporary startup diagnostic now performs 10 paired rounds and alternates ordering each round to reduce warm-up/drift bias. It records count, median, mean, minimum, and maximum for:

- two separate timebase queries versus the same two query units in one compound program message;
- separate `:WAVeform:SOURce CHANnel1` + `:WAVeform:DATA?` versus `:WAVeform:SOURce CHANnel1;:WAVeform:DATA?`, with the source deliberately changed to CH2 before each sample so both paths actually perform a source switch.

The second probe uses NORMAL/BYTE/999 and validates a 999-byte binary response. If either diagnostic produces an invalid response, the runtime discards that connection and reconnects without retrying the probe, avoiding a potentially misaligned SCPI stream.

Do not make a batching-performance conclusion until the repeated summaries are captured. RIGOL documents SCPI sequential commands as executing in sequence, so it is plausible that multiple query units still incur most of their individual instrument-processing cost even inside one program message, but that should be measured on this scope.

A community DHO driver also demonstrates compound text-query use and semicolon-separated response parsing:

- https://github.com/eicorg/epicsdev/blob/e9bc3ad122d3e0e0526a9d7e050325d2ed1ce405/oscilloscope/rigol_dho/rigol_dho/__main__.py

Do not assume multiple binary waveform queries can be chained across channels. A separate Rigol DS1104Z project reports that a source/data/source/data compound message returned only the first waveform on that model. This is not evidence about the DHO804, but it is enough not to design around multi-binary responses without a dedicated DHO804 test:

- https://github.com/LikeDotAudio/OPEN-AIR/blob/c7b5022a4e8ef143f60699c5ae6bbdd50d4ad878/BackEnd/openair-yak/src/verbs/nab.rs

## Query audit

Steady-state live traffic after this pass is intentionally narrow:

- initial connection: one full scope snapshot;
- live waveform: `DATA?` per frame, plus a write-only source select when switching channels;
- vertical live metadata: one preamble on cache miss; app-driven vertical scale/offset changes update a warm cache locally;
- horizontal live metadata: horizontal scale/position invalidates preamble; one fresh `PREamble?` is taken after the interaction resumes;
- interactive drags: live acquisition is paused until commit to keep the DHO804 transaction stream stable;
- measurements: six statistic queries per selected measurement at the existing measurement cadence, now measured as a complete poll;
- trigger type change: one complete trigger-state readback after selecting Edge;
- Run/Stop/Single: no status query readback;
- deep capture: full state read plus RAW waveform operations; candidate for a narrower pre-capture read;
- raw SCPI: arbitrary and therefore invalidates local waveform metadata assumptions.

## Transport and prior art

Rigol Web is LAN-only for the scope. USB is not available in this deployment and is not a candidate transport for this workstream.

`ScpiTransport` uses raw TCP with `NODELAY`; transferring 500-1000 waveform bytes over LAN is negligible compared with the observed tens of milliseconds of scope response latency.

Existing DHO800 community code uses the same basic source/mode/format/data sequence rather than exposing a known faster waveform command. `MasterJubei/pydho800` uses TCP port 5555 and an ASCII waveform path, so Rigol Web's BYTE + cached-metadata path is already leaner for live display:

- https://github.com/MasterJubei/pydho800

Norbert Kiszka's DHO800/900 firmware-mod changelog explicitly claims optimization of many SCPI commands. It does not publish enough detail to quantify `DATA?` improvement, but it is additional evidence that scope-side SCPI processing overhead is a plausible limit:

- https://www.patreon.com/NorbertKiszka/posts/dho800-900-mod-131407128

## Next hardware run

1. Capture the two startup `*:summary` probe lines and use their median/spread, not the original single comparison, to decide whether batching/source+query chaining is useful.
2. Pan horizontal position and scale and verify the scope/live path remains stable with acquisition paused during the drag and resumed after commit.
3. Confirm the first resumed frame performs one fresh `PREamble?` and the waveform X alignment is correct.
4. Enable one measurement, then several, and capture `measurements:complete` plus the individual statistic timings to quantify actual link occupancy.
5. After hardware-truth requirements are clarified, reduce deep-capture preflight from a full scope snapshot to only the fields it genuinely needs.

Do not optimize uPlot rendering unless a later browser trace shows main-thread/paint pressure after acquisition cadence improves.
