import {
  DmmReadingKind,
  DmmReadingUnavailableReason,
  DmmUnit,
  type DmmReadingSnapshot,
} from "../../shared/dmm-types.js";

export interface FormattedDmmValue {
  readonly value: string;
  readonly unit: string;
}

export interface FormattedDmmReading extends FormattedDmmValue {
  readonly detail: string | null;
  readonly numeric: boolean;
}

interface Prefix {
  readonly exponent: number;
  readonly symbol: string;
}

const engineeringPrefixes: readonly Prefix[] = [
  { exponent: -12, symbol: "p" },
  { exponent: -9, symbol: "n" },
  { exponent: -6, symbol: "µ" },
  { exponent: -3, symbol: "m" },
  { exponent: 0, symbol: "" },
  { exponent: 3, symbol: "k" },
  { exponent: 6, symbol: "M" },
  { exponent: 9, symbol: "G" },
];

export function dmmUnitSymbol(value: DmmUnit): string {
  switch (value) {
    case DmmUnit.Volts:
      return "V";
    case DmmUnit.Amps:
      return "A";
    case DmmUnit.Ohms:
      return "Ω";
    case DmmUnit.Hertz:
      return "Hz";
    case DmmUnit.Seconds:
      return "s";
    case DmmUnit.Farads:
      return "F";
    case DmmUnit.Celsius:
      return "°C";
    case DmmUnit.Unitless:
      return "";
  }
}

export function formatDmmValue(
  value: number,
  unit: DmmUnit,
  resolution: number | null = null,
): FormattedDmmValue {
  requireFinite(value);
  if (resolution !== null) {
    requireResolution(resolution);
  }

  const rounded = resolution === null ? value : roundToQuantum(value, resolution);
  const prefix = prefixForUnit(rounded, unit);
  const scaled = rounded / 10 ** prefix.exponent;
  return {
    value: formatConservative(scaled),
    unit: `${prefix.symbol}${dmmUnitSymbol(unit)}`,
  };
}

export function formatDmmRange(value: number, unit: DmmUnit): string {
  requireFinite(value);

  const prefix = prefixForUnit(value, unit);
  const scaled = value / 10 ** prefix.exponent;
  const compact = Number.isInteger(scaled)
    ? String(scaled)
    : String(Number(scaled.toPrecision(4)));
  return `${compact} ${prefix.symbol}${dmmUnitSymbol(unit)}`.trim();
}

export function formatDmmReading(
  snapshot: DmmReadingSnapshot | null,
): FormattedDmmReading {
  if (snapshot === null) {
    return { value: "—", unit: "", detail: "Waiting for reading", numeric: false };
  }

  switch (snapshot.kind) {
    case DmmReadingKind.Value: {
      const formatted = formatDmmValue(
        snapshot.value,
        snapshot.unit,
        snapshot.resolution,
      );
      return { ...formatted, detail: null, numeric: true };
    }
    case DmmReadingKind.Overload:
      return {
        value: "OL",
        unit: dmmUnitSymbol(snapshot.unit),
        detail: "Overload",
        numeric: false,
      };
    case DmmReadingKind.Unavailable:
      return {
        value: "—",
        unit: dmmUnitSymbol(snapshot.unit),
        detail: unavailableReasonLabel(snapshot.reason),
        numeric: false,
      };
  }
}

function requireFinite(value: number): void {
  if (!Number.isFinite(value)) {
    throw new Error("DMM reading must be finite");
  }
}

function requireResolution(value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("DMM reading resolution must be a positive finite number");
  }
}

function roundToQuantum(value: number, resolution: number): number {
  const quotient = value / resolution;
  if (!Number.isFinite(quotient)) {
    throw new Error("DMM reading cannot be represented at its resolution");
  }
  return Math.round(quotient) * resolution;
}

function prefixForUnit(value: number, unit: DmmUnit): Prefix {
  const allowPrefix = unit !== DmmUnit.Celsius && unit !== DmmUnit.Unitless;
  const prefix = allowPrefix ? engineeringPrefixFor(value) : engineeringPrefixes[4];
  if (prefix === undefined) {
    throw new Error("Missing base engineering prefix");
  }
  return prefix;
}

function engineeringPrefixFor(value: number): Prefix {
  if (value === 0) {
    const base = engineeringPrefixes[4];
    if (base === undefined) {
      throw new Error("Missing base engineering prefix");
    }
    return base;
  }

  const rawExponent = Math.floor(Math.log10(Math.abs(value)) / 3) * 3;
  const exponent = Math.min(9, Math.max(-12, rawExponent));
  const prefix = engineeringPrefixes.find((candidate) => candidate.exponent === exponent);
  if (prefix === undefined) {
    throw new Error(`Unsupported engineering exponent ${exponent}`);
  }
  return prefix;
}

function formatConservative(value: number): string {
  if (value === 0) {
    return "0";
  }
  return String(Number(value.toPrecision(15)));
}

function unavailableReasonLabel(value: DmmReadingUnavailableReason): string {
  switch (value) {
    case DmmReadingUnavailableReason.NoData:
      return "No measurement data";
    case DmmReadingUnavailableReason.UnclassifiedSentinel:
      return "Instrument returned an unclassified sentinel";
    case DmmReadingUnavailableReason.ConfigurationChanged:
      return "Configuration changed";
    case DmmReadingUnavailableReason.ResolutionUnavailable:
      return "Measurement resolution unavailable";
  }
}
