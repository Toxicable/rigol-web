import { describe, expect, it } from "vitest";

import {
  DmmAcquisitionRate,
  DmmMeasurementFunction,
  DmmRangeMode,
  DmmReadingKind,
  DmmReadingUnavailableReason,
  DmmUnit,
  type DmmReadingSnapshot,
  type DmmState,
} from "../../shared/dmm-types.js";
import { DmmRuntime } from "./dmm-runtime.js";
import { DmmStateStore } from "./dmm-state-store.js";

interface RuntimeInternals {
  session: { stateStore: DmmStateStore } | null;
  currentSnapshot: DmmReadingSnapshot | null;
  acceptState(stateStore: DmmStateStore, state: DmmState): void;
  acceptSnapshot(stateStore: DmmStateStore, snapshot: DmmReadingSnapshot): void;
}

describe("DmmRuntime current snapshot lifecycle", () => {
  it("replays the current snapshot and invalidates it when the authoritative function changes", () => {
    const states: DmmState[] = [];
    const snapshots: DmmReadingSnapshot[] = [];
    const runtime = new DmmRuntime({
      host: "dmm.test",
      port: 5556,
      publishConnection: () => {},
      publishState: (state) => states.push(state),
      publishSnapshot: (snapshot) => snapshots.push(snapshot),
    });
    const initialState: DmmState = {
      function: DmmMeasurementFunction.DcVoltage,
      range: { mode: DmmRangeMode.Auto },
      acquisitionRate: DmmAcquisitionRate.Slow,
    };
    const stateStore = new DmmStateStore(initialState);
    const internals = runtime as unknown as RuntimeInternals;
    internals.session = { stateStore };

    const valueSnapshot: DmmReadingSnapshot = {
      kind: DmmReadingKind.Value,
      function: DmmMeasurementFunction.DcVoltage,
      value: 1.25,
      unit: DmmUnit.Volts,
    };
    internals.acceptSnapshot(stateStore, valueSnapshot);
    expect(snapshots).toEqual([valueSnapshot]);

    runtime.subscriberAdded();
    expect(snapshots).toEqual([valueSnapshot, valueSnapshot]);

    const resistanceState: DmmState = {
      function: DmmMeasurementFunction.Resistance2Wire,
      range: { mode: DmmRangeMode.Auto },
      acquisitionRate: DmmAcquisitionRate.Slow,
    };
    internals.acceptState(stateStore, resistanceState);

    const invalidated: DmmReadingSnapshot = {
      kind: DmmReadingKind.Unavailable,
      function: DmmMeasurementFunction.Resistance2Wire,
      unit: DmmUnit.Ohms,
      reason: DmmReadingUnavailableReason.ConfigurationChanged,
    };
    expect(states).toEqual([resistanceState]);
    expect(snapshots[snapshots.length - 1]).toEqual(invalidated);
    expect(internals.currentSnapshot).toEqual(invalidated);

    runtime.subscriberAdded();
    expect(snapshots[snapshots.length - 1]).toEqual(invalidated);
    expect(snapshots).not.toContainEqual({
      ...valueSnapshot,
      function: DmmMeasurementFunction.Resistance2Wire,
    });
  });
});
