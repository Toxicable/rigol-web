import { describe, expect, it } from "vitest";

import {
  WAVEFORM_FRAME_VERSION,
  WAVEFORM_HEADER_BYTES,
  WAVEFORM_MAGIC,
  WAVEFORM_POINT_BYTES,
  WaveformEncoding,
} from "./waveform-protocol";

describe("waveform protocol constants", () => {
  it("keeps the fixed frame layout stable", () => {
    expect(WAVEFORM_MAGIC).toBe(0x46574752);
    expect(WAVEFORM_FRAME_VERSION).toBe(1);
    expect(WAVEFORM_HEADER_BYTES).toBe(64);
    expect(WAVEFORM_POINT_BYTES).toBe(8);
  });

  it("keeps encoding values stable", () => {
    expect(WaveformEncoding.IndexedFloat32).toBe(1);
  });
});
