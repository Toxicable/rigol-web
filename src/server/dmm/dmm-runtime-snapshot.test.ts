import { describe, expect, it } from "vitest";

import {
  DmmAcquisitionRate,
  DmmMeasurementFunction,
  DmmRangeMode,
  DmmReadingKind,
  DmmReadingUnavailableReason,
  DmmUnit,
  dmmUnitForFunction,
  type DmmReadingSnapshot,
  type DmmState,
} from "../../shared/dmm-types.js";
import type { Dm858eDriver } from "./dm858e-driver.js";
import { DmmPoller } from "./dmm-poller.js";
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
  resolution: 1e-5,
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
  return {
    kind: DmmReadingKind.Unavailable,
    function: functionValue,
    unit: dmmUnitForFunction(functionValue),
    reason: DmmReadingUnavailableReason.ConfigurationChanged,
  };
}

class EqualValueAfterStateChangeDriver {
  private readonly snapshots: DmmReadingSnapshot[] = [valueSnapshot, valueSnapshot];

  public async readDmmState(): Promise<DmmState> {
    return initialState;
  }

  public async readPrimarySnapshot(): Promise<DmmReadingSnapshot | null> {
    return this.snapshots.shift() ?? null;
  }
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

  it("deduplicates unchanged polled snapshots at the runtime ownership boundary", () => {
    const { snapshots, stateStore, internals } = createHarness();

    internals.acceptSnapshot(stateStore, valueSnapshot);

    expect(snapshots).toEqual([valueSnapshot]);
    expect(internals.currentSnapshot).toEqual(valueSnapshot);
  });

  it("publishes an equal numeric value when its authoritative resolution changes", () => {
    const { snapshots, stateStore, internals } = createHarness();
    const changedResolution: DmmReadingSnapshot = {
      ...valueSnapshot,
      resolution: 0.001,
    };

    internals.acceptSnapshot(stateStore, changedResolution);

    expect(snapshots).toEqual([valueSnapshot, changedResolution]);
    expect(internals.currentSnapshot).toEqual(changedResolution);
  });

  it("publishes the same numeric value again after a same-function state change", async () => {
    const states: DmmState[] = [];
    const snapshots: DmmReadingSnapshot[] = [];
    const nextState: DmmState = {
      ...initialState,
      range: { mode: DmmRangeMode.Fixed, value: 10 },
    };
    const stateStore = new DmmStateStore(initialState);
    let poller!: DmmPoller;
    const runtime = new DmmRuntime({
      host: "dmm.test",
      port: 5556,
      publishConnection: () => {},
      publishState: (state) => states.push(state),
      publishSnapshot: (snapshot) => {
        snapshots.push(snapshot);
        if (snapshots.length === 1) {
          stateStore.replaceState(nextState);
        } else if (snapshots.length === 3) {
          poller.stop();
        }
      },
    });
    const internals = runtime as unknown as RuntimeInternals;
    internals.session = { stateStore };
    stateStore.subscribe((state) => internals.acceptState(stateStore, state));

    poller = new DmmPoller({
      driver: new EqualValueAfterStateChangeDriver() as unknown as Dm858eDriver,
      stateStore,
      readingIntervalMs: 0,
      stateIntervalMs: 60_000,
      publishSnapshot: (snapshot) => internals.acceptSnapshot(stateStore, snapshot),
      reportError: (error) => {
        throw error;
      },
    });

    poller.start();
    await poller.waitForIdle();

    expect(states).toEqual([nextState]);
    expect(snapshots).toEqual([
      valueSnapshot,
      configurationChanged(DmmMeasurementFunction.DcVoltage),
      valueSnapshot,
    ]);
    expect(internals.currentSnapshot).toEqual(valueSnapshot);
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
