# DM858E UI alignment and browser snapshot trend

Date: 2026-09-02

## What changed

The DM858E route now follows the same frontend shape as the DHO804 route more closely:

- route code owns binding/orchestration rather than hand-building the instrument header;
- a dedicated `DmmToolbar` wraps the shared `InstrumentHeader`, matching the scope-side toolbar boundary;
- the main layout uses the same fixed 360 px control column and shared `control-stack` pattern as the scope;
- the measurement side is a dedicated column containing the primary DMM reading and a trend plot;
- raw SCPI remains absent from both primary instrument screens.

The DMM also now renders a rolling five-minute trend with the existing `uPlot` dependency. No new package, server endpoint, instrument command, hardware, or BOM item is required.

## Trend semantics

The plot is deliberately a **browser-received latest-snapshot trend**.

`DATA:LAST?` remains a latest-reading snapshot and is not treated as a uniquely identified physical-conversion stream. Each snapshot delivered to the browser is timestamped with browser monotonic time and appended to the plot. At the current default 100 ms DMM poll interval this is nominally about 10 plot updates/s, subject to SCPI work and transport timing.

Consequences:

- repeated identical snapshot values are still plotted when they are delivered;
- changed values do not imply that every physical conversion between snapshots is represented;
- overload and unavailable snapshots produce gaps rather than fabricated numeric values;
- the plot resets when the selected measurement function changes or the route is remounted;
- only the most recent five minutes are retained in browser memory;
- no min/max/average/standard-deviation or conversion-count statistics are derived from this snapshot history.

This narrows the earlier `docs/dm858e-ui-plan.md` restriction: a **visual snapshot trend is allowed now**, while conversion-counted logging and statistical analysis still require a verified one-event-per-measurement sample stream.

## Cost

Incremental cost: **$0**. The browser reuses the `uPlot` package already required by the scope waveform renderer and stores only a small in-memory rolling history.

## Validation

`src/web/components/dmm/dmm-trend.test.ts` covers numeric points, unavailable-reading gaps, rolling-window trimming, and invalid elapsed timestamps.
