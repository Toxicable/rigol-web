# Scope UI statistics and SCPI diagnostics

Change set:

- Read DHO800 native measurement statistics (current, min, max, average, standard deviation, count) via `:MEASure:STATistic:ITEM?` and render them in the waveform measurement overlay.
- Keep the measurement selector stacked under the waveform column so it does not span beneath the control sidebar.
- Color the trigger marker from its source channel and label it `TCH<n>`.
- Simplify the DHO804 toolbar by removing duplicated model/serial identity and spelling out acquisition state labels.
- Rename channel `Span` to `Range` because the displayed value is the full 8-division vertical range.
- Add opt-in SCPI transport diagnostics under `RIGOL_SCPI_DEBUG=1`, and avoid reporting expected in-flight cancellation as an operation failure when a runtime is deliberately stopped.

The measurement statistic commands are from the RIGOL DHO800/DHO900 Programming Guide, section `:MEASure:STATistic:ITEM`.

Cost impact: $0. No added hardware, services, or paid dependencies.
