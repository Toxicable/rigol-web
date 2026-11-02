import { describe, expect, it } from "vitest";

import { MathChannel, MathOperator, MathSource, type MathState } from "../../shared/scope-types.js";
import {
  formatFrequencyAxisValues,
  mathFrequencyRange,
  mathFrequencyScaleName,
  mathFrequencyScaleOptions,
  mathWaveformXScale,
} from "./waveform-x-axis.js";

function mathState(operator: MathOperator): MathState {
  return {
    math: MathChannel.Math1,
    enabled: true,
    operator,
    source1: MathSource.Ch1,
    source2: MathSource.Ch1,
    scale: 1,
    offset: 0,
    frequencyRangeHz: operator === MathOperator.Fft ? { start: 1e6, end: 9e6 } : null,
  };
}

describe("waveform X axes", () => {
  it("gives FFT math its own frequency scale while arithmetic math shares time", () => {
    expect(mathWaveformXScale(mathState(MathOperator.Fft))).toBe("fft-frequency-1");
    expect(mathFrequencyScaleName(MathChannel.Math1)).toBe("fft-frequency-1");
    expect(mathFrequencyScaleName(MathChannel.Math4)).toBe("fft-frequency-4");
    expect(mathWaveformXScale(mathState(MathOperator.Add))).toBe("x");
  });

  it("formats FFT axis ticks with frequency units", () => {
    expect(formatFrequencyAxisValues([1e6, 2e6, 3e6])).toEqual(["1", "2", "3 MHz"]);
  });

  it("uses the scope reported FFT start and end frequencies", () => {
    expect(mathFrequencyRange(mathState(MathOperator.Fft))).toEqual({ min: 1e6, max: 9e6 });
  });

  it("configures FFT frequency scales as horizontal scales", () => {
    const scale = mathFrequencyScaleOptions(mathState(MathOperator.Fft));
    expect(scale.ori).toBe(0);
    expect(scale.range()).toEqual([1e6, 9e6]);
  });
});
