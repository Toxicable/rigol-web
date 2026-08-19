# Waveform Binary Protocol

## Purpose

This document defines the byte-for-byte browser/server binary waveform format used by Rigol Web.

The format is intentionally independent of the DHO804's native `:WAVeform:DATA?` representation.

The server parses Rigol TMC/IEEE blocks and converts DHO804 waveform codes into display-ready amplitude values before sending them to the browser. This keeps Rigol-specific byte ordering, `YORigin` and `YREFerence` handling inside the DHO804 driver and gives the browser one simple representation for both live and deep waveform data.

## Design goals

The binary format should:

- be quick to encode and decode
- be fixed-width and easy to validate
- carry no JSON inside binary frames
- work for live sequential samples and min/max-downsampled deep viewports
- preserve the actual source-sample position of downsampled extrema
- use stable numeric enums
- avoid optional fields
- avoid exposing native Rigol waveform codes to the browser

Bandwidth is not a primary concern on the local network. A simple 8-byte record is preferable to a more compressed variable representation.

## Shared constants

Shared code defines:

```ts
export const WAVEFORM_MAGIC = 0x46574752; // bytes "RGWF" in little-endian storage
export const WAVEFORM_FRAME_VERSION = 1;
export const WAVEFORM_HEADER_BYTES = 64;
export const WAVEFORM_POINT_BYTES = 8;

export enum WaveformKind {
  Live = 1,
  DeepViewport = 2,
}

export enum WaveformEncoding {
  IndexedFloat32 = 1,
}
```

`WaveformKind` must use the same stable values as `websocket-protocol.ts` rather than defining a second conflicting enum.

All multi-byte integers and floating-point fields use **little-endian** byte order.

## Header layout

Every binary waveform frame begins with exactly 64 bytes.

| Offset | Bytes | Type | Field | Meaning |
| ---: | ---: | --- | --- | --- |
| 0 | 4 | `uint32` | `magic` | `WAVEFORM_MAGIC` |
| 4 | 1 | `uint8` | `version` | waveform frame version, currently `1` |
| 5 | 1 | `uint8` | `kind` | `WaveformKind` |
| 6 | 1 | `uint8` | `channel` | `Channel`, 1 through 4 |
| 7 | 1 | `uint8` | `encoding` | `WaveformEncoding`, currently `1` |
| 8 | 4 | `uint32` | `sequence` | monotonically increasing frame sequence, wrapping naturally at `2^32` |
| 12 | 4 | `uint32` | `captureId` | `0` for live frames, positive ID for deep captures |
| 16 | 4 | `uint32` | `sourceStartSample` | first source sample covered by this response, zero-based inclusive |
| 20 | 4 | `uint32` | `sourceEndSample` | source range end, zero-based exclusive |
| 24 | 4 | `uint32` | `pointCount` | number of payload records |
| 28 | 4 | `uint32` | `headerBytes` | must be `64` for version 1 |
| 32 | 8 | `float64` | `xIncrement` | source sample interval in seconds |
| 40 | 8 | `float64` | `xOrigin` | source waveform X origin in seconds |
| 48 | 8 | `float64` | `xReference` | source waveform X reference in sample-index units |
| 56 | 1 | `uint8` | `yUnit` | `ChannelUnit` |
| 57 | 7 | bytes | reserved | all zero in version 1 |

The total frame size must be:

```text
64 + pointCount * 8
```

A decoder must reject a frame whose actual byte length does not match that expression.

## Sample indexing

Rigol SCPI uses one-based `:WAVeform:STARt` and `:WAVeform:STOP` positions.

Rigol Web uses **zero-based sample indices** everywhere outside the DHO804 driver.

The driver performs the conversion at its boundary.

`sourceStartSample` is inclusive and `sourceEndSample` is exclusive. This matches ordinary TypeScript array slicing and removes fencepost ambiguity from deep viewport requests.

The time corresponding to an individual payload record is:

```ts
const x = xOrigin + (sampleIndex - xReference) * xIncrement;
```

The DHO800 Programming Guide currently reports `XREFerence` as zero, but the field remains explicit in the protocol because it is part of the source waveform metadata and costs only eight bytes per frame.

## Payload layout

Version 1 has one encoding: `WaveformEncoding.IndexedFloat32`.

Each point is exactly eight bytes:

| Point offset | Bytes | Type | Field |
| ---: | ---: | --- | --- |
| 0 | 4 | `uint32` | source sample index |
| 4 | 4 | `float32` | amplitude value |

The amplitude value is already converted into the channel's current display amplitude unit. `yUnit` identifies that unit using `ChannelUnit` from `scope-types.ts`:

```ts
export enum ChannelUnit {
  Volts = 1,
  Amps = 2,
  Watts = 3,
  Unknown = 4,
}
```

Do not call the payload field `voltage` because the DHO804 can display a channel in amps, watts or an unknown/arbitrary amplitude unit.

