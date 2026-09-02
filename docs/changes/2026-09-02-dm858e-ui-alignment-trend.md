# DM858E UI alignment and browser snapshot trend

Date: 2026-09-02

## What changed

The DM858E route now follows the same frontend shape as the DHO804 route more closely:

- route code owns binding/orchestration rather than hand-building the instrument header;
- a dedicated `DmmToolbar` wraps the shared `InstrumentHeader`, matching the scope-side toolbar boundary;
- the main layout uses the same fixed 360 px control column and shared `control-stack` pattern as the scope;
- the measurement side is a dedicated column containing the primary DMM reading and a trend plot;
- browser-local Horizontal controls sit in the same control rail as the DMM function/range controls;
- raw SCPI remains absent from both primary instrument screens.

The DMM trend uses the existing `uPlot` dependency. No new package, server endpoint, instrument command, hardware, or BOM item is required.

## Trend horizontal controls

The trend keeps a rolling five-minute browser history, but five minutes is a retention ceiling rather than a fixed viewport.

Horizontal controls mirror the scope-side interaction model:

- `Time/div` controls ten horizontal divisions with stepped values from 100 ms/div through 30 s/div;
- the default is 1 s/div, so the viewport is ten seconds wide;
- `Position = 0 s` keeps the newest received snapshot on the right edge from the first sample onward;
- negative Position values pan backward through retained history immediately, including while less than one viewport of history exists;
- `Latest` returns Position to zero;
- changing DMM measurement function resets Position to zero while preserving Time/div.

At 30 s/div the full five-minute retained history fits in the ten-division viewport.

## Streaming renderer behavior

uPlot requires aligned X/Y arrays with matching lengths and at least two X values. The DMM trend therefore supplies renderer-only null padding until two real browser snapshots exist; the retained measurement history itself is not padded with fabricated values.

Each received snapshot uses uPlot's normal `setData()` update path so data changes invalidate and redraw the plot, then the browser-local horizontal viewport is reapplied. The Y scale also has a finite fallback range for the no-numeric-data case so an initial empty, overload, or unavailable state can render safely.

The previous implementation instantiated uPlot with zero-length aligned arrays and used `setData(..., false)`, which could produce a startup `null is not iterable` exception and could leave streaming data visually stale until another scale invalidation occurred.

## Trend semantics

The plot is deliberately a **browser-received latest-snapshot trend**.

`DATA:LAST?` remains a latest-reading snapshot and is not treated as a uniquely identified physical-conversion stream. Each snapshot delivered to the browser is timestamped with browser monotonic time and appended to the plot. At the current default 100 ms DMM poll interval this is nominally about 10 plot updates/s, subject to SCPI work and transport timing.

Consequences:

- repeated identical snapshot values are still plotted when they are delivered;
- changed values do not imply that every physical conversion between snapshots is represented;
- overload and unavailable snapshots produce gaps rather than fabricated numeric values;
- the plot history resets when the selected measurement function changes or the route is remounted;
- only the most recent five minutes are retained in browser memory;
- no min/max/average/standard-deviation or conversion-count statistics are derived from this snapshot history.

This narrows the earlier `docs/dm858e-ui-plan.md` restriction: a **visual snapshot trend is allowed now**, while conversion-counted logging and statistical analysis still require a verified one-event-per-measurement sample stream.

## Cost

Incremental cost: **$0**. The browser reuses the `uPlot` package already required by the scope waveform renderer and stores only a small in-memory rolling history.

## Validation

`src/web/components/dmm/dmm-trend.test.ts` covers numeric points, unavailable-reading gaps, rolling-history trimming, immediate latest-edge scrolling, time/div and Position viewport math, pre-two-sample render data, finite empty Y ranges, horizontal-limit clamping, and invalid elapsed timestamps.
