import { describe, expect, it } from "vitest";

import {
  DmmMeasurementFunction,
  DmmReadingKind,
  DmmReadingUnavailableReason,
  DmmUnit,
  type DmmReadingSnapshot,
} from "../../../shared/dmm-types.js";
import {
  DEFAULT_DMM_TREND_HORIZONTAL,
  DMM_TREND_RETENTION_SECONDS,
  normalizeDmmTrendHorizontal,
} from "./dmm-horizontal-controls.js";
import {
  DMM_TREND_SAMPLE_INTERVAL_MS,
  appendDmmTrendSnapshot,
  dmmTrendVisibleRange,
  dmmTrendYRange,
  renderableDmmTrendData,
  showDmmTrendPoints,
  type TrendData,
} from "./dmm-trend.js";

const valueSnapshot: DmmReadingSnapshot = {
  kind: DmmReadingKind.Value,
  function: DmmMeasurementFunction.DcVoltage,
  value: 12.34,
  resolution: 0.001,
  unit: DmmUnit.Volts,
};

describe("DM858E snapshot trend", () => {
  it("samples the latest browser state at 10 Hz", () => {
    expect(DMM_TREND_SAMPLE_INTERVAL_MS).toBe(100);
  });

  it("records repeated stable values as distinct trend samples", () => {
    const data: TrendData = [[], []];

    appendDmmTrendSnapshot(data, 0, valueSnapshot);
    appendDmmTrendSnapshot(data, 0.1, valueSnapshot);

    expect(data).toEqual([[0, 0.1], [12.34, 12.34]]);
  });

  it("records numeric snapshots and gaps for unavailable readings", () => {
    const data: TrendData = [[], []];

    appendDmmTrendSnapshot(data, 0, valueSnapshot);
    appendDmmTrendSnapshot(data, 1, {
      kind: DmmReadingKind.Unavailable,
      function: DmmMeasurementFunction.DcVoltage,
      unit: DmmUnit.Volts,
      reason: DmmReadingUnavailableReason.NoData,
    });

    expect(data).toEqual([[0, 1], [12.34, null]]);
  });

  it("keeps only the rolling five-minute browser history", () => {
    const data: TrendData = [[], []];

    appendDmmTrendSnapshot(data, 0, valueSnapshot);
    appendDmmTrendSnapshot(data, DMM_TREND_RETENTION_SECONDS - 1, valueSnapshot);
    appendDmmTrendSnapshot(data, DMM_TREND_RETENTION_SECONDS + 1, valueSnapshot);

    expect(data[0]).toEqual([
      DMM_TREND_RETENTION_SECONDS - 1,
      DMM_TREND_RETENTION_SECONDS + 1,
    ]);
    expect(data[1]).toEqual([12.34, 12.34]);
  });

  it("keeps the latest snapshot on the right edge from the first sample", () => {
    expect(dmmTrendVisibleRange(0, DEFAULT_DMM_TREND_HORIZONTAL)).toEqual({
      min: -10,
      max: 0,
    });
    expect(dmmTrendVisibleRange(3, DEFAULT_DMM_TREND_HORIZONTAL)).toEqual({
      min: -7,
      max: 3,
    });
    expect(dmmTrendVisibleRange(100, DEFAULT_DMM_TREND_HORIZONTAL)).toEqual({
      min: 90,
      max: 100,
    });
  });

  it("uses position to pan backward immediately", () => {
    expect(dmmTrendVisibleRange(3, { scale: 1, position: -5 })).toEqual({
      min: -12,
      max: -2,
    });
    expect(dmmTrendVisibleRange(100, { scale: 1, position: -30 })).toEqual({
      min: 60,
      max: 70,
    });
  });

  it("provides valid two-column render data before two real samples exist", () => {
    expect(renderableDmmTrendData([[], []], { min: -10, max: 0 })).toEqual([
      [-10, 0],
      [null, null],
    ]);

    const onePoint: TrendData = [[0], [12.34]];
    const renderable = renderableDmmTrendData(onePoint, { min: -10, max: 0 });
    expect(renderable[0]).toHaveLength(2);
    expect(renderable[1]).toEqual([null, 12.34]);
    expect(renderable[0][0]).toBeLessThan(renderable[0][1]!);

    const twoPoints: TrendData = [[0, 1], [12.34, 12.35]];
    expect(renderableDmmTrendData(twoPoints, { min: -9, max: 1 })).toBe(twoPoints);
  });

  it("shows point markers while there are too few visible points for a line", () => {
    expect(showDmmTrendPoints({} as never, 1, 0, 0)).toBe(true);
    expect(showDmmTrendPoints({} as never, 1, 0, 1)).toBe(true);
    expect(showDmmTrendPoints({} as never, 1, 0, 2)).toBe(false);
  });

  it("gives uPlot a finite fallback Y range without numeric data", () => {
    expect(dmmTrendYRange({} as never, Number.NaN, Number.NaN)).toEqual([-1, 1]);
    expect(dmmTrendYRange({} as never, 10, 10)).toEqual([9.5, 10.5]);
  });

  it("clamps horizontal controls to the retained history", () => {
    expect(normalizeDmmTrendHorizontal({ scale: 1, position: -999 })).toEqual({
      scale: 1,
      position: -290,
    });
    expect(normalizeDmmTrendHorizontal({ scale: 100, position: -30 })).toEqual({
      scale: 30,
      position: 0,
    });
  });

  it("rejects invalid elapsed timestamps and malformed data", () => {
    const data: TrendData = [[], []];

    expect(() => appendDmmTrendSnapshot(data, -1, valueSnapshot)).toThrow(
      "non-negative finite",
    );
    expect(() => dmmTrendVisibleRange(-1, DEFAULT_DMM_TREND_HORIZONTAL)).toThrow(
      "non-negative finite",
    );
    expect(() => renderableDmmTrendData([[0], []], { min: -10, max: 0 })).toThrow(
      "lengths must match",
    );
  });
});
