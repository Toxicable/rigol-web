export interface TimeAxisUnit {
  seconds: number;
  symbol: string;
}

const TIME_AXIS_UNITS: readonly TimeAxisUnit[] = [
  { seconds: 1, symbol: "s" },
  { seconds: 1e-3, symbol: "ms" },
  { seconds: 1e-6, symbol: "µs" },
  { seconds: 1e-9, symbol: "ns" },
  { seconds: 1e-12, symbol: "ps" },
];

export function divisionSplits(min: number, max: number, divisions: number): number[] {
  if (!Number.isSafeInteger(divisions) || divisions < 1) {
    throw new Error("Axis division count must be a positive integer");
  }
  if (!Number.isFinite(min) || !Number.isFinite(max) || !(max > min)) {
    return [];
  }

  const step = (max - min) / divisions;
  return Array.from({ length: divisions + 1 }, (_unused, index) => min + index * step);
}

function timeAxisUnitForTicks(ticksSeconds: readonly number[]): TimeAxisUnit {
  const maximumMagnitude = ticksSeconds.reduce(
    (maximum, value) => Math.max(maximum, Math.abs(value)),
    0,
  );
  const selected = TIME_AXIS_UNITS.find((unit) => maximumMagnitude >= unit.seconds);
  return selected ?? TIME_AXIS_UNITS[TIME_AXIS_UNITS.length - 1]!;
}

function timeAxisDecimalPlaces(
  ticksSeconds: readonly number[],
  unit: TimeAxisUnit,
): number {
  if (ticksSeconds.length < 2) {
    return 0;
  }
  const first = ticksSeconds[0];
  const second = ticksSeconds[1];
  if (first === undefined || second === undefined) {
    return 0;
  }
  const step = Math.abs(second - first) / unit.seconds;
  if (!Number.isFinite(step) || !(step > 0)) {
    return 0;
  }
  return Math.max(0, Math.min(6, 1 - Math.floor(Math.log10(step))));
}

function formatScaledTime(value: number, decimalPlaces: number): string {
  if (!Number.isFinite(value)) {
    return String(value);
  }
  const rounded = Number(value.toFixed(decimalPlaces));
  return String(Object.is(rounded, -0) ? 0 : rounded);
}

export function formatTimeAxisValues(ticksSeconds: readonly number[]): string[] {
  if (ticksSeconds.length === 0) {
    return [];
  }
  const unit = timeAxisUnitForTicks(ticksSeconds);
  const decimalPlaces = timeAxisDecimalPlaces(ticksSeconds, unit);
  return ticksSeconds.map((tick, index) => {
    const value = formatScaledTime(tick / unit.seconds, decimalPlaces);
    return index === ticksSeconds.length - 1 ? `${value} ${unit.symbol}` : value;
  });
}
