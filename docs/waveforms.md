# Waveform Architecture

## Overview

Rigol Web treats live waveform display and deep acquisition viewing as different workloads.

Live waveforms optimise for freshness and low latency. Deep acquisitions preserve the complete stopped acquisition while only sending/rendering the resolution useful to the browser.

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

Native WORD/BYTE data arrives in TMC/IEEE-style binary blocks. That native representation is private to the DHO804 driver. The driver obtains the metadata associated with the read and converts native sample codes to numeric amplitude values before creating the browser-facing frame.

## Live waveform path

While the DHO804 is running:

```text
DHO804 NORMAL waveform
        |
        v
Dho804Driver
native blocks -> amplitude values
        |
        v
LiveWaveformService
        |
        | binary WebSocket frames
        v
browser waveform layer
        |
        v
uPlot
```

Live acquisition is fixed at NORMAL/BYTE/999 points. The DHO804 returns 999 samples when the requested NORMAL point count is 1000, and lower point counts were measured to crop the visible time span instead of decimating the whole screen. There is no runtime live-point-count option.

Live waveform data is disposable. Do not queue a backlog of live acquisitions. The scheduler allows one live waveform batch in progress and one `fresh waveform wanted` indication.

## Multi-channel live acquisition

Every live refresh is one SCPI program message containing all currently enabled channels in display order:

```text
:WAVeform:SOURce CHANnel1;:WAVeform:DATA?;
:WAVeform:SOURce CHANnel2;:WAVeform:DATA?;...
```

The actual message is one line; it is wrapped above only for readability.

`ScpiTransport` parses the expected number of IEEE488.2 binary blocks from that transaction. Returned blocks may be semicolon-separated, line-separated, or directly adjacent length-delimited blocks. The parser rejects malformed framing, unexpected trailing bytes, or a response count that cannot complete before timeout.

Each payload must contain exactly 999 bytes and is mapped by position to its requested channel. Each browser channel frame retains an independent sequence number.

This is a deliberate hard cut. Do not open multiple scope sockets for simultaneous channel reads and do not fall back to per-channel transactions when a compound batch fails; a malformed/incomplete compound response invalidates the SCPI connection so the runtime reconnects cleanly.

A live batch is one scheduler operation. Interactive horizontal drags pause live acquisition before issuing scope writes, so the longer multi-channel binary transaction is never intentionally interleaved with timebase mutation.

## Live metadata

Channel units are seeded from the initial scope snapshot and cached. NORMAL preambles are cached per channel.

On a preamble cache miss, the driver selects that channel and queries `:WAVeform:PREamble?` before issuing the live batch. Once the caches are warm, a stable cycle contains only the one compound source/data program message.

App-driven vertical scale/offset writes update cached Y metadata locally. Horizontal scale/position writes invalidate live preambles; acquisition is paused during the gesture, and the first resumed cycle refreshes the required preamble metadata before continuing.

Raw SCPI invalidates waveform setup and metadata caches because arbitrary commands may alter scope state.

## Deep acquisition path

When the scope is stopped or after a single acquisition, use the RAW waveform path to retrieve acquisition memory.

The DHO804 Programming Guide states that RAW internal-memory data can only be read while stopped and that the instrument cannot be operated while that read is in progress. Treat each native RAW `:WAVeform:DATA?` transaction as non-preemptible once it starts.

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

The DHO804 supports up to 25 Mpts in the single-channel case.

The Programming Guide supports `:WAVeform:STARt` and `:WAVeform:STOP` and notes that internal-memory waveform data can be returned in consecutive blocks. The driver may therefore read a deep channel in bounded chunks, but the application-level deep capture remains one explicit operation.

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

`Float32Array` stores amplitude values in the channel's current display unit after native conversion.

Worst-case retained data remains modest for the Node process:

- one channel × 25 Mpts × 4 bytes ≈ 100 MB
- two channels × 10 Mpts × 4 bytes ≈ 80 MB total
- four channels × 5 Mpts × 4 bytes ≈ 80 MB total

Version 1 retains only the latest completed deep capture. A failed replacement capture leaves the previous completed capture intact.

## Capture consistency

A deep capture uses the channels enabled when the request begins. Read enough authoritative hardware state to determine the enabled channels and ensure the scope is stopped.

For each retained channel capture:

- all requested RAW samples
- waveform X metadata associated with that acquisition
- channel amplitude unit

If the scope connection fails or native data is malformed before all selected channels complete, the new capture fails as a whole.

## Viewport requests

The browser requests the visible source range and display width using zero-based, half-open sample indices. The server may expand the requested range for overscan and responds with display-sized indexed amplitude points rather than the complete capture.

See `waveform-protocol.md` for exact binary framing.

## Downsampling

Do not downsample by selecting every Nth sample. Use min/max bucketing so narrow glitches and the visible envelope are preserved.

For each horizontal bucket:

1. find the minimum and its original source sample index
2. find the maximum and its original source sample index
3. emit the extrema in source-index order
4. if min and max are the same source point, emit it once

For a visible range already close to display resolution, return raw/near-raw points instead of downsampling.

## Panning and overscan

Deep-capture viewport responses include data beyond the immediately visible range. Small pans operate entirely on cached browser data; when the viewport approaches a cache edge, request a new overscanned window in the background.

A newer viewport request supersedes an older one that has not yet become useful to the browser.

## Waveform metadata

The driver retains enough native metadata to convert waveform codes correctly:

- X increment
- X origin
- X reference
- Y increment
- Y origin
- Y reference

Browser waveform frames carry channel, unit, source range, per-point source index, amplitude value, X increment, X origin and X reference. The browser receives display-ready Y values and does not parse Rigol scaling metadata.

## Renderer

uPlot is the waveform renderer. Waveform arrays do not enter React or Zustand state. The browser waveform layer decodes each binary frame, derives X values from source indices and X metadata, then updates the existing uPlot instance imperatively.

## Native WORD format verification

The DHO804 is a 12-bit scope, so native WORD transfers are the intended deep-capture path because BYTE cannot preserve the full acquisition resolution.

The Programming Guide states that WORD uses two bytes per point but does not clearly specify native WORD byte ordering/signedness in the waveform command section available to us. Keep native WORD decoding isolated and verify it against the real DHO804 before treating deep WORD capture as complete.

## Failure behaviour

Live waveform failure drops the affected batch and reports the failure without creating a stale backlog. A malformed or incomplete native binary response makes the SCPI stream untrustworthy; fail loudly and recreate the scope connection rather than guessing at framing.

A deep capture failure fails the explicit request and preserves the previous completed capture, if any.
