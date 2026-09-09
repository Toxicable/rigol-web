import { Buffer } from "node:buffer";

import { describe, expect, it } from "vitest";

import { Ppk2CurrentConverter, type Ppk2CalibrationMetadata } from "./ppk2-protocol.js";
import { Ppk2StreamDecoder } from "./ppk2-stream-decoder.js";

const calibration: Ppk2CalibrationMetadata = {
  vddMv: 3300,
  mode: 1,
  hardwareRevision: null,
  calibrated: null,
  r: [1, 1, 1, 1, 1],
  gs: [0, 0, 0, 0, 0],
  gi: [1, 1, 1, 1, 1],
  o: [0, 0, 0, 0, 0],
  s: [0, 0, 0, 0, 0],
  i: [0, 0, 0, 0, 0],
  ug: [1, 1, 1, 1, 1],
};

function decoder(): Ppk2StreamDecoder {
  return new Ppk2StreamDecoder(new Ppk2CurrentConverter(calibration));
}

function sample(adc: number, counter: number, range = 0, logic = 0): Buffer {
  const word = (adc & 0x3fff) |
    ((range & 0x07) << 14) |
    ((counter & 0x3f) << 18) |
    ((logic & 0xff) << 24);
  const result = Buffer.alloc(4);
  result.writeUInt32LE(word >>> 0);
  return result;
}

describe("Ppk2StreamDecoder", () => {
  it("preserves a sample split across bridge data frames", () => {
    const stream = decoder();
    stream.start(7, 100);
    const encoded = sample(1000, 0, 1, 0x5a);

    expect(stream.push(7, 100, encoded.subarray(0, 2))).toEqual({
      samples: [],
      lostSamples: 0,
    });
    const decoded = stream.push(7, 102, encoded.subarray(2));

    expect(decoded.lostSamples).toBe(0);
    expect(decoded.samples).toHaveLength(1);
    expect(decoded.samples[0]).toMatchObject({
      sequence: 0,
      counter: 0,
      range: 1,
      logic: 0x5a,
    });
  });

  it("counts aligned bridge byte loss exactly", () => {
    const stream = decoder();
    stream.start(9, 200);
    stream.push(9, 200, Buffer.concat([sample(1000, 0), sample(1001, 1)]));

    const resumed = stream.push(9, 216, sample(1004, 4));

    expect(resumed.lostSamples).toBe(2);
    expect(resumed.samples[0]?.sequence).toBe(4);
  });

  it("rejects a bridge gap whose boundaries are not sample aligned", () => {
    const stream = decoder();
    stream.start(9, 300);
    const encoded = sample(1000, 0);
    stream.push(9, 300, encoded.subarray(0, 2));

    expect(() => stream.push(9, 306, sample(1002, 2)))
      .toThrow("uncertain sample boundary");
  });

  it("counts a native counter discontinuity when bridge bytes are continuous", () => {
    const stream = decoder();
    stream.start(11, 400);
    stream.push(11, 400, sample(1000, 0));

    const discontinuity = stream.push(11, 404, sample(1003, 3));

    expect(discontinuity.lostSamples).toBe(2);
    expect(discontinuity.samples[0]?.sequence).toBe(3);
  });

  it("rejects source-session changes and replayed bridge offsets", () => {
    const stream = decoder();
    stream.start(12, 500);
    stream.push(12, 500, sample(1000, 0));

    expect(() => stream.push(13, 504, sample(1001, 1)))
      .toThrow("source session changed");
    expect(() => stream.push(12, 500, sample(1001, 1)))
      .toThrow("moved backwards");
  });
});
