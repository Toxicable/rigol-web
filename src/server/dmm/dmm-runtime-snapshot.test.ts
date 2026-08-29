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

const initialState: DmmState = {
  function: DmmMeasurementFunction.DcVoltage,
  range: { mode: DmmRangeMode.Auto },
  acquisitionRate: DmmAcquisitionRate.Slow,
};

const valueSnapshot: DmmReadingSnapshot = {
  kind: DmmReadingKind.Value,
  function: DmmMeasurementFunction.DcVoltage,
  value: 1.25,
  unit: DmmUnit.Volts,
};

function createHarness() {
  const states: DmmState[] = [];
  const snapshots: DmmReadingSnapshot[] = [];
  const runtime = new DmmRuntime({
    host: "dmm.test",
    port: 5556,
    publishConnection: () => {},
    publishState: (state) => states.push(state),
    publishSnapshot: (snapshot) => snapshots.push(snapshot),
  });
  const stateStore = new DmmStateStore(initialState);
  const internals = runtime as unknown as RuntimeInternals;
  internals.session = { stateStore };
  stateStore.subscribe((state) => internals.acceptState(stateStore, state));
  internals.acceptSnapshot(stateStore, valueSnapshot);
  return { states, snapshots, runtime, stateStore, internals };
}

function configurationChanged(functionValue: DmmMeasurementFunction): DmmReadingSnapshot {
  const unit = functionValue === DmmMeasurementFunction.Resistance2Wire
    ? DmmUnit.Ohms
    : DmmUnit.Volts;
  return {
    kind: DmmReadingKind.Unavailable,
    function: functionValue,
    unit,
    reason: DmmReadingUnavailableReason.ConfigurationChanged,
  };
}

describe("DmmRuntime current snapshot lifecycle", () => {
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
    const { snapshots, runtime, stateStore, internals } = createHarness();
    expect(snapshots).toEqual([valueSnapshot]);

    stateStore.replaceState(nextState);
    const invalidated = configurationChanged(DmmMeasurementFunction.DcVoltage);
    expect(internals.currentSnapshot).toEqual(invalidated);
    expect(snapshots[snapshots.length - 1]).toEqual(invalidated);

    const afterStateChange = snapshots.length;
    runtime.subscriberAdded();
    expect(snapshots.slice(afterStateChange)).toEqual([invalidated]);
    expect(snapshots.slice(afterStateChange)).not.toContainEqual(valueSnapshot);
  });

  it("preserves the current snapshot across an equivalent authoritative state poll", () => {
    const { states, snapshots, runtime, stateStore, internals } = createHarness();

    stateStore.replaceState({
      function: DmmMeasurementFunction.DcVoltage,
      range: { mode: DmmRangeMode.Auto },
      acquisitionRate: DmmAcquisitionRate.Slow,
    });

    expect(states).toEqual([]);
    expect(internals.currentSnapshot).toEqual(valueSnapshot);
    runtime.subscriberAdded();
    expect(snapshots).toEqual([valueSnapshot, valueSnapshot]);
  });

  it("invalidates the retained snapshot when the authoritative function changes", () => {
    const { states, snapshots, runtime, stateStore, internals } = createHarness();
    const resistanceState: DmmState = {
      function: DmmMeasurementFunction.Resistance2Wire,
      range: { mode: DmmRangeMode.Auto },
      acquisitionRate: DmmAcquisitionRate.Slow,
    };

    stateStore.replaceState(resistanceState);

    const invalidated = configurationChanged(DmmMeasurementFunction.Resistance2Wire);
    expect(states).toEqual([resistanceState]);
    expect(snapshots[snapshots.length - 1]).toEqual(invalidated);
    expect(internals.currentSnapshot).toEqual(invalidated);

    runtime.subscriberAdded();
    expect(snapshots[snapshots.length - 1]).toEqual(invalidated);
  });
});
