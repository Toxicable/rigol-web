# Scope plot and control cleanup

Date: 2026-09-06

## Scope graticule

The DHO804 waveform plot renders a fixed 10 × 8 graticule inside uPlot's own canvas. The first implementation delegated the graticule to uPlot axis `grid` rendering, but the deployed mode-2 waveform view still produced axis labels without visible grid lines. The graticule is therefore drawn explicitly in a `drawClear` hook using `uPlot.bbox`, before waveform series are drawn.

This makes the grid independent of enabled-channel axes, faceted/mode-2 axis behavior, and the old hidden CSS background layer. It always spans the actual plot rectangle with eleven vertical boundaries for ten horizontal divisions and nine horizontal boundaries for eight vertical divisions. Channel Y scales remain independent and fixed to their scope V/div and offset state.

## Channel and trigger markers

Vertical marker geometry uses uPlot's actual plot rectangle rather than the complete widget height. A channel ground/reference marker therefore lines up with the waveform's eight-division plotting area instead of including the time axis or other chart chrome in its coordinate system.

Channel markers remain fully visible when their true zero/reference point is outside the current Y range. The visible marker is inset by half its height at the top or bottom edge, while drag math retains the true edge-rebased plot coordinate. A small up/down point on the marker indicates whether the channel reference and offset trace frame lie above or below the visible plot. This indicator follows channel scale/offset state; it does not infer direction from transient sample extrema.

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
