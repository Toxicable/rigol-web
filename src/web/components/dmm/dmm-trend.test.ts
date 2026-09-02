import { describe, expect, it } from "vitest";

import {
  DmmMeasurementFunction,
  DmmReadingKind,
  DmmReadingUnavailableReason,
  DmmUnit,
  type DmmReadingSnapshot,
} from "../../../shared/dmm-types.js";
import {
  DMM_TREND_WINDOW_SECONDS,
  appendDmmTrendSnapshot,
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
    appendDmmTrendSnapshot(data, DMM_TREND_WINDOW_SECONDS - 1, valueSnapshot);
    appendDmmTrendSnapshot(data, DMM_TREND_WINDOW_SECONDS + 1, valueSnapshot);

    expect(data[0]).toEqual([
      DMM_TREND_WINDOW_SECONDS - 1,
      DMM_TREND_WINDOW_SECONDS + 1,
    ]);
    expect(data[1]).toEqual([12.34, 12.34]);
  });

  it("rejects invalid elapsed timestamps", () => {
    const data: TrendData = [[], []];

    expect(() => appendDmmTrendSnapshot(data, -1, valueSnapshot)).toThrow(
      "non-negative finite",
    );
  });
});
