import { describe, expect, it } from "vitest";

import { downsampleWaveform } from "./downsample.js";

function asArray(values: ArrayLike<number>): number[] {
  return Array.from(values);
}

describe("downsampleWaveform", () => {
  it("preserves a one-sample positive glitch", () => {
    const source = new Float32Array(100);
    source[47] = 10;
    const result = downsampleWaveform(source, 0, 100, 10);
    expect(asArray(result.sampleIndices)).toContain(47);
    expect(asArray(result.values)).toContain(10);
  });

  it("preserves a one-sample negative glitch", () => {
    const source = new Float32Array(100);
    source[52] = -10;
    const result = downsampleWaveform(source, 0, 100, 10);
    expect(asArray(result.sampleIndices)).toContain(52);
    expect(asArray(result.values)).toContain(-10);
  });

  it("emits extrema in source order whether min or max occurs first", () => {
    const minFirst = new Float32Array([0, -5, 1, 4, 0, 0, 0, 0, 0, 0]);
    const maxFirst = new Float32Array([0, 5, 1, -4, 0, 0, 0, 0, 0, 0]);
    expect(asArray(downsampleWaveform(minFirst, 0, 10, 1).sampleIndices)).toEqual([1, 3]);
    expect(asArray(downsampleWaveform(maxFirst, 0, 10, 1).sampleIndices)).toEqual([1, 3]);
  });

  it("emits one point for a constant bucket", () => {
    const result = downsampleWaveform(new Float32Array(10).fill(2), 0, 10, 1);
    expect(asArray(result.sampleIndices)).toEqual([0]);
    expect(asArray(result.values)).toEqual([2]);
  });

  it("keeps a monotonic ramp ordered", () => {
    const result = downsampleWaveform(Float32Array.from({ length: 20 }, (_, index) => index), 0, 20, 2);
    expect(asArray(result.sampleIndices)).toEqual([0, 9, 10, 19]);
    expect(asArray(result.values)).toEqual([0, 9, 10, 19]);
  });

  it("returns every sample on the near-raw path and handles capture boundaries", () => {
    const source = new Float32Array([1, 2, 3, 4, 5]);
    const result = downsampleWaveform(source, 0, source.length, 3);
    expect(asArray(result.sampleIndices)).toEqual([0, 1, 2, 3, 4]);
    expect(asArray(result.values)).toEqual([1, 2, 3, 4, 5]);
  });
});
