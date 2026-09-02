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
- `Position = 0 s` keeps the newest browser trend sample on the right edge from the first sample onward;
- negative Position values pan backward through retained history immediately, including while less than one viewport of history exists;
- `Latest` returns Position to zero;
- changing DMM measurement function resets Position to zero while preserving Time/div.

At 30 s/div the full five-minute retained history fits in the ten-division viewport.

## Streaming renderer behavior

uPlot requires aligned X/Y arrays with matching lengths and at least two X values. The DMM trend therefore supplies renderer-only null padding until two real browser trend samples exist; the retained trend history itself is not padded with fabricated values.

The trend has its own deterministic 100 ms browser sampling clock. Each tick samples the latest DMM display state already held in the browser, appends it using browser monotonic time, then updates uPlot with `setData(..., false)` followed by an explicit X-scale update. The X-scale update is the redraw/invalidation boundary and also causes the auto Y scale to be recalculated for the visible data.

This is intentionally independent of WebSocket message frequency. The DMM runtime may suppress identical display snapshots because they are redundant for the primary reading, but a stable value still needs to form a flat line that advances through time in the trend. Sampling the latest browser state locally preserves that behavior without adding SCPI requests or WebSocket traffic.

The Y scale has a finite fallback range for the no-numeric-data case so an initial empty, overload, or unavailable state can render safely. Sparse data also enables point markers while there are too few visible numeric samples to form a useful line, so a lone valid reading is not invisible.

The earlier implementations exposed two separate problems:

- zero-length aligned arrays could produce a startup `null is not iterable` exception;
- driving trend time directly from deduplicated DMM snapshot messages meant a stable reading could leave the graph with only one invisible sample and no visible time progression.

## Trend semantics

The plot is deliberately a **browser-sampled latest-display-state trend**.

`DATA:LAST?` remains latest display state and is not treated as a uniquely identified physical-conversion stream. At 100 ms intervals the browser records whatever latest DMM reading state it currently holds. This gives a continuous visual trend for stable readings without pretending that each plotted point is a distinct physical conversion.

Consequences:

- an unchanged latest reading is repeated across browser trend samples, producing a flat line over time;
- changed values do not imply that every physical conversion between browser samples is represented;
- overload and unavailable states produce gaps rather than fabricated numeric values;
- the plot history resets when the selected measurement function changes or the route is remounted;
- only the most recent five minutes are retained in browser memory;
- no min/max/average/standard-deviation or conversion-count statistics are derived from this trend history.

This narrows the earlier `docs/dm858e-ui-plan.md` restriction: a **visual browser-sampled trend is allowed now**, while conversion-counted logging and statistical analysis still require a verified one-event-per-measurement sample stream.

## Cost

Incremental cost: **$0**. The browser reuses the `uPlot` package already required by the scope waveform renderer, adds no SCPI or WebSocket traffic, and stores only a small in-memory rolling history. At 100 ms sampling, five minutes is approximately 3,000 points.

## Validation

`src/web/components/dmm/dmm-trend.test.ts` covers the 100 ms sample cadence constant, repeated stable values, numeric points, unavailable-reading gaps, rolling-history trimming, immediate latest-edge scrolling, time/div and Position viewport math, pre-two-sample render data, sparse-point visibility, finite empty Y ranges, horizontal-limit clamping, and invalid elapsed timestamps.
