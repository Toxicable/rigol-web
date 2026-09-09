import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  DmmAcquisitionRate,
  DmmMeasurementFunction,
  DmmRangeMode,
  type DmmState,
} from "../../../shared/dmm-types.js";
import { DmmControls } from "./dmm-controls.js";

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

const callbacks = {
  onFunction: () => undefined,
  onRange: () => undefined,
  onAcquisitionRate: () => undefined,
};

describe("DMM controls", () => {
  it("does not render range or rate controls when state marks them not applicable", () => {
    const markup = renderToStaticMarkup(createElement(DmmControls, {
      state: continuityState,
      pending: false,
      ...callbacks,
    }));

    expect(markup).toContain("Cont");
    expect(markup).not.toContain(">Range<");
    expect(markup).not.toContain("Rate / resolution");
  });

  it("renders the typed range and rate choices for a capable function", () => {
    const markup = renderToStaticMarkup(createElement(DmmControls, {
      state: dcVoltageState,
      pending: false,
      ...callbacks,
    }));

    expect(markup).toContain(">Range<");
    expect(markup).toContain("100 mV");
    expect(markup).toContain("1 kV");
    expect(markup).toContain("Slow · 5.5 digit");
    expect(markup).toContain("Fast · 4.5 digit");
  });

  it("disables active choices and all controls while an action is pending", () => {
    const activeMarkup = renderToStaticMarkup(createElement(DmmControls, {
      state: dcVoltageState,
      pending: false,
      ...callbacks,
    }));
    expect(activeMarkup).toMatch(/aria-pressed="true" disabled=""[^>]*title="DC voltage"/);
    expect(activeMarkup).toMatch(/aria-pressed="true" disabled=""[^>]*>Auto<\/button>/);
    expect(activeMarkup).toMatch(/aria-pressed="true" disabled=""[^>]*>Slow · 5\.5 digit<\/button>/);

    const pendingMarkup = renderToStaticMarkup(createElement(DmmControls, {
      state: dcVoltageState,
      pending: true,
      ...callbacks,
    }));
    expect(pendingMarkup).toContain("Applying…");
    expect((pendingMarkup.match(/disabled=""/g) ?? []).length).toBeGreaterThan(3);
  });
});
