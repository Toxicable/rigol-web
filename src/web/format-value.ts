import { ChannelUnit } from "../shared/scope-types.js";

const PREFIXES: readonly [number, string][] = [
  [1e12, "T"],
  [1e9, "G"],
  [1e6, "M"],
  [1e3, "k"],
  [1, ""],
  [1e-3, "m"],
  [1e-6, "µ"],
  [1e-9, "n"],
  [1e-12, "p"],
];

function formatSi(value: number, unit: string): string {
  if (!Number.isFinite(value)) {
    return `${String(value)} ${unit}`.trim();
  }

  if (value === 0) {
    return `0 ${unit}`.trim();
  }

  const absolute = Math.abs(value);
  const selected =
    PREFIXES.find(([scale]) => absolute >= scale) ?? PREFIXES[PREFIXES.length - 1];

  if (selected === undefined) {
    throw new Error("Missing SI prefix table entry");
  }

  const [scale, prefix] = selected;
  const scaled = value / scale;
  const digits = Math.abs(scaled) >= 100 ? 3 : Math.abs(scaled) >= 10 ? 3 : 4;
  return `${Number(scaled.toPrecision(digits))} ${prefix}${unit}`.trim();
}

export function formatSeconds(value: number): string {
  return formatSi(value, "s");
}

export function formatHertz(value: number): string {
  return formatSi(value, "Hz");
}

export function formatSampleRate(value: number): string {
  return formatSi(value, "Sa/s");
}

export function formatSamples(value: number): string {
  return formatSi(value, "Sa");
}

export function channelUnitSymbol(unit: ChannelUnit): string {
  switch (unit) {
    case ChannelUnit.Volts:
      return "V";
    case ChannelUnit.Amps:
      return "A";
    case ChannelUnit.Watts:
      return "W";
    case ChannelUnit.Unknown:
      return "unit";
  }
}

export function formatAmplitude(value: number, unit: ChannelUnit): string {
  return formatSi(value, channelUnitSymbol(unit));
}
