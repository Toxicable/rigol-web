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

const TIME_AXIS_SIGNIFICANT_DIGITS = 3;

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

export function timeAxisUnit(scaleSeconds: number): TimeAxisUnit {
  if (!Number.isFinite(scaleSeconds) || !(scaleSeconds > 0)) {
    throw new Error("Horizontal scale must be a positive finite number");
  }
  const selected = TIME_AXIS_UNITS.find((unit) => scaleSeconds >= unit.seconds);
  return selected ?? TIME_AXIS_UNITS[TIME_AXIS_UNITS.length - 1]!;
}

function timeAxisUnitForTicks(ticksSeconds: readonly number[]): TimeAxisUnit {
  const maximumMagnitude = ticksSeconds.reduce(
    (maximum, value) => Math.max(maximum, Math.abs(value)),
    0,
  );
  if (!(maximumMagnitude > 0)) {
    return TIME_AXIS_UNITS[TIME_AXIS_UNITS.length - 1]!;
  }
  const selected = TIME_AXIS_UNITS.find((unit) => maximumMagnitude >= unit.seconds);
  return selected ?? TIME_AXIS_UNITS[TIME_AXIS_UNITS.length - 1]!;
}

function displayTimeAxisUnit(
  ticksSeconds: readonly number[],
  preferredUnit: TimeAxisUnit,
): TimeAxisUnit {
  const rangeUnit = timeAxisUnitForTicks(ticksSeconds);
  return rangeUnit.seconds > preferredUnit.seconds ? rangeUnit : preferredUnit;
}

function formatScaledTime(value: number): string {
  if (!Number.isFinite(value)) {
    return String(value);
  }
  const rounded = Number(value.toPrecision(TIME_AXIS_SIGNIFICANT_DIGITS));
  return String(Object.is(rounded, -0) ? 0 : rounded);
}

export function formatTimeAxisValues(
  ticksSeconds: readonly number[],
  preferredUnit: TimeAxisUnit,
): string[] {
  if (ticksSeconds.length === 0) {
    return [];
  }
  const unit = displayTimeAxisUnit(ticksSeconds, preferredUnit);
  return ticksSeconds.map((tick, index) => {
    const value = formatScaledTime(tick / unit.seconds);
    return index === ticksSeconds.length - 1 ? `${value} ${unit.symbol}` : value;
  });
}
