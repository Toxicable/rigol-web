import { describe, expect, it } from "vitest";

import { decodeDho804WordSamples } from "./dho804-word-decoder.js";

describe("decodeDho804WordSamples", () => {
  it("isolates the current unsigned little-endian WORD interpretation", () => {
    expect(decodeDho804WordSamples(Uint8Array.from([0x34, 0x12, 0xcd, 0xab]))).toEqual(
      Uint16Array.from([0x1234, 0xabcd]),
    );
  });

  it("rejects an incomplete WORD sample", () => {
    expect(() => decodeDho804WordSamples(Uint8Array.from([1]))).toThrow(/even/);
  });
});
