import { describe, expect, it } from "vitest";

import { ChannelUnit } from "../shared/scope-types.js";
import {
  formatAmplitude,
  formatStableAmplitude,
  formatStableHertz,
  formatStablePercent,
  formatStableSeconds,
} from "./format-value.js";

describe("stable measurement formatting", () => {
  it("preserves trailing zeroes without changing normal compact formatting", () => {
    expect(formatAmplitude(10, ChannelUnit.Volts)).toBe("10 V");
    expect(formatStableAmplitude(10, ChannelUnit.Volts)).toBe("10.0 V");
    expect(formatStableAmplitude(4.5, ChannelUnit.Volts)).toBe("4.500 V");
  });

  it("keeps stable decimal places after SI scaling", () => {
    expect(formatStableAmplitude(0.01, ChannelUnit.Volts)).toBe("10.0 mV");
    expect(formatStableHertz(1_000)).toBe("1.000 kHz");
    expect(formatStableSeconds(0.000_001)).toBe("1.000 µs");
  });

  it("keeps percentage decimal points stable", () => {
    expect(formatStablePercent(50)).toBe("50.0 %");
    expect(formatStablePercent(9.5)).toBe("9.500 %");
    expect(formatStablePercent(100)).toBe("100 %");
  });
});
