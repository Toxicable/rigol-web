import { describe, expect, it } from "vitest";

import {
  DmmAcquisitionRate,
  DmmMeasurementFunction,
  DmmRangeMode,
  DmmReadingKind,
  DmmReadingUnavailableReason,
  DmmUnit,
  dmmUnitForFunction,
  type DmmInfo,
  type DmmReadingSnapshot,
  type DmmState,
} from "../../shared/dmm-types.js";
import {
  DmmConnectionKind,
  type DmmConnection,
} from "../instruments/instrument-connection.js";
import { DmmService } from "./dmm-service.js";

interface ServiceInternals {
  acceptConnection(connection: DmmConnection): void;
  acceptState(state: DmmState): void;
  acceptSnapshot(snapshot: DmmReadingSnapshot): void;
}

const info: DmmInfo = {
  manufacturer: "RIGOL TECHNOLOGIES",
  model: "DM858E",
  serialNumber: "TEST-DMM",
  firmwareVersion: "00.01.00",
};

const initialState: DmmState = {
  function: DmmMeasurementFunction.DcVoltage,
  range: { mode: DmmRangeMode.Auto },
  acquisitionRate: DmmAcquisitionRate.Slow,
};

const valueSnapshot: DmmReadingSnapshot = {
  kind: DmmReadingKind.Value,
  function: DmmMeasurementFunction.DcVoltage,
  value: 1.25,
  resolution: 1e-5,
  unit: DmmUnit.Volts,
};

function configurationChanged(functionValue: DmmMeasurementFunction): DmmReadingSnapshot {
  return {
    kind: DmmReadingKind.Unavailable,
    function: functionValue,
    unit: dmmUnitForFunction(functionValue),
    reason: DmmReadingUnavailableReason.ConfigurationChanged,
  };
}

function createHarness() {
  const service = new DmmService({ host: "dmm.test", port: 5556 });
  const internals = service as unknown as ServiceInternals;
  const states: DmmState[] = [];
  const snapshots: DmmReadingSnapshot[] = [];
  service.subscribeState((state) => states.push(state));
  service.subscribeSnapshot((snapshot) => snapshots.push(snapshot));
  internals.acceptConnection({
    kind: DmmConnectionKind.Connected,
    info,
    state: initialState,
  });
  internals.acceptSnapshot(valueSnapshot);
  return { service, internals, states, snapshots };
}

describe("DmmService current snapshot lifecycle", () => {
  it.each([
    {
      name: "range",
      nextState: {
        ...initialState,
        range: { mode: DmmRangeMode.Fixed, value: 10 },
      } satisfies DmmState,
    },
    {
      name: "rate",
      nextState: {
        ...initialState,
        acquisitionRate: DmmAcquisitionRate.Fast,
      } satisfies DmmState,
    },
  ])("invalidates retained snapshots before replay after same-function $name changes", ({ nextState }) => {
    const { service, internals, snapshots } = createHarness();

    internals.acceptState(nextState);
    const invalidated = configurationChanged(DmmMeasurementFunction.DcVoltage);
    expect(service.getCurrentSnapshot()).toEqual(invalidated);
    expect(snapshots).toEqual([valueSnapshot, invalidated]);

    service.replayCurrentSnapshot();
    expect(snapshots).toEqual([valueSnapshot, invalidated, invalidated]);
    expect(snapshots.slice(1)).not.toContainEqual(valueSnapshot);
  });

  it("deduplicates unchanged snapshots at the application-service boundary", () => {
    const { service, internals, snapshots } = createHarness();

    internals.acceptSnapshot(valueSnapshot);

    expect(snapshots).toEqual([valueSnapshot]);
    expect(service.getCurrentSnapshot()).toEqual(valueSnapshot);
  });

  it("publishes an equal numeric value when its authoritative resolution changes", () => {
    const { service, internals, snapshots } = createHarness();
    const changedResolution: DmmReadingSnapshot = {
      ...valueSnapshot,
      resolution: 0.001,
    };

    internals.acceptSnapshot(changedResolution);

    expect(snapshots).toEqual([valueSnapshot, changedResolution]);
    expect(service.getCurrentSnapshot()).toEqual(changedResolution);
  });

  it("publishes the same numeric value again after state invalidation", () => {
    const { service, internals, snapshots } = createHarness();
    const nextState: DmmState = {
      ...initialState,
      range: { mode: DmmRangeMode.Fixed, value: 10 },
    };

    internals.acceptState(nextState);
    internals.acceptSnapshot(valueSnapshot);

    expect(snapshots).toEqual([
      valueSnapshot,
      configurationChanged(DmmMeasurementFunction.DcVoltage),
      valueSnapshot,
    ]);
    expect(service.getCurrentSnapshot()).toEqual(valueSnapshot);
  });

  it("invalidates the retained snapshot when the authoritative function changes", () => {
    const { service, internals, states, snapshots } = createHarness();
    const resistanceState: DmmState = {
      function: DmmMeasurementFunction.Resistance2Wire,
      range: { mode: DmmRangeMode.Auto },
      acquisitionRate: DmmAcquisitionRate.Slow,
    };

    internals.acceptState(resistanceState);

    const invalidated = configurationChanged(DmmMeasurementFunction.Resistance2Wire);
    expect(states).toEqual([resistanceState]);
    expect(snapshots).toEqual([valueSnapshot, invalidated]);
    expect(service.getCurrentSnapshot()).toEqual(invalidated);
  });

  it("clears the retained snapshot when the runtime disconnects", () => {
    const { service, internals } = createHarness();

    internals.acceptConnection({
      kind: DmmConnectionKind.Disconnected,
      reason: "transport lost",
    });

    expect(service.getCurrentSnapshot()).toBeNull();
  });
});
