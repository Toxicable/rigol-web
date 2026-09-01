# Scope UI statistics and SCPI diagnostics

Change set:

- Read DHO800 native measurement statistics (current, min, max, average, standard deviation, count) via `:MEASure:STATistic:ITEM?` and render them in the waveform measurement overlay.
- Keep the measurement selector stacked under the waveform column so it does not span beneath the control sidebar.
- Color the trigger marker from its source channel and label it `TCH<n>`.
- Simplify the DHO804 toolbar by removing duplicated model/serial identity and spelling out acquisition state labels (`Triggered`, `Waiting`, `Running`, `Auto`, `Stopped`) instead of raw SCPI abbreviations such as `T'D`/`TD`.
- Rename channel `Span` to `Range` because the displayed value is the full 8-division vertical range.
- SCPI transport and instrument-lifecycle diagnostics are always enabled; there is no runtime feature flag. Expected in-flight cancellation during deliberate runtime stop is logged as cancellation instead of an operation failure.
- WebSocket protocol version is bumped from 4 to 5 because `MeasurementValue` now carries a required `statistics` object instead of one flat `value` field. This is a deliberate hard cut; old browser/server bundles must fail the protocol handshake rather than mix shapes.

The measurement statistic commands are from the RIGOL DHO800/DHO900 Programming Guide, section `:MEASure:STATistic:ITEM`.

Cost impact: $0. No added hardware, services, or paid dependencies.
