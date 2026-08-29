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
import type { Dm858eDriver } from "./dm858e-driver.js";
import { DmmPoller } from "./dmm-poller.js";
import { DmmStateStore } from "./dmm-state-store.js";

const state: DmmState = {
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

const configurationChangedSnapshot: DmmReadingSnapshot = {
  kind: DmmReadingKind.Unavailable,
  function: DmmMeasurementFunction.DcVoltage,
  unit: DmmUnit.Volts,
  reason: DmmReadingUnavailableReason.ConfigurationChanged,
};

class SnapshotSequenceDriver {
  private readonly snapshots: DmmReadingSnapshot[] = [
    valueSnapshot,
    configurationChangedSnapshot,
    valueSnapshot,
  ];

  public async readDmmState(): Promise<DmmState> {
    return state;
  }

  public async readPrimarySnapshot(): Promise<DmmReadingSnapshot | null> {
    return this.snapshots.shift() ?? null;
  }
}

describe("DmmPoller configuration-change dedupe", () => {
  it("publishes Value X -> ConfigurationChanged -> the same Value X again", async () => {
    const published: DmmReadingSnapshot[] = [];
    let poller!: DmmPoller;
    poller = new DmmPoller({
      driver: new SnapshotSequenceDriver() as unknown as Dm858eDriver,
      stateStore: new DmmStateStore(state),
      readingIntervalMs: 0,
      stateIntervalMs: 60_000,
      publishSnapshot: (snapshot) => {
        published.push(snapshot);
        if (published.length === 3) {
          poller.stop();
        }
      },
      reportError: (error) => {
        throw error;
      },
    });

    poller.start();
    await poller.waitForIdle();

    expect(published).toEqual([
      valueSnapshot,
      configurationChangedSnapshot,
      valueSnapshot,
    ]);
  });
});
