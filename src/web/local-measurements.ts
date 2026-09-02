import {
  Channel,
  MeasurementKind,
  type MeasurementSpec,
  type MeasurementStatistics,
  type MeasurementValue,
} from "../shared/scope-types.js";
import type { DecodedWaveformFrame } from "./waveform/waveform-frame-decoder.js";

const HISTOGRAM_BINS = 64;
const LOWER_THRESHOLD = 0.1;
const MIDDLE_THRESHOLD = 0.5;
const UPPER_THRESHOLD = 0.9;

interface Extrema {
  minimum: number;
  maximum: number;
  minimumIndex: number;
  maximumIndex: number;
}

interface Levels extends Extrema {
  base: number;
  top: number;
  amplitude: number;
  lower: number;
  middle: number;
  upper: number;
}

interface RunningStatistics {
  current: number;
  minimum: number;
  maximum: number;
  mean: number;
  m2: number;
  count: number;
}

export interface LocalWaveformSource {
  getFrame(channel: Channel): DecodedWaveformFrame | undefined;
}

function extrema(values: Float32Array): Extrema | null {
  if (values.length === 0) {
    return null;
  }

  let minimum = values[0];
  let maximum = values[0];
  if (minimum === undefined || maximum === undefined) {
    return null;
  }
  let minimumIndex = 0;
  let maximumIndex = 0;

  for (let index = 1; index < values.length; index += 1) {
    const value = values[index];
    if (value === undefined) {
      continue;
    }
    if (value < minimum) {
      minimum = value;
      minimumIndex = index;
    }
    if (value > maximum) {
      maximum = value;
      maximumIndex = index;
    }
  }

  return { minimum, maximum, minimumIndex, maximumIndex };
}

function histogramLevel(
  values: Float32Array,
  minimum: number,
  maximum: number,
  startBin: number,
  endBin: number,
  fallback: number,
): number {
  const range = maximum - minimum;
  if (!(range > 0)) {
    return fallback;
  }

  const counts = new Uint32Array(HISTOGRAM_BINS);
  const sums = new Float64Array(HISTOGRAM_BINS);
  for (const value of values) {
    const normalized = (value - minimum) / range;
    const rawBin = Math.floor(normalized * HISTOGRAM_BINS);
    const bin = Math.max(0, Math.min(HISTOGRAM_BINS - 1, rawBin));
    counts[bin] = (counts[bin] ?? 0) + 1;
    sums[bin] = (sums[bin] ?? 0) + value;
  }

  let selected = -1;
  let selectedCount = 0;
  for (let bin = startBin; bin < endBin; bin += 1) {
    const count = counts[bin] ?? 0;
    if (count > selectedCount) {
      selected = bin;
      selectedCount = count;
    }
  }

  if (selected < 0 || selectedCount === 0) {
    return fallback;
  }
  const sum = sums[selected];
  return sum === undefined ? fallback : sum / selectedCount;
}

function levels(values: Float32Array): Levels | null {
  const bounds = extrema(values);
  if (bounds === null) {
    return null;
  }

  if (!(bounds.maximum > bounds.minimum)) {
    return {
      ...bounds,
      base: bounds.minimum,
      top: bounds.maximum,
      amplitude: 0,
      lower: bounds.minimum,
      middle: bounds.minimum,
      upper: bounds.minimum,
    };
  }

  const midpoint = Math.floor(HISTOGRAM_BINS / 2);
  const base = histogramLevel(
    values,
    bounds.minimum,
    bounds.maximum,
    0,
    midpoint,
    bounds.minimum,
  );
  const top = histogramLevel(
    values,
    bounds.minimum,
    bounds.maximum,
    midpoint,
    HISTOGRAM_BINS,
    bounds.maximum,
  );
  const amplitude = top - base;

  if (!(amplitude > 0)) {
    return {
      ...bounds,
      base: bounds.minimum,
      top: bounds.maximum,
      amplitude: bounds.maximum - bounds.minimum,
      lower: bounds.minimum + (bounds.maximum - bounds.minimum) * LOWER_THRESHOLD,
      middle: bounds.minimum + (bounds.maximum - bounds.minimum) * MIDDLE_THRESHOLD,
      upper: bounds.minimum + (bounds.maximum - bounds.minimum) * UPPER_THRESHOLD,
    };
  }

  return {
    ...bounds,
    base,
    top,
    amplitude,
    lower: base + amplitude * LOWER_THRESHOLD,
    middle: base + amplitude * MIDDLE_THRESHOLD,
    upper: base + amplitude * UPPER_THRESHOLD,
  };
}

function timeAt(frame: DecodedWaveformFrame, index: number): number | null {
  const sampleIndex = frame.sampleIndices[index];
  if (sampleIndex === undefined) {
    return null;
  }
  return frame.xOrigin + (sampleIndex - frame.xReference) * frame.xIncrement;
}

