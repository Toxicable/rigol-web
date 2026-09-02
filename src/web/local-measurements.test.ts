import { describe, expect, it } from "vitest";

import {
  Channel,
  ChannelUnit,
  MeasurementKind,
} from "../shared/scope-types.js";
import { WaveformKind } from "../shared/websocket-protocol.js";
import type { DecodedWaveformFrame } from "./waveform/waveform-frame-decoder.js";
import {
  LocalMeasurementAccumulator,
  calculateLocalMeasurement,
} from "./local-measurements.js";

function squareFrame(
  sequence = 1,
  high = 5,
  low = 1,
): DecodedWaveformFrame {
  const pointCount = 1000;
  const sampleIndices = new Uint32Array(pointCount);
  const values = new Float32Array(pointCount);
  for (let index = 0; index < pointCount; index += 1) {
    sampleIndices[index] = index;
    values[index] = index % 100 < 40 ? high : low;
  }

  return {
    kind: WaveformKind.Live,
    channel: Channel.Ch1,
    unit: ChannelUnit.Volts,
    sequence,
    captureId: 0,
    sourceStartSample: 0,
    sourceEndSample: pointCount,
    xIncrement: 1e-6,
    xOrigin: 0,
    xReference: 0,
    sampleIndices,
    values,
  };
}

describe("local measurements", () => {
  it("calculates voltage and timing values from calibrated waveform samples", () => {
    const frame = squareFrame();

    expect(calculateLocalMeasurement(frame, MeasurementKind.Vpp)).toBeCloseTo(4, 9);
    expect(calculateLocalMeasurement(frame, MeasurementKind.Vmax)).toBeCloseTo(5, 9);
    expect(calculateLocalMeasurement(frame, MeasurementKind.Vmin)).toBeCloseTo(1, 9);
    expect(calculateLocalMeasurement(frame, MeasurementKind.Vavg)).toBeCloseTo(2.6, 9);
    expect(calculateLocalMeasurement(frame, MeasurementKind.Vrms)).toBeCloseTo(
      Math.sqrt((25 * 40 + 1 * 60) / 100),
      9,
    );
    expect(calculateLocalMeasurement(frame, MeasurementKind.Vtop)).toBeCloseTo(5, 9);
    expect(calculateLocalMeasurement(frame, MeasurementKind.Vbase)).toBeCloseTo(1, 9);
    expect(calculateLocalMeasurement(frame, MeasurementKind.Vamp)).toBeCloseTo(4, 9);
    expect(calculateLocalMeasurement(frame, MeasurementKind.Vlower)).toBeCloseTo(1.4, 9);
    expect(calculateLocalMeasurement(frame, MeasurementKind.Vmid)).toBeCloseTo(3, 9);
    expect(calculateLocalMeasurement(frame, MeasurementKind.Vupper)).toBeCloseTo(4.6, 9);
    expect(calculateLocalMeasurement(frame, MeasurementKind.Period)).toBeCloseTo(100e-6, 9);
    expect(calculateLocalMeasurement(frame, MeasurementKind.Frequency)).toBeCloseTo(10_000, 6);
    expect(calculateLocalMeasurement(frame, MeasurementKind.PositiveWidth)).toBeCloseTo(40e-6, 9);
    expect(calculateLocalMeasurement(frame, MeasurementKind.NegativeWidth)).toBeCloseTo(60e-6, 9);
    expect(calculateLocalMeasurement(frame, MeasurementKind.PositiveDuty)).toBeCloseTo(40, 9);
    expect(calculateLocalMeasurement(frame, MeasurementKind.NegativeDuty)).toBeCloseTo(60, 9);
    expect(calculateLocalMeasurement(frame, MeasurementKind.RiseTime)).toBeCloseTo(0.8e-6, 9);
    expect(calculateLocalMeasurement(frame, MeasurementKind.FallTime)).toBeCloseTo(0.8e-6, 9);
    expect(calculateLocalMeasurement(frame, MeasurementKind.Overshoot)).toBeCloseTo(0, 9);
    expect(calculateLocalMeasurement(frame, MeasurementKind.Preshoot)).toBeCloseTo(0, 9);
    expect(calculateLocalMeasurement(frame, MeasurementKind.Tvmax)).toBeCloseTo(0, 9);
    expect(calculateLocalMeasurement(frame, MeasurementKind.Tvmin)).toBeCloseTo(40e-6, 9);
  });

  it("does not count the same waveform frame twice in local statistics", () => {
    const accumulator = new LocalMeasurementAccumulator();
    let current = squareFrame();
    const source = { getFrame: () => current };
    const specs = [{ channel: Channel.Ch1, kind: MeasurementKind.Vpp }] as const;

    expect(accumulator.update(specs, source)[0]?.statistics.count).toBe(1);
    expect(accumulator.update(specs, source)[0]?.statistics.count).toBe(1);

    current = squareFrame(2, 6, 1);
    const updated = accumulator.update(specs, source)[0]?.statistics;
    expect(updated?.count).toBe(2);
    expect(updated?.minimum).toBeCloseTo(4, 9);
    expect(updated?.maximum).toBeCloseTo(5, 9);
    expect(updated?.average).toBeCloseTo(4.5, 9);
    expect(updated?.deviation).toBeCloseTo(0.5, 9);
  });

  it("resets statistics when the represented waveform geometry changes", () => {
    const accumulator = new LocalMeasurementAccumulator();
    let current = squareFrame();
    const source = { getFrame: () => current };
    const specs = [{ channel: Channel.Ch1, kind: MeasurementKind.Vpp }] as const;

    expect(accumulator.update(specs, source)[0]?.statistics.count).toBe(1);
    current = { ...squareFrame(2, 6, 1), xIncrement: 2e-6 };

    const updated = accumulator.update(specs, source)[0]?.statistics;
    expect(updated?.count).toBe(1);
    expect(updated?.current).toBeCloseTo(5, 9);
    expect(updated?.average).toBeCloseTo(5, 9);
  });

  it("returns an invalid local result when a waveform has no measurable period", () => {
    const frame = squareFrame();
    frame.values.fill(2);
    expect(calculateLocalMeasurement(frame, MeasurementKind.Period)).toBeNull();

    const accumulator = new LocalMeasurementAccumulator();
    const values = accumulator.update(
      [{ channel: Channel.Ch1, kind: MeasurementKind.Period }],
      { getFrame: () => frame },
    );
    expect(values[0]?.statistics.count).toBe(0);
  });
});
