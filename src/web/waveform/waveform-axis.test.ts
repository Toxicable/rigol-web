import { describe, expect, it } from "vitest";

import {
  divisionSplits,
  formatTimeAxisValues,
  timeAxisUnit,
} from "./waveform-axis.js";

describe("waveform axis helpers", () => {
  it("returns exact scope division boundaries", () => {
    expect(divisionSplits(1, 9, 8)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(divisionSplits(-5e-6, 5e-6, 10)).toHaveLength(11);
  });

  it("selects the horizontal unit from seconds per division", () => {
    expect(timeAxisUnit(2).symbol).toBe("s");
    expect(timeAxisUnit(2e-3).symbol).toBe("ms");
    expect(timeAxisUnit(500e-6).symbol).toBe("µs");
    expect(timeAxisUnit(20e-9).symbol).toBe("ns");
    expect(timeAxisUnit(500e-12).symbol).toBe("ps");
  });

  it("puts the time unit only on the final horizontal label", () => {
    const unit = timeAxisUnit(1e-6);
    expect(formatTimeAxisValues([-5e-6, 0, 5e-6], unit)).toEqual([
      "-5",
      "0",
      "5 µs",
    ]);
  });
});
