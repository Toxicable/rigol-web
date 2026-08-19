# Waveform Architecture

## Overview

Rigol Web treats live waveform display and deep acquisition viewing as different workloads.

Live waveforms optimise for freshness and low latency.

Deep acquisitions optimise for preserving the complete stopped acquisition while only sending/rendering the resolution currently useful to the browser.

The byte-for-byte browser/server binary format is defined in `waveform-protocol.md`.

## DHO804 waveform boundary

The DHO804 Programming Guide exposes waveform data through:

- `:WAVeform:SOURce`
- `:WAVeform:MODE`
- `:WAVeform:FORMat`
- `:WAVeform:POINts`
- `:WAVeform:STARt`
- `:WAVeform:STOP`
- `:WAVeform:DATA?`
- `:WAVeform:PREamble?` and related X/Y metadata queries

Native WORD/BYTE data arrives in TMC/IEEE-style binary blocks.

That native representation is private to the DHO804 driver. The browser does not parse Rigol binary blocks or native sample codes.

The driver must obtain the metadata associated with the waveform read and convert native sample codes to numeric amplitude values before the browser-facing binary frame is created.

## Live waveform path

While the DHO804 is running:

```text
DHO804 NORMAL waveform
        |
        v
Dho804Driver
native block -> amplitude values
        |
        v
LiveWaveformService
        |
        | binary WebSocket frame
        v
browser waveform layer
        |
        v
uPlot
```

Use the DHO804 NORMAL/screen waveform path with a deliberately small point count.

The Programming Guide allows 1 through 1,000 points in NORMAL mode. Start with 1,000 points and benchmark. A smaller value is acceptable if it materially reduces interaction blocking on the real scope.

Live waveform data is disposable. If a newer waveform is wanted before an older one has been delivered/rendered, discard the stale waveform and prefer the newest one.

Do not queue a backlog of live acquisitions.

The scheduler should effectively allow:

- one live waveform transaction in progress
- one `fresh waveform wanted` indication

No more.

## Multi-channel live acquisition

The DHO804 waveform source is selected per channel, so enabled channels are read as separate serialized SCPI transactions.

Do not attempt simultaneous per-channel reads over multiple scope sockets.

A live display cycle can walk the currently enabled channels, but after each complete channel transaction the scheduler regains control. Higher-priority interaction can therefore run before the next channel read begins.

Do not treat a four-channel live refresh as one uninterruptible application transaction.

Each channel frame has its own sequence number and can update independently in the browser.

## Deep acquisition path

When the scope is stopped or after a single acquisition, use the RAW waveform path to retrieve acquisition memory.

The DHO804 Programming Guide states that RAW internal-memory data can only be read while stopped and that the instrument cannot be operated while that read is in progress.

Treat each native RAW `:WAVeform:DATA?` transaction as non-preemptible once it starts.

```text
DHO804 RAW acquisition
        |
        v
Dho804Driver
        |
        v
server full capture
Float32Array per channel
        |
        v
server min/max downsampling
        |
        | display-resolution binary window
        v
browser overscan cache
        |
        v
uPlot
```

The browser does not receive tens of millions of samples merely to discard most of them before rendering.

## Native deep reads

The DHO804 supports up to 25 Mpts in the DHO804 single-channel case.

Do not assume the entire native RAW block must be requested in one giant transfer. The Programming Guide supports `:WAVeform:STARt` and `:WAVeform:STOP`, and notes that internal-memory waveform data can be returned in consecutive blocks.

The DHO804 driver may read a deep channel in bounded chunks when that improves failure handling or memory behaviour, but the application-level deep capture remains one explicit operation.

Chunk size is an implementation/benchmark choice, not a browser protocol property.

Do not interleave unrelated SCPI commands inside a native RAW read sequence if doing so risks changing the acquisition or waveform configuration being captured.

## Server-owned captures

A completed deep capture has a positive ID and complete per-channel metadata.

Conceptually:

```ts
interface DeepCapture {
  id: number;
  channels: DeepChannelCapture[];
}

interface DeepChannelCapture {
  channel: Channel;
  unit: ChannelUnit;
  samples: Float32Array;
  xIncrement: number;
  xOrigin: number;
  xReference: number;
}
```

`Float32Array` stores amplitude values in the channel's current display unit after the DHO804 native conversion has been applied.

This uses more memory than retaining 16-bit native codes, but the worst DHO804 v1 capture is still modest for the Node process:

- one channel × 25 Mpts × 4 bytes ≈ 100 MB
- two channels × 10 Mpts × 4 bytes ≈ 80 MB total
- four channels × 5 Mpts × 4 bytes ≈ 80 MB total

The simpler normalized representation avoids leaking uncertain native WORD encoding details through the rest of the application and makes min/max downsampling straightforward.

