# Scope plot and control cleanup

Date: 2026-09-06

## Scope graticule

The DHO804 waveform plot renders the 10 × 8 graticule through uPlot axes rather than a separate CSS layer behind the uPlot host. The horizontal axis provides the ten vertical grid divisions. The first enabled channel axis provides the eight horizontal grid divisions; all channel Y scales still remain independent and fixed to their scope V/div and offset state.

## Channel and trigger markers

Vertical marker geometry uses uPlot's actual plot rectangle rather than the complete widget height. A channel ground/reference marker therefore lines up with the waveform's eight-division plotting area instead of including the time axis or other chart chrome in its coordinate system.

Channel markers remain fully visible when their true zero/reference point is outside the current Y range. The visible marker is inset by half its height at the top or bottom edge, while drag math retains the true edge-rebased plot coordinate. A small up/down point on the marker indicates whether the reference is above or below the visible plot.

The Edge trigger marker uses the same plot-relative vertical geometry, and its drag guide is limited to the actual plot width.

## Numeric controls

Channel scale/offset, horizontal Time/div/position and Edge trigger level use one shared editable numeric control. The input is text-backed rather than a continuously committed HTML number input:

- authoritative values are shown with at most six significant digits;
- the field may be emptied while editing;
- Enter or blur commits a finite valid number;
- Escape discards the draft;
- an empty/invalid draft restores the authoritative value instead of becoming zero;
- control writes happen on commit rather than every keystroke.

This keeps raw instrument floating-point tails out of the control rail and makes select-all/backspace/retype workflows normal.

## Cost

Incremental cost: **$0**. This is a frontend-only change using the existing React, CSS and uPlot dependencies.
