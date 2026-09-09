import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  DmmAcquisitionRate,
  DmmMeasurementFunction,
  DmmRangeMode,
  DmmReadingKind,
  DmmUnit,
  type DmmInfo,
  type DmmState,
} from "../../shared/dmm-types.js";
import { AppTransportKind } from "../app-transport-store.js";
import {
  bindDmmRoute,
  type DmmLifecycleBinding,
} from "./dmm-route-binding.js";
import { DmmRouteView } from "./dmm-route.js";
import { DmmBrowserConnectionKind } from "./dmm-store.js";

const info: DmmInfo = {
  manufacturer: "RIGOL TECHNOLOGIES",
  model: "DM858E",
  serialNumber: "DM8A000000000",
  firmwareVersion: "00.01",
};

const dcState: DmmState = {
  function: DmmMeasurementFunction.DcVoltage,
  range: { mode: DmmRangeMode.Auto },
  acquisitionRate: DmmAcquisitionRate.Slow,
};

const callbacks = {
  onFunction: () => undefined,
  onRange: () => undefined,
  onAcquisitionRate: () => undefined,
};

describe("DM858E route", () => {
  it("activates publication on mount and deactivates it on cleanup", () => {
    const binding: DmmLifecycleBinding = {
      activate: vi.fn(),
      deactivate: vi.fn(),
    };

    const cleanup = bindDmmRoute(binding);
    expect(binding.activate).toHaveBeenCalledOnce();
    expect(binding.deactivate).not.toHaveBeenCalled();

    cleanup();
    expect(binding.deactivate).toHaveBeenCalledOnce();
  });

  it("renders disconnected transport without a plausible measurement", () => {
    const markup = renderToStaticMarkup(createElement(DmmRouteView, {
      transport: {
        kind: AppTransportKind.Disconnected,
        reason: "socket lost",
      },
      connection: { kind: DmmBrowserConnectionKind.AwaitingInstrument },
      latestReading: null,
      pending: false,
      controlError: null,
      ...callbacks,
    }));

    expect(markup).toContain("Transport offline");
    expect(markup).toContain("socket lost");
    expect(markup).not.toContain("Latest reading");
  });

  it("renders physical DMM disconnect separately from transport loss", () => {
    const markup = renderToStaticMarkup(createElement(DmmRouteView, {
      transport: { kind: AppTransportKind.Connected },
      connection: {
        kind: DmmBrowserConnectionKind.InstrumentDisconnected,
        reason: "meter rebooted",
      },
      latestReading: null,
      pending: false,
      controlError: null,
      ...callbacks,
    }));

    expect(markup).toContain("DMM offline");
    expect(markup).toContain("meter rebooted");
  });

  it("renders the connected reading, trend and horizontal controls", () => {
    const markup = renderToStaticMarkup(createElement(DmmRouteView, {
      transport: { kind: AppTransportKind.Connected },
      connection: {
        kind: DmmBrowserConnectionKind.Connected,
        info,
        state: dcState,
      },
      latestReading: {
        kind: DmmReadingKind.Value,
        function: DmmMeasurementFunction.DcVoltage,
        value: 12.34,
        resolution: 0.001,
        unit: DmmUnit.Volts,
      },
      pending: false,
      controlError: null,
      ...callbacks,
    }));

    expect(markup).toContain("Connected");
    expect(markup).toContain("Latest reading");
    expect(markup).toContain(">12.34<");
    expect(markup).not.toContain("12.3400");
    expect(markup).toContain("Snapshot trend");
    expect(markup).toContain("Horizontal");
    expect(markup).toContain("Time/div");
    expect(markup).toContain("Latest");
    expect(markup).not.toContain("DATA:LAST?");
  });
});
