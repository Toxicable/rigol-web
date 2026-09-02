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

  it("rolls engineering units at 1000", () => {
    expect(timeAxisUnit(999e-6).symbol).toBe("µs");
    expect(timeAxisUnit(1_000e-6).symbol).toBe("ms");
    expect(timeAxisUnit(4_000e-6).symbol).toBe("ms");
    expect(timeAxisUnit(999e-3).symbol).toBe("ms");
    expect(timeAxisUnit(1_000e-3).symbol).toBe("s");
  });

  it("promotes visible labels at the engineering boundary", () => {
    expect(formatTimeAxisValues(
      [0, 999e-6, 1e-3, 4e-3],
      timeAxisUnit(500e-6),
    )).toEqual([
      "0",
      "0.999",
      "1",
      "4 ms",
    ]);
  });

  it("uses three significant digits for arbitrary horizontal offsets", () => {
    const preferredUnit = timeAxisUnit(500e-6);
    expect(formatTimeAxisValues([
      -1.65358e-3,
      -1.15358e-3,
      -653.581e-6,
      -153.581e-6,
      346.419e-6,
      846.419e-6,
      1.34642e-3,
      2.84642e-3,
    ], preferredUnit)).toEqual([
      "-1.65",
      "-1.15",
      "-0.654",
      "-0.154",
      "0.346",
      "0.846",
      "1.35",
      "2.85 ms",
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
