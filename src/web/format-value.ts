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

function fixedDecimalPlaces(value: number): number {
  const absolute = Math.abs(value);
  if (absolute >= 100) {
    return 0;
  }
  if (absolute >= 10) {
    return 1;
  }
  return 3;
}

function formatSi(value: number, unit: string, stable = false): string {
  if (!Number.isFinite(value)) {
    return `${String(value)} ${unit}`.trim();
  }

  if (value === 0) {
    return stable ? `0.000 ${unit}`.trim() : `0 ${unit}`.trim();
  }

  const absolute = Math.abs(value);
  const selected =
    PREFIXES.find(([scale]) => absolute >= scale) ?? PREFIXES[PREFIXES.length - 1];

  if (selected === undefined) {
    throw new Error("Missing SI prefix table entry");
  }

  const [scale, prefix] = selected;
  const scaled = value / scale;
  if (stable) {
    return `${scaled.toFixed(fixedDecimalPlaces(scaled))} ${prefix}${unit}`.trim();
  }

  const digits = Math.abs(scaled) >= 100 ? 3 : Math.abs(scaled) >= 10 ? 3 : 4;
  return `${Number(scaled.toPrecision(digits))} ${prefix}${unit}`.trim();
}

export function formatSeconds(value: number): string {
  return formatSi(value, "s");
}

export function formatStableSeconds(value: number): string {
  return formatSi(value, "s", true);
}

export function formatHertz(value: number): string {
  return formatSi(value, "Hz");
}

export function formatStableHertz(value: number): string {
  return formatSi(value, "Hz", true);
}

export function formatPercent(value: number): string {
  if (!Number.isFinite(value)) {
    return `${String(value)} %`;
  }
  const digits = Math.abs(value) >= 100 ? 3 : Math.abs(value) >= 10 ? 3 : 4;
  return `${Number(value.toPrecision(digits))} %`;
}

export function formatStablePercent(value: number): string {
  if (!Number.isFinite(value)) {
    return `${String(value)} %`;
  }
  return `${value.toFixed(fixedDecimalPlaces(value))} %`;
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

export function formatStableAmplitude(value: number, unit: ChannelUnit): string {
  return formatSi(value, channelUnitSymbol(unit), true);
}
