# Waveform Architecture

## Overview

Rigol Web treats live waveform display and deep acquisition viewing as different workloads.

Live waveforms optimise for freshness and low latency.

Deep acquisitions optimise for preserving the full capture while only sending/rendering the resolution currently useful to the browser.

## Live waveform path

While the DHO804 is running:

```text
DHO804 NORMAL waveform
        |
        v
Rigol Web server
        |
        | binary WebSocket frame
        v
browser waveform layer
        |
        v
uPlot
```

Use the DHO804 NORMAL/screen waveform path with a deliberately small point count.

Live waveform data is disposable. If a newer waveform is available before an older one has been delivered/rendered, discard the stale waveform and prefer the newest one.

Do not queue a backlog of live acquisitions.

## Deep acquisition path

When the scope is stopped or after a single acquisition, use the RAW waveform path to retrieve acquisition memory.

The server owns the complete raw deep capture.

```text
DHO804 RAW acquisition
        |
        v
server full capture
Int16Array per channel
        |
        v
server min/max downsampling
        |
        | display-resolution window
        v
browser cache
        |
        v
uPlot
```

The browser does not receive tens of millions of samples merely to discard most of them before rendering.

## Server-owned captures

A deep capture should have a stable identifier and complete metadata.

Conceptually:

```ts
interface DeepCapture {
  id: number;
  channels: DeepChannelCapture[];
}

interface DeepChannelCapture {
  channel: 1 | 2 | 3 | 4;
  samples: Int16Array;
  xIncrement: number;
  xOrigin: number;
  xReference: number;
  yIncrement: number;
  yOrigin: number;
  yReference: number;
}
```

Fields that must exist for a valid capture are required, not optional.

## Viewport requests

The browser requests the range and display resolution needed for the current view.

Conceptually:

```ts
interface WaveformViewportRequest {
  captureId: number;
  channel: 1 | 2 | 3 | 4;
  startSample: number;
  endSample: number;
  pixelWidth: number;
}
```

The response contains a display-sized representation rather than the complete underlying capture.

## Downsampling

Do not downsample by selecting every Nth sample. That can miss narrow glitches entirely.

Use min/max bucketing so the visible envelope and short excursions are preserved.

For each horizontal bucket, retain at least the minimum and maximum sample values in temporal order.

Typical behaviour for a 1600 px viewport might be:

```text
25,000,000 visible samples -> a few thousand rendered values
2,500,000 visible samples  -> a few thousand rendered values
25,000 visible samples      -> a few thousand rendered values
~1,000 visible samples      -> raw/near-raw samples
```

The renderer should receive an amount of data related to display resolution, not acquisition depth.

## Panning and overscan

Do not make every pixel of a drag wait for a server round trip.

Viewport responses should include data beyond the immediately visible range, for example roughly 2x to 3x the visible width.

```text
             visible viewport
          +--------------------+

    +----------------------------------+
    |      cached overscan region      |
    +----------------------------------+
```

Small pans operate entirely on cached browser data.

When the visible viewport approaches the edge of the cached range, request a new overscanned window in the background.

This keeps panning responsive while retaining server-side ownership of the full capture.

## Zooming

Zooming changes the requested sample range and therefore the appropriate downsampling level.

When sufficiently zoomed in, send raw samples for the visible range rather than downsampled buckets.

The browser should never need to re-read the DHO804 merely because the user pans or zooms within an already acquired deep capture.

## Initial implementation

Start with straightforward on-demand min/max downsampling over the raw capture.

Do not initially build a complex multiresolution pyramid.

Instrument the cost of viewport generation. If repeated scans over large captures become significant, add a cached multiresolution min/max representation on the server later.

## Waveform metadata

Waveform data must retain enough information to convert sample codes to time and voltage values, including the equivalent of:

- channel
- sample count/range
- X increment
- X origin
- X reference
- Y increment
- Y origin
- Y reference

Use typed arrays and binary WebSocket payloads for sample data.

## Renderer

uPlot is the selected waveform renderer.

uPlot should only receive data at a sensible display resolution. It is not responsible for solving the full-acquisition-depth problem.

This separation allows us to use a mature charting library while keeping deep captures responsive.
