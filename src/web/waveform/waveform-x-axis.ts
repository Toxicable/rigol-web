import { MathOperator, type MathChannel, type MathState } from "../../shared/scope-types.js";

const FREQUENCY_UNITS = [
  { multiplier: 1e9, symbol: "GHz" },
  { multiplier: 1e6, symbol: "MHz" },
  { multiplier: 1e3, symbol: "kHz" },
  { multiplier: 1, symbol: "Hz" },
] as const;

export function mathFrequencyScaleName(math: MathChannel): string {
  return `fft-frequency-${math}`;
}

export function mathWaveformXScale(math: MathState): string {
  return math.operator === MathOperator.Fft ? mathFrequencyScaleName(math.math) : "x";
}

export function mathFrequencyRange(math: MathState): { min: number; max: number } {
  const range = math.frequencyRangeHz;
  return range === null || range.end <= range.start
    ? { min: 0, max: 1 }
    : { min: range.start, max: range.end };
}

export function mathFrequencyScaleOptions(math: MathState) {
  const { min, max } = mathFrequencyRange(math);
  return {
    auto: false,
    ori: 0,
    range: () => [min, max] as [number, number],
  };
}

export function formatFrequencyAxisValues(ticksHz: readonly number[]): string[] {
  if (ticksHz.length === 0) return [];
  const maximumMagnitude = ticksHz.reduce(
    (maximum, value) => Math.max(maximum, Math.abs(value)),
    0,
  );
  const unit = FREQUENCY_UNITS.find(({ multiplier }) => maximumMagnitude >= multiplier)
    ?? FREQUENCY_UNITS[FREQUENCY_UNITS.length - 1]!;
  return ticksHz.map((tick, index) => {
    const rounded = Number((tick / unit.multiplier).toPrecision(3));
    const value = String(Object.is(rounded, -0) ? 0 : rounded);
    return index === ticksHz.length - 1 ? `${value} ${unit.symbol}` : value;
  });
}
