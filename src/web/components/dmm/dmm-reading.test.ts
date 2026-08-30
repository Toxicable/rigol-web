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
  it("renders using the authoritative snapshot resolution", () => {
    const markup = renderToStaticMarkup(createElement(DmmReading, {
      state,
      snapshot: {
        kind: DmmReadingKind.Value,
        function: DmmMeasurementFunction.DcVoltage,
        value: 0.012345678,
        resolution: 1e-6,
        unit: DmmUnit.Volts,
      },
    }));

    expect(markup).toContain("12.346");
    expect(markup).not.toContain("12.345678");
    expect(markup).toContain("mV");
    expect(markup).toContain("DC voltage");
    expect(markup).toContain("Auto");
    expect(markup).toContain("Slow · 5.5 digit");
  });

  it("uses actual Auto-range resolution rather than deriving precision from the rate label", () => {
    const autoFastState: DmmState = {
      function: DmmMeasurementFunction.AcVoltage,
      range: { mode: DmmRangeMode.Auto },
      acquisitionRate: DmmAcquisitionRate.Fast,
    };
    const markup = renderToStaticMarkup(createElement(DmmReading, {
      state: autoFastState,
      snapshot: {
        kind: DmmReadingKind.Value,
        function: DmmMeasurementFunction.AcVoltage,
        value: 12.345678,
        resolution: 0.1,
        unit: DmmUnit.Volts,
      },
    }));

    expect(markup).toContain(">12.3<");
    expect(markup).not.toContain("12.346");
    expect(markup).toContain("Auto");
    expect(markup).toContain("Fast · 4.5 digit");
  });

  it("does not synthesize trailing zero precision", () => {
    const markup = renderToStaticMarkup(createElement(DmmReading, {
      state,
      snapshot: {
        kind: DmmReadingKind.Value,
        function: DmmMeasurementFunction.DcVoltage,
        value: 12.34,
        resolution: 0.001,
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
    expect(markup).not.toContain("12.346");
  });

  it("does not display a snapshot belonging to a stale function", () => {
    const markup = renderToStaticMarkup(createElement(DmmReading, {
      state,
      snapshot: {
        kind: DmmReadingKind.Value,
        function: DmmMeasurementFunction.AcVoltage,
        value: 42,
        resolution: 0.1,
        unit: DmmUnit.Volts,
      },
    }));

    expect(markup).toContain("Waiting for reading");
    expect(markup).not.toContain(">42");
  });
});