The browser does not need DHO804 `YINCrement`, `YORigin` or `YREFerence` to draw this frame because the server has already applied the native conversion. Deep-capture storage may retain those native values internally so the server can reproduce exact amplitude values and perform exports later.

## Why source indices are included per point

A live NORMAL waveform is sequential, so its indices are usually consecutive.

A downsampled deep viewport is different. Min/max bucketing emits extrema from the original capture. The minimum and maximum can occur at different positions inside a bucket, and their temporal order matters.

Including the original source sample index with every emitted amplitude means the same payload representation can correctly describe:

- raw sequential live samples
- raw/near-raw deep viewport samples
- min/max-downsampled deep viewport points

No separate min/max record format is required.

## Live frames

For a live waveform frame:

```text
kind = WaveformKind.Live
captureId = 0
```

The DHO804 NORMAL waveform mode supports at most 1,000 requested points. A live frame therefore remains small even with the 8-byte indexed representation.

The server should use the waveform metadata associated with the same live read to populate `xIncrement`, `xOrigin`, `xReference` and `yUnit`.

Live `sequence` values let the browser discard old frames that arrive or are processed after a newer frame for the same channel.

Sequence comparison across wraparound does not need elaborate infrastructure initially. Normal unsigned wrapping after approximately four billion frames is sufficient; if a comparison is required, use standard modular unsigned comparison rather than assuming the value never wraps.

## Deep viewport frames

For a deep viewport frame:

```text
kind = WaveformKind.DeepViewport
captureId > 0
```

`sourceStartSample` and `sourceEndSample` identify the source range represented by the response, including any server-selected overscan.

The individual indexed points may be:

- every sample when the requested source range is already near display resolution
- min/max extrema when the source range is much larger than the display width

The payload remains ordered by ascending source sample index.

If both extrema in a min/max bucket occur at the same source sample, emit one point rather than a duplicate.

## Deep viewport request semantics

The JSON request uses zero-based half-open source ranges:

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

Requirements:

- `captureId` must be positive
- `startSample >= 0`
- `endSample > startSample`
- `pixelWidth > 0`

The requested range is the visible range. The server may expand it for overscan before producing the binary response. The expanded actual range is reported in the frame header.

A successful viewport request produces the binary frame. A failed request produces the normal JSON `CommandFailed` response with the same `requestId`.

The binary frame itself does not carry `requestId`; `captureId`, channel and represented source range are enough to associate the data with the current deep-capture view. The frontend should treat stale viewport frames as disposable if a newer viewport is already desired.

## DHO804 native waveform boundary

The DHO804 Programming Guide defines native WORD/BYTE `:WAVeform:DATA?` responses as TMC/IEEE-style blocks and gives the native amplitude conversion in terms of `YINCrement`, `YORigin` and `YREFerence`.

That format ends at the driver boundary.

The browser must never need to know:

- Rigol TMC block headers
- whether the DHO804 was queried with WORD or BYTE format
- the native WORD byte order
- Rigol abbreviated SCPI return tokens
- native `YORigin`/`YREFerence` code offsets

This separation is deliberate. It allows the SCPI backend to choose or bench-correct the most efficient reliable native transfer format without changing the browser protocol.

## Server conversion

Conceptually, the DHO804 driver returns waveform samples and metadata in a typed internal form. The waveform service then emits `IndexedFloat32` display values.

For a native code `raw`, the Programming Guide gives the general BYTE example:

```text
(raw - YORigin - YREFerence) * YINCrement
```

The exact native WORD decoding must be verified against the real DHO804 before relying on it. Do not guess WORD endianness or signedness merely because WORD is 16 bits.

This does **not** block the browser/server binary format because the browser format is normalized after native decoding.

## Validation

The browser decoder should fail the individual frame if any of these are wrong:

- magic
- version
- header length
- unsupported `kind`
- channel outside 1 through 4
- unsupported encoding
- unsupported `yUnit`
- source range invalid
- point count inconsistent with byte length
- a payload source index outside the represented source range
- non-finite X metadata
- non-finite amplitude values

Do not crash the whole application because one disposable live frame is malformed. Surface the protocol error clearly and discard that frame. Repeated malformed frames should cause the WebSocket connection to be treated as incompatible/broken.

## Backpressure

Binary waveform frames are disposable transport data.

If WebSocket output backs up:

- keep the newest useful live frame per channel
- discard older unsent live frames
- discard stale deep viewport frames superseded by a newer viewport request
- do not discard JSON control/state/error messages to preserve old waveform frames

Do not compress binary waveform frames in version 1.

## Shared implementation file

The foundation workstream creates `src/shared/waveform-protocol.ts` containing only the stable shared binary constants/enums and small structural types needed by both encoder and decoder.

Server encoding belongs with the waveform server implementation. Browser decoding belongs with the frontend waveform implementation.

Do not create a large generic binary serialization framework.
