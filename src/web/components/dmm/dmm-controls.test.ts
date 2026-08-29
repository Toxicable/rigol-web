import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  DmmAcquisitionRate,
  DmmControlKind,
  DmmMeasurementFunction,
  DmmRangeMode,
  type DmmState,
} from "../../../shared/dmm-types.js";
import {
  DmmControls,
  functionControlForSelection,
  rangeControlForState,
  rateControlForState,
} from "./dmm-controls.js";

const dcVoltageState: DmmState = {
  function: DmmMeasurementFunction.DcVoltage,
  range: { mode: DmmRangeMode.Auto },
  acquisitionRate: DmmAcquisitionRate.Slow,
};

const continuityState: DmmState = {
  function: DmmMeasurementFunction.Continuity,
  range: null,
  acquisitionRate: null,
};

describe("DMM controls", () => {
  it("creates direct function-selection controls", () => {
    expect(functionControlForSelection(DmmMeasurementFunction.Resistance4Wire)).toEqual({
      kind: DmmControlKind.Function,
      value: DmmMeasurementFunction.Resistance4Wire,
    });
  });

  it("binds range requests to the authoritative current function", () => {
    expect(rangeControlForState(dcVoltageState, {
      mode: DmmRangeMode.Fixed,
      value: 10,
    })).toEqual({
      kind: DmmControlKind.Range,
      function: DmmMeasurementFunction.DcVoltage,
      value: { mode: DmmRangeMode.Fixed, value: 10 },
    });
  });

  it("binds rate requests to the authoritative current function", () => {
    expect(rateControlForState(dcVoltageState, DmmAcquisitionRate.Fast)).toEqual({
      kind: DmmControlKind.AcquisitionRate,
      function: DmmMeasurementFunction.DcVoltage,
      value: DmmAcquisitionRate.Fast,
    });
  });

  it("rejects controls that are not applicable to the current state", () => {
    expect(() => rangeControlForState(continuityState, { mode: DmmRangeMode.Auto }))
      .toThrow("does not expose range control");
    expect(() => rateControlForState(continuityState, DmmAcquisitionRate.Fast))
      .toThrow("does not expose acquisition-rate control");
  });

  it("does not render active range or rate controls when state marks them not applicable", () => {
    const markup = renderToStaticMarkup(createElement(DmmControls, {
      state: continuityState,
      pending: false,
      onControl: () => undefined,
    }));

    expect(markup).toContain("Cont");
    expect(markup).not.toContain(">Range<");
    expect(markup).not.toContain("Rate / resolution");
  });

  it("renders the typed range and rate choices for a capable function", () => {
    const markup = renderToStaticMarkup(createElement(DmmControls, {
      state: dcVoltageState,
      pending: false,
      onControl: () => undefined,
    }));

    expect(markup).toContain(">Range<");
    expect(markup).toContain("100 mV");
    expect(markup).toContain("1 kV");
    expect(markup).toContain("Slow · 5.5 digit");
    expect(markup).toContain("Fast · 4.5 digit");
  });
});
