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

  it("returns no ticks while a plot range is uninitialized", () => {
    expect(divisionSplits(Number.NaN, Number.NaN, 8)).toEqual([]);
    expect(divisionSplits(0, 0, 8)).toEqual([]);
  });

  it("selects the natural unit from horizontal scale", () => {
    expect(timeAxisUnit(2).symbol).toBe("s");
    expect(timeAxisUnit(2e-3).symbol).toBe("ms");
    expect(timeAxisUnit(500e-6).symbol).toBe("µs");
    expect(timeAxisUnit(20e-9).symbol).toBe("ns");
  });

  it("promotes the display unit when visible labels would be unwieldy", () => {
    const preferredUnit = timeAxisUnit(500e-6);
    expect(formatTimeAxisValues([
      -1.65358e-3,
      -1.15358e-3,
      -653.58e-6,
    ], preferredUnit)).toEqual([
      "-1.65",
      "-1.15",
      "-0.65 ms",
    ]);
  });

  it("keeps small ranges in the scale's natural SI unit", () => {
    expect(formatTimeAxisValues(
      [-5e-6, 0, 5e-6],
      timeAxisUnit(1e-6),
    )).toEqual([
      "-5",
      "0",
      "5 µs",
    ]);
    expect(formatTimeAxisValues(
      [-40e-9, -20e-9, 0],
      timeAxisUnit(20e-9),
    )).toEqual([
      "-40",
      "-20",
      "0 ns",
    ]);
  });
});