function crossings(
  frame: DecodedWaveformFrame,
  threshold: number,
  rising: boolean,
): number[] {
  const result: number[] = [];
  const values = frame.values;

  for (let index = 1; index < values.length; index += 1) {
    const previous = values[index - 1];
    const current = values[index];
    if (previous === undefined || current === undefined) {
      continue;
    }
    const crossed = rising
      ? previous < threshold && current >= threshold
      : previous > threshold && current <= threshold;
    if (!crossed || current === previous) {
      continue;
    }

    const previousTime = timeAt(frame, index - 1);
    const currentTime = timeAt(frame, index);
    if (previousTime === null || currentTime === null || !(currentTime > previousTime)) {
      continue;
    }
    const ratio = (threshold - previous) / (current - previous);
    result.push(previousTime + ratio * (currentTime - previousTime));
  }

  return result;
}

function average(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  let sum = 0;
  for (const value of values) {
    sum += value;
  }
  return sum / values.length;
}

function averageIntervals(points: readonly number[]): number | null {
  if (points.length < 2) {
    return null;
  }
  let sum = 0;
  let count = 0;
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    if (previous !== undefined && current !== undefined && current > previous) {
      sum += current - previous;
      count += 1;
    }
  }
  return count === 0 ? null : sum / count;
}

function averagePairedIntervals(
  starts: readonly number[],
  ends: readonly number[],
): number | null {
  let endIndex = 0;
  const intervals: number[] = [];
  for (const start of starts) {
    while (endIndex < ends.length && (ends[endIndex] ?? Number.NEGATIVE_INFINITY) <= start) {
      endIndex += 1;
    }
    const end = ends[endIndex];
    if (end === undefined) {
      break;
    }
    intervals.push(end - start);
    endIndex += 1;
  }
  return average(intervals);
}

function period(frame: DecodedWaveformFrame, measurementLevels: Levels): number | null {
  const rising = crossings(frame, measurementLevels.middle, true);
  const risingPeriod = averageIntervals(rising);
  if (risingPeriod !== null) {
    return risingPeriod;
  }
  return averageIntervals(crossings(frame, measurementLevels.middle, false));
}

function mean(values: Float32Array): number | null {
  if (values.length === 0) {
    return null;
  }
  let sum = 0;
  for (const value of values) {
    sum += value;
  }
  return sum / values.length;
}

function rms(values: Float32Array): number | null {
  if (values.length === 0) {
    return null;
  }
  let sumSquares = 0;
  for (const value of values) {
    sumSquares += value * value;
  }
  return Math.sqrt(sumSquares / values.length);
}

export function calculateLocalMeasurement(
  frame: DecodedWaveformFrame,
  kind: MeasurementKind,
): number | null {
  const measurementLevels = levels(frame.values);
  if (measurementLevels === null) {
    return null;
  }

  switch (kind) {
    case MeasurementKind.Vpp:
      return measurementLevels.maximum - measurementLevels.minimum;
    case MeasurementKind.Vmax:
      return measurementLevels.maximum;
    case MeasurementKind.Vmin:
      return measurementLevels.minimum;
    case MeasurementKind.Vavg:
      return mean(frame.values);
    case MeasurementKind.Vrms:
      return rms(frame.values);
    case MeasurementKind.Frequency: {
      const measuredPeriod = period(frame, measurementLevels);
      return measuredPeriod === null || !(measuredPeriod > 0) ? null : 1 / measuredPeriod;
    }
    case MeasurementKind.Period:
      return period(frame, measurementLevels);
    case MeasurementKind.Vtop:
      return measurementLevels.top;
    case MeasurementKind.Vbase:
      return measurementLevels.base;
    case MeasurementKind.Vamp:
      return measurementLevels.amplitude;
    case MeasurementKind.Vupper:
      return measurementLevels.upper;
    case MeasurementKind.Vmid:
      return measurementLevels.middle;
    case MeasurementKind.Vlower:
      return measurementLevels.lower;
    case MeasurementKind.Overshoot:
      return measurementLevels.amplitude > 0
        ? ((measurementLevels.maximum - measurementLevels.top) / measurementLevels.amplitude) * 100
        : null;
    case MeasurementKind.Preshoot:
      return measurementLevels.amplitude > 0
        ? ((measurementLevels.base - measurementLevels.minimum) / measurementLevels.amplitude) * 100
        : null;
    case MeasurementKind.RiseTime:
      return averagePairedIntervals(
        crossings(frame, measurementLevels.lower, true),
        crossings(frame, measurementLevels.upper, true),
      );
    case MeasurementKind.FallTime:
      return averagePairedIntervals(
        crossings(frame, measurementLevels.upper, false),
        crossings(frame, measurementLevels.lower, false),
      );
    case MeasurementKind.PositiveWidth:
      return averagePairedIntervals(
        crossings(frame, measurementLevels.middle, true),
        crossings(frame, measurementLevels.middle, false),
      );
    case MeasurementKind.NegativeWidth:
      return averagePairedIntervals(
        crossings(frame, measurementLevels.middle, false),
        crossings(frame, measurementLevels.middle, true),
      );
    case MeasurementKind.PositiveDuty: {
      const measuredPeriod = period(frame, measurementLevels);
      const width = averagePairedIntervals(
        crossings(frame, measurementLevels.middle, true),
        crossings(frame, measurementLevels.middle, false),
      );
      return measuredPeriod === null || width === null || !(measuredPeriod > 0)
        ? null
        : (width / measuredPeriod) * 100;
    }
    case MeasurementKind.NegativeDuty: {
      const measuredPeriod = period(frame, measurementLevels);
      const width = averagePairedIntervals(
        crossings(frame, measurementLevels.middle, false),
        crossings(frame, measurementLevels.middle, true),
      );
      return measuredPeriod === null || width === null || !(measuredPeriod > 0)
        ? null
        : (width / measuredPeriod) * 100;
    }
    case MeasurementKind.Tvmax:
      return timeAt(frame, measurementLevels.maximumIndex);
    case MeasurementKind.Tvmin:
      return timeAt(frame, measurementLevels.minimumIndex);
  }
}

