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
  appendDmmTrendSnapshot,
  dmmTrendVisibleRange,
} from "./dmm-trend.js";

type TrendData = [number[], Array<number | null>];

const valueSnapshot: DmmReadingSnapshot = {
  kind: DmmReadingKind.Value,
  function: DmmMeasurementFunction.DcVoltage,
  value: 12.34,
  resolution: 0.001,
  unit: DmmUnit.Volts,
};

describe("DM858E snapshot trend", () => {
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

  it("uses time per division and position to select the visible range", () => {
    expect(dmmTrendVisibleRange(100, DEFAULT_DMM_TREND_HORIZONTAL)).toEqual({
      min: 90,
      max: 100,
    });
    expect(dmmTrendVisibleRange(100, { scale: 1, position: -30 })).toEqual({
      min: 60,
      max: 70,
    });
    expect(dmmTrendVisibleRange(3, DEFAULT_DMM_TREND_HORIZONTAL)).toEqual({
      min: 0,
      max: 10,
    });
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

  it("rejects invalid elapsed timestamps", () => {
    const data: TrendData = [[], []];

    expect(() => appendDmmTrendSnapshot(data, -1, valueSnapshot)).toThrow(
      "non-negative finite",
    );
    expect(() => dmmTrendVisibleRange(-1, DEFAULT_DMM_TREND_HORIZONTAL)).toThrow(
      "non-negative finite",
    );
  });
});