Version 1 retains only the **latest completed deep capture**. Starting and successfully completing a newer deep capture replaces the previous retained capture. Old capture IDs then become invalid.

This bounds memory without a capture-cache eviction subsystem. Multiple retained captures can be added later if there is a real use for comparison/history.

An in-progress new capture does not destroy the previous completed capture until the new one succeeds.

## Capture consistency

A deep capture uses the channels enabled when the request begins.

Read the authoritative state first enough to determine the enabled channels and ensure the scope is stopped.

For each retained channel, capture:

- all requested RAW samples
- the waveform X metadata associated with that acquisition
- the channel amplitude unit

If the scope connection fails or native data is malformed before all selected channels complete, the new capture fails as a whole. Do not publish a `DeepCaptureReady` containing an accidental partial set.

## Viewport requests

The browser requests the visible source range and display width using zero-based, half-open sample indices:

```ts
interface WaveformViewportRequestMessage {
  type: MessageType.WaveformViewportRequest;
  requestId: number;
  captureId: number;
  channel: Channel;
  startSample: number;
  endSample: number;
  pixelWidth: number;
}
```

The server may expand the requested range for overscan.

The response contains display-sized indexed amplitude points rather than the complete underlying capture.

See `waveform-protocol.md` for exact binary framing.

## Downsampling

Do not downsample by selecting every Nth sample. That can miss narrow glitches entirely.

Use min/max bucketing so the visible envelope and short excursions are preserved.

For each horizontal bucket:

1. find the minimum and its original source sample index
2. find the maximum and its original source sample index
3. emit the extrema in source-index order
4. if min and max are the same source point, emit it once

The binary protocol includes a source sample index with every emitted amplitude, so the browser preserves the real temporal ordering of extrema.

For a visible range already close to display resolution, return raw/near-raw points instead of downsampling.

A sensible initial target is approximately two emitted extrema per horizontal pixel at most. Benchmark and adjust rather than creating a fixed architecture around an exact ratio.

Typical behaviour for a 1,600 px viewport is therefore a few thousand emitted points even when millions of source samples are visible.

## Panning and overscan

Do not make every pixel of a drag wait for a server round trip.

Viewport responses include data beyond the immediately visible range. Start with approximately 2x the visible source width centred around the requested viewport where capture boundaries permit it.

Small pans operate entirely on cached browser data.

When the visible viewport approaches the edge of the cached range, request a new overscanned window in the background.

A newer viewport request supersedes an older one that has not yet become useful to the browser.

## Zooming

Zooming changes the requested source sample range and therefore the appropriate downsampling level.

When sufficiently zoomed in, send every source sample for the overscanned requested range.

The browser should never need to re-read the DHO804 merely because the user pans or zooms within the retained deep capture.

## Initial implementation

Start with straightforward on-demand min/max downsampling over the normalized `Float32Array`.

Do not initially build a multiresolution pyramid, GPU downsampler, worker farm or custom database/cache.

Instrument viewport-generation cost. If repeated scans over large captures become material, add a cached multiresolution min/max representation later.

## Waveform metadata

The DHO804 driver must retain enough native metadata to convert its waveform codes correctly, including the Rigol equivalents of:

- X increment
- X origin
- X reference
- Y increment
- Y origin
- Y reference

After server conversion, browser waveform frames carry:

- channel
- channel amplitude unit
- source sample range
- per-point source sample index
- amplitude value
- X increment
- X origin
- X reference

The browser therefore receives display-ready Y values and does not need Rigol Y code-scaling metadata.

## Renderer

uPlot is the selected waveform renderer.

Waveform sample arrays do not enter React or Zustand state.

The browser waveform layer decodes the binary frame, derives X values from source indices and X metadata, then updates the existing uPlot instance imperatively.

uPlot receives data at sensible display resolution. It is not responsible for solving the full-acquisition-depth problem.

## Native WORD format verification

The DHO804 is a 12-bit scope, so native WORD transfers are the intended deep-capture path because BYTE cannot preserve the full acquisition resolution.

The Programming Guide states that WORD uses two bytes per point but does not clearly specify native WORD byte ordering/signedness in the waveform command section available to us.

Do not guess this at the browser protocol boundary.

The SCPI backend should isolate native WORD decoding in one tested function and verify it against the real DHO804 before treating deep WORD capture as complete. A BYTE capture plus known waveform or ASCII comparison can be used as a bench cross-check.

This verification item belongs in the integration/real-scope test pass.

## Failure behaviour

Live waveform failure drops the affected frame and reports/records the failure without creating a stale frame backlog.

A deep capture failure fails the explicit capture request. Keep the previous completed capture, if any.

A malformed or incomplete native binary block means the SCPI stream is no longer trustworthy. Follow the transport failure policy: fail loudly and recreate the scope connection rather than guessing at framing.
