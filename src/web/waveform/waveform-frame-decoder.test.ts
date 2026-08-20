import { describe, expect, it } from "vitest";

import { Channel, ChannelUnit } from "../../shared/scope-types.js";
import { WaveformKind } from "../../shared/websocket-protocol.js";
import {
  WAVEFORM_FRAME_VERSION,
  WAVEFORM_HEADER_BYTES,
  WAVEFORM_MAGIC,
  WAVEFORM_POINT_BYTES,
  WaveformEncoding,
} from "../../shared/waveform-protocol.js";
import { decodeWaveformFrame } from "./waveform-frame-decoder.js";

function fixture(): ArrayBuffer {
  const buffer = new ArrayBuffer(WAVEFORM_HEADER_BYTES + 2 * WAVEFORM_POINT_BYTES);
  const view = new DataView(buffer);
  view.setUint32(0, WAVEFORM_MAGIC, true);
  view.setUint8(4, WAVEFORM_FRAME_VERSION);
  view.setUint8(5, WaveformKind.DeepViewport);
  view.setUint8(6, Channel.Ch2);
  view.setUint8(7, WaveformEncoding.IndexedFloat32);
  view.setUint32(8, 0x10203040, true);
  view.setUint32(12, 9, true);
  view.setUint32(16, 100, true);
  view.setUint32(20, 200, true);
  view.setUint32(24, 2, true);
  view.setUint32(28, WAVEFORM_HEADER_BYTES, true);
  view.setFloat64(32, 2e-9, true);
  view.setFloat64(40, -1e-6, true);
  view.setFloat64(48, 12.5, true);
  view.setUint8(56, ChannelUnit.Amps);
  view.setUint32(64, 101, true);
  view.setFloat32(68, -1.5, true);
  view.setUint32(72, 199, true);
  view.setFloat32(76, 3.25, true);
  return buffer;
}

describe("waveform frame decoder", () => {
  it("parses every fixed v1 header field and strided little-endian records", () => {
    const frame = decodeWaveformFrame(fixture());
    expect(frame.kind).toBe(WaveformKind.DeepViewport);
    expect(frame.channel).toBe(Channel.Ch2);
    expect(frame.unit).toBe(ChannelUnit.Amps);
    expect(frame.sequence).toBe(0x10203040);
    expect(frame.captureId).toBe(9);
    expect(frame.sourceStartSample).toBe(100);
    expect(frame.sourceEndSample).toBe(200);
    expect(frame.xIncrement).toBe(2e-9);
    expect(frame.xOrigin).toBe(-1e-6);
    expect(frame.xReference).toBe(12.5);
    expect([...frame.sampleIndices]).toEqual([101, 199]);
    expect([...frame.values]).toEqual([-1.5, 3.25]);
  });

  it("rejects a frame length mismatch", () => {
    expect(() => decodeWaveformFrame(fixture().slice(0, 79))).toThrow(/length mismatch/);
  });

  it("rejects bad magic, version, encoding and unit", () => {
    for (const [offset, value] of [[0, 0], [4, 9], [7, 9], [56, 9]] as const) {
      const buffer = fixture();
      const view = new DataView(buffer);
      if (offset === 0) view.setUint32(offset, value, true);
      else view.setUint8(offset, value);
      expect(() => decodeWaveformFrame(buffer)).toThrow();
    }
  });

  it("rejects source indices outside the represented range", () => {
    const buffer = fixture();
    new DataView(buffer).setUint32(64, 200, true);
    expect(() => decodeWaveformFrame(buffer)).toThrow(/outside represented range/);
  });
});
