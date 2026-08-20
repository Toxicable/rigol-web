import { describe, expect, it } from "vitest";

import { Channel, ChannelUnit } from "../../shared/scope-types.js";
import { WaveformKind } from "../../shared/websocket-protocol.js";
import { encodeWaveformFrame } from "./waveform-frame-encoder.js";

function baseInput() {
  return {
    kind: WaveformKind.Live,
    channel: Channel.Ch2,
    unit: ChannelUnit.Volts,
    sequence: 0x01020304,
    captureId: 0,
    sourceStartSample: 0,
    sourceEndSample: 2,
    xIncrement: 1,
    xOrigin: 2,
    xReference: 3,
    sampleIndices: new Uint32Array([0, 1]),
    values: new Float32Array([4.5, -2.25]),
  };
}

describe("encodeWaveformFrame", () => {
  it("matches the fixed version 1 byte layout", () => {
    const actual = encodeWaveformFrame(baseInput());
    const expected = new Uint8Array([
      0x52, 0x47, 0x57, 0x46, 0x01, 0x01, 0x02, 0x01,
      0x04, 0x03, 0x02, 0x01, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00,
      0x02, 0x00, 0x00, 0x00, 0x40, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xf0, 0x3f,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x40,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x08, 0x40,
      0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x90, 0x40,
      0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10, 0xc0,
    ]);
    expect(actual).toEqual(expected);
  });

  it("enforces live and deep capture ID rules", () => {
    expect(() => encodeWaveformFrame({ ...baseInput(), captureId: 1 })).toThrow(/captureId 0/);
    expect(() => encodeWaveformFrame({
      ...baseInput(),
      kind: WaveformKind.DeepViewport,
      captureId: 0,
    })).toThrow(/positive captureId/);
  });

  it("rejects invalid payload lengths, ranges and non-finite values", () => {
    expect(() => encodeWaveformFrame({
      ...baseInput(),
      values: new Float32Array([1]),
    })).toThrow(/lengths must match/);
    expect(() => encodeWaveformFrame({
      ...baseInput(),
      sampleIndices: new Uint32Array([0, 2]),
    })).toThrow(/outside the represented source range/);
    expect(() => encodeWaveformFrame({
      ...baseInput(),
      xIncrement: Number.NaN,
    })).toThrow(/xIncrement must be finite/);
    expect(() => encodeWaveformFrame({
      ...baseInput(),
      values: new Float32Array([1, Number.POSITIVE_INFINITY]),
    })).toThrow(/must be finite/);
  });
});
