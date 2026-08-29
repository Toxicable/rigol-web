import { beforeEach, describe, expect, it } from "vitest";

import {
  DmmAcquisitionRate,
  DmmControlKind,
  DmmMeasurementFunction,
  DmmRangeMode,
  DmmReadingKind,
  DmmUnit,
  type DmmInfo,
  type DmmState,
} from "../../shared/dmm-types.js";
import { useScopeStore } from "../scope-store.js";
import { DmmBrowserConnectionKind, useDmmStore } from "./dmm-store.js";

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

const reading = {
  kind: DmmReadingKind.Value,
  function: DmmMeasurementFunction.DcVoltage,
  value: 12.34,
  unit: DmmUnit.Volts,
} as const;

beforeEach(() => {
  useDmmStore.getState().setConnecting();
});

describe("DMM store", () => {
  it("keeps authoritative state separate from pending controls", () => {
    const store = useDmmStore.getState();
    store.setConnected(info, dcState);
    store.beginControl({
      kind: DmmControlKind.Range,
      function: DmmMeasurementFunction.DcVoltage,
      value: { mode: DmmRangeMode.Fixed, value: 10 },
    });

    const pending = useDmmStore.getState();
    expect(pending.connection.kind).toBe(DmmBrowserConnectionKind.Connected);
    if (pending.connection.kind !== DmmBrowserConnectionKind.Connected) {
      throw new Error("Expected connected DMM");
    }
    expect(pending.connection.state.range).toEqual({ mode: DmmRangeMode.Auto });
    expect(pending.pendingControl?.control).toEqual({
      kind: DmmControlKind.Range,
      function: DmmMeasurementFunction.DcVoltage,
      value: { mode: DmmRangeMode.Fixed, value: 10 },
    });

    pending.replaceState({
      ...dcState,
      range: { mode: DmmRangeMode.Fixed, value: 100 },
    });

    const authoritative = useDmmStore.getState();
    if (authoritative.connection.kind !== DmmBrowserConnectionKind.Connected) {
      throw new Error("Expected connected DMM");
    }
    expect(authoritative.connection.state.range).toEqual({
      mode: DmmRangeMode.Fixed,
      value: 100,
    });
  });

  it("clears a displayed reading when the instrument disconnects", () => {
    const store = useDmmStore.getState();
    store.setConnected(info, dcState);
    store.setLatestReading(reading);
    expect(useDmmStore.getState().latestReading).not.toBeNull();

    useDmmStore.getState().setInstrumentDisconnected("meter offline");

    const disconnected = useDmmStore.getState();
    expect(disconnected.connection).toEqual({
      kind: DmmBrowserConnectionKind.InstrumentDisconnected,
      reason: "meter offline",
    });
    expect(disconnected.latestReading).toBeNull();
  });

  it("drops a stale reading when authoritative function changes", () => {
    const store = useDmmStore.getState();
    store.setConnected(info, dcState);
    store.setLatestReading(reading);

    store.replaceState({
      function: DmmMeasurementFunction.AcVoltage,
      range: { mode: DmmRangeMode.Auto },
      acquisitionRate: DmmAcquisitionRate.Medium,
    });

    expect(useDmmStore.getState().latestReading).toBeNull();
    store.setLatestReading(reading);
    expect(useDmmStore.getState().latestReading).toBeNull();
  });

  it("drops the old reading before rendering a same-function range change", () => {
    const store = useDmmStore.getState();
    store.setConnected(info, dcState);
    store.setLatestReading(reading);

    store.replaceState({
      ...dcState,
      range: { mode: DmmRangeMode.Fixed, value: 10 },
    });

    expect(useDmmStore.getState().latestReading).toBeNull();
  });

  it("drops the old reading before rendering a same-function rate change", () => {
    const store = useDmmStore.getState();
    store.setConnected(info, dcState);
    store.setLatestReading(reading);

    store.replaceState({
      ...dcState,
      acquisitionRate: DmmAcquisitionRate.Fast,
    });

    expect(useDmmStore.getState().latestReading).toBeNull();
  });

  it("retains a reading across an equivalent authoritative state poll", () => {
    const store = useDmmStore.getState();
    store.setConnected(info, dcState);
    store.setLatestReading(reading);

    store.replaceState({
      function: DmmMeasurementFunction.DcVoltage,
      range: { mode: DmmRangeMode.Auto },
      acquisitionRate: DmmAcquisitionRate.Slow,
    });

    expect(useDmmStore.getState().latestReading).toEqual(reading);
  });

  it("surfaces an owned failed control without changing authoritative state", () => {
    const store = useDmmStore.getState();
    store.setConnected(info, dcState);
    const ownership = store.beginControl({
      kind: DmmControlKind.AcquisitionRate,
      function: DmmMeasurementFunction.DcVoltage,
      value: DmmAcquisitionRate.Fast,
    });
    store.failControl(ownership, "Stale DMM control");

    const failed = useDmmStore.getState();
    expect(failed.pendingControl).toBeNull();
    expect(failed.controlError).toBe("Stale DMM control");
    if (failed.connection.kind !== DmmBrowserConnectionKind.Connected) {
      throw new Error("Expected connected DMM");
    }
    expect(failed.connection.state).toEqual(dcState);
  });

  it("ignores an old-session rejection after a newer session control begins", () => {
    const store = useDmmStore.getState();
    store.setConnected(info, dcState);
    const oldOwnership = store.beginControl({
      kind: DmmControlKind.Range,
      function: DmmMeasurementFunction.DcVoltage,
      value: { mode: DmmRangeMode.Fixed, value: 10 },
    });

    store.setConnected(info, dcState);
    const newOwnership = useDmmStore.getState().beginControl({
      kind: DmmControlKind.AcquisitionRate,
      function: DmmMeasurementFunction.DcVoltage,
      value: DmmAcquisitionRate.Fast,
    });
    useDmmStore.getState().failControl(oldOwnership, "old session failed");

    const current = useDmmStore.getState();
    expect(current.pendingControl?.token).toBe(newOwnership.token);
    expect(current.controlError).toBeNull();
  });

  it("ignores an old-route completion after unmount and remount", () => {
    const store = useDmmStore.getState();
    store.setConnected(info, dcState);
    const oldOwnership = store.beginControl({
      kind: DmmControlKind.Range,
      function: DmmMeasurementFunction.DcVoltage,
      value: { mode: DmmRangeMode.Fixed, value: 10 },
    });

    store.setAwaitingInstrument();
    store.setConnected(info, dcState);
    const newOwnership = useDmmStore.getState().beginControl({
      kind: DmmControlKind.AcquisitionRate,
      function: DmmMeasurementFunction.DcVoltage,
      value: DmmAcquisitionRate.Fast,
    });
    useDmmStore.getState().finishControl(oldOwnership);

    expect(useDmmStore.getState().pendingControl?.token).toBe(newOwnership.token);
  });

  it("does not mutate the DHO804 store", () => {
    const scopeConnection = useScopeStore.getState().connection;

    useDmmStore.getState().setConnected(info, dcState);
    useDmmStore.getState().setLatestReading(reading);

    expect(useScopeStore.getState().connection).toBe(scopeConnection);
  });
});
