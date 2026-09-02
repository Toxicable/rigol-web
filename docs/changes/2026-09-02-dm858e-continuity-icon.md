# DM858E measurement-function icons

Date: 2026-09-02

The `/dm858e` function selector now shows compact meter-style symbols for every primary measurement function rather than treating continuity as a one-off icon.

Function symbols:

- DC voltage: `V⎓`
- AC voltage: `V~`
- DC current: `A⎓`
- AC current: `A~`
- 2-wire resistance: `Ω`
- 4-wire resistance: `4WΩ`
- continuity: speaker/buzzer
- diode: diode schematic symbol
- frequency: sinusoidal waveform
- period: square waveform with period markers
- capacitance: capacitor schematic symbol
- temperature: thermometer

Implementation:

- meter glyphs and inline SVG live in `src/web/components/dmm/dmm-controls.tsx`;
- styling is local to the existing DMM stylesheet;
- the existing text labels remain visible, so the icons are supplementary rather than the only function identification;
- icons are `aria-hidden`; the button text/title remains the accessible name/context;
- no icon package or runtime dependency was added;
- incremental hardware/package cost: **A$0**.

This is presentation-only. It does not alter DM858E SCPI behavior or add undocumented controls.
