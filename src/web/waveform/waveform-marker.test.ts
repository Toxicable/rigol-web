import { describe, expect, it } from "vitest";

import { waveformMarkerPlacement } from "./waveform-marker.js";

describe("waveform marker placement", () => {
  it("places an in-range value on the plot coordinate system", () => {
    expect(waveformMarkerPlacement(0, -4, 4, 20, 800)).toEqual({
      top: 420,
      domainY: 400,
      offscreen: null,
    });
  });

  it("keeps an above-range marker fully inside the plot and flags direction", () => {
    expect(waveformMarkerPlacement(10, -4, 4, 20, 800)).toEqual({
      top: 32,
      domainY: 0,
      offscreen: "above",
    });
  });

  it("keeps a below-range marker fully inside the plot and flags direction", () => {
    expect(waveformMarkerPlacement(-10, -4, 4, 20, 800)).toEqual({
      top: 808,
      domainY: 800,
      offscreen: "below",
    });
  });
});