function emptyStatistics(): MeasurementStatistics {
  return {
    current: Number.NaN,
    minimum: Number.NaN,
    maximum: Number.NaN,
    average: Number.NaN,
    deviation: Number.NaN,
    count: 0,
  };
}

function statisticsValue(stats: RunningStatistics): MeasurementStatistics {
  return {
    current: stats.current,
    minimum: stats.minimum,
    maximum: stats.maximum,
    average: stats.mean,
    deviation: Math.sqrt(stats.m2 / stats.count),
    count: stats.count,
  };
}

function updateStatistics(
  current: RunningStatistics | undefined,
  value: number,
): RunningStatistics {
  if (current === undefined) {
    return {
      current: value,
      minimum: value,
      maximum: value,
      mean: value,
      m2: 0,
      count: 1,
    };
  }

  const count = current.count + 1;
  const delta = value - current.mean;
  const mean = current.mean + delta / count;
  const deltaFromNewMean = value - mean;
  return {
    current: value,
    minimum: Math.min(current.minimum, value),
    maximum: Math.max(current.maximum, value),
    mean,
    m2: current.m2 + delta * deltaFromNewMean,
    count,
  };
}

function specKey(spec: MeasurementSpec): string {
  return `${spec.channel}:${spec.kind}`;
}

function frameKey(frame: DecodedWaveformFrame): string {
  return `${frame.kind}:${frame.captureId}:${frame.sequence}:${frame.sourceStartSample}:${frame.sourceEndSample}`;
}

export class LocalMeasurementAccumulator {
  private readonly running = new Map<string, RunningStatistics>();
  private readonly current = new Map<string, MeasurementValue>();
  private readonly frameKeys = new Map<Channel, string>();

  public reset(): void {
    this.running.clear();
    this.current.clear();
    this.frameKeys.clear();
  }

  public update(
    specs: readonly MeasurementSpec[],
    waveforms: LocalWaveformSource,
  ): MeasurementValue[] {
    const changedChannels = new Set<Channel>();
    const channels = new Set(specs.map((spec) => spec.channel));

    for (const channel of channels) {
      const frame = waveforms.getFrame(channel);
      if (frame === undefined) {
        this.frameKeys.delete(channel);
        continue;
      }
      const key = frameKey(frame);
      if (this.frameKeys.get(channel) !== key) {
        this.frameKeys.set(channel, key);
        changedChannels.add(channel);
      }
    }

    const values: MeasurementValue[] = [];
    for (const spec of specs) {
      const key = specKey(spec);
      const frame = waveforms.getFrame(spec.channel);
      if (frame === undefined) {
        const missing = { ...spec, statistics: emptyStatistics() };
        this.current.set(key, missing);
        values.push(missing);
        continue;
      }

      if (changedChannels.has(spec.channel) || !this.current.has(key)) {
        const measured = calculateLocalMeasurement(frame, spec.kind);
        if (measured === null || !Number.isFinite(measured)) {
          const invalid = { ...spec, statistics: emptyStatistics() };
          this.current.set(key, invalid);
        } else {
          const running = updateStatistics(this.running.get(key), measured);
          this.running.set(key, running);
          this.current.set(key, { ...spec, statistics: statisticsValue(running) });
        }
      }

      values.push(this.current.get(key) ?? { ...spec, statistics: emptyStatistics() });
    }

    return values;
  }
}
