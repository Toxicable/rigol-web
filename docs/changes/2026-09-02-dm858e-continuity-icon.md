# DM858E continuity function icon

Date: 2026-09-02

The `/dm858e` function selector now shows a speaker/buzzer continuity icon beside the existing `Cont` label.

Implementation:

- inline SVG in `src/web/components/dmm/dmm-controls.tsx`;
- styled through the existing DMM stylesheet;
- no icon package or runtime dependency added;
- accessible button name remains the existing `Continuity` title/text context;
- incremental hardware/package cost: **A$0**.

This is a presentation-only change. It does not alter the DM858E continuity SCPI behavior or add undocumented continuity-threshold controls.
