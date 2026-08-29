import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  DmmAcquisitionRate,
  DmmMeasurementFunction,
  DmmRangeMode,
  DmmReadingKind,
  DmmReadingUnavailableReason,
  DmmUnit,
  type DmmState,
} from "../../../shared/dmm-types.js";
import { DmmReading } from "./dmm-reading.js";

const state: DmmState = {
  function: DmmMeasurementFunction.DcVoltage,
  range: { mode: DmmRangeMode.Auto },
  acquisitionRate: DmmAcquisitionRate.Slow,
};

describe("DMM primary reading", () => {
  it("renders a stable numeric value without exceeding the selected rate precision", () => {
    const markup = renderToStaticMarkup(createElement(DmmReading, {
      state,
      snapshot: {
        kind: DmmReadingKind.Value,
        function: DmmMeasurementFunction.DcVoltage,
        value: 0.012345678,
        unit: DmmUnit.Volts,
      },
    }));

    expect(markup).toContain("12.3457");
    expect(markup).not.toContain("12.345678");
    expect(markup).toContain("mV");
    expect(markup).toContain("DC voltage");
    expect(markup).toContain("Auto");
    expect(markup).toContain("Slow · 5.5 digit");
  });

  it("does not synthesize trailing zero precision", () => {
    const markup = renderToStaticMarkup(createElement(DmmReading, {
      state,
      snapshot: {
        kind: DmmReadingKind.Value,
        function: DmmMeasurementFunction.DcVoltage,
        value: 12.34,
        unit: DmmUnit.Volts,
      },
    }));

    expect(markup).toContain(">12.34<");
    expect(markup).not.toContain("12.3400");
  });

  it("replaces a numeric presentation with explicit unavailable state", () => {
    const markup = renderToStaticMarkup(createElement(DmmReading, {
      state,
      snapshot: {
        kind: DmmReadingKind.Unavailable,
        function: DmmMeasurementFunction.DcVoltage,
        unit: DmmUnit.Volts,
        reason: DmmReadingUnavailableReason.ConfigurationChanged,
      },
    }));

    expect(markup).toContain("Configuration changed");
    expect(markup).toContain("—");
    expect(markup).not.toContain("12.3457");
  });

  it("does not display a snapshot belonging to a stale function", () => {
    const markup = renderToStaticMarkup(createElement(DmmReading, {
      state,
      snapshot: {
        kind: DmmReadingKind.Value,
        function: DmmMeasurementFunction.AcVoltage,
        value: 42,
        unit: DmmUnit.Volts,
      },
    }));

    expect(markup).toContain("Waiting for reading");
    expect(markup).not.toContain(">42");
  });
});
