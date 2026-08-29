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
  public constructor(private readonly snapshots: DmmReadingSnapshot[]) {}

  public async readDmmState(): Promise<DmmState> {
    return state;
  }

  public async readPrimarySnapshot(): Promise<DmmReadingSnapshot | null> {
    return this.snapshots.shift() ?? null;
  }
}

async function collectSnapshots(sequence: DmmReadingSnapshot[]): Promise<DmmReadingSnapshot[]> {
  const published: DmmReadingSnapshot[] = [];
  let poller!: DmmPoller;
  poller = new DmmPoller({
    driver: new SnapshotSequenceDriver([...sequence]) as unknown as Dm858eDriver,
    stateStore: new DmmStateStore(state),
    readingIntervalMs: 0,
    stateIntervalMs: 60_000,
    publishSnapshot: (snapshot) => {
      published.push(snapshot);
      if (published.length === sequence.length) {
        poller.stop();
      }
    },
    reportError: (error) => {
      throw error;
    },
  });

  poller.start();
  await poller.waitForIdle();
  return published;
}

describe("DmmPoller snapshot forwarding", () => {
  it("forwards Value X -> ConfigurationChanged -> the same Value X again", async () => {
    expect(await collectSnapshots([
      valueSnapshot,
      configurationChangedSnapshot,
      valueSnapshot,
    ])).toEqual([
      valueSnapshot,
      configurationChangedSnapshot,
      valueSnapshot,
    ]);
  });

  it("forwards equal snapshots so runtime owns dedupe and replay state", async () => {
    expect(await collectSnapshots([
      valueSnapshot,
      valueSnapshot,
    ])).toEqual([
      valueSnapshot,
      valueSnapshot,
    ]);
  });
});
