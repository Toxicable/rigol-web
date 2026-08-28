import { describe, expect, it } from "vitest";

import {
  DmmAcquisitionRate,
  DmmControlKind,
  DmmMeasurementFunction,
  DmmRangeMode,
  type DmmState,
} from "../../shared/dmm-types.js";
import {
  ScpiOperationKind,
  type ScpiOperation,
  type ScpiOperationRecorder,
  type ScpiScheduler,
} from "../scpi/scpi-scheduler.js";
import type { ScpiTransport } from "../scpi/scpi-transport.js";
import { Dm858eDriver } from "./dm858e-driver.js";
import { DmmRuntime } from "./dmm-runtime.js";
import { DmmStateStore } from "./dmm-state-store.js";

interface PhysicalRange {
  auto: boolean;
  value: number;
}

class AcRangeRaceTransport {
  public readonly commands: string[] = [];
  public range: PhysicalRange;
  private pendingRangeChange: PhysicalRange | null;
  private resolutionRatio = 1e-5;

  public constructor(initialRange: PhysicalRange, nextRange: PhysicalRange) {
    this.range = { ...initialRange };
    this.pendingRangeChange = { ...nextRange };
  }

  public command = async (command: string): Promise<void> => {
    this.commands.push(command);
    const match = /^CONFigure:VOLTage:AC (AUTO|[+\-0-9.Ee]+),([+\-0-9.Ee]+)$/.exec(command);
    if (match === null || match[1] === undefined || match[2] === undefined) {
      return;
    }

    const resolution = Number(match[2]);
    if (match[1] === "AUTO") {
      this.range = { auto: true, value: this.range.value };
      this.resolutionRatio = resolution / this.range.value;
      return;
    }

    const range = Number(match[1]);
    this.range = { auto: false, value: range };
    this.resolutionRatio = resolution / range;
  };

  public queryText = async (command: string): Promise<string> => {
    this.commands.push(command);
    switch (command) {
      case "CONFigure?":
        return `VOLT:AC ${this.range.value},${this.range.value * this.resolutionRatio}`;
      case "SENSe:FUNCtion?":
        return "VOLT:AC";
      case "SENSe:VOLTage:AC:RANGe:AUTO?":
        return this.range.auto ? "1" : "0";
      case "SENSe:VOLTage:AC:RANGe?": {
        const response = String(this.range.value);
        if (this.pendingRangeChange !== null) {
          this.range = this.pendingRangeChange;
          this.pendingRangeChange = null;
        }
        return response;
      }
      default:
        throw new Error(`Unexpected SCPI query: ${command}`);
    }
  };

  public isUsable = (): boolean => true;
}

function driverFor(transport: AcRangeRaceTransport): Dm858eDriver {
  const recorder: ScpiOperationRecorder = { addBinaryBytes: () => {} };
  const run = <T>(operation: ScpiOperation<T>): Promise<T> => operation.execute(
    transport as unknown as ScpiTransport,
    recorder,
  );
  const scheduler = {
    schedule: run,
    scheduleImmediate: <T>(
      _kind: ScpiOperationKind,
      _key: unknown,
      execute: ScpiOperation<T>["execute"],
    ) => execute(transport as unknown as ScpiTransport, recorder),
  } as unknown as ScpiScheduler;
  return new Dm858eDriver(scheduler);
}

interface RuntimeInternals {
  session: {
    driver: Dm858eDriver;
    stateStore: DmmStateStore;
    transport: Pick<ScpiTransport, "isUsable">;
  } | null;
}

function runtimeFor(transport: AcRangeRaceTransport, initialState: DmmState): {
  runtime: DmmRuntime;
  stateStore: DmmStateStore;
} {
  const runtime = new DmmRuntime({
    host: "dmm.test",
    port: 5556,
    publishConnection: () => {},
    publishState: () => {},
    publishSnapshot: () => {},
  });
  const stateStore = new DmmStateStore(initialState);
  (runtime as unknown as RuntimeInternals).session = {
    driver: driverFor(transport),
    stateStore,
    transport,
  };
  return { runtime, stateStore };
}

describe("DmmRuntime AC rate range races", () => {
  it("preserves a front-panel fixed 10 V to fixed 100 V change", async () => {
    const transport = new AcRangeRaceTransport(
      { auto: false, value: 10 },
      { auto: false, value: 100 },
    );
    const { runtime, stateStore } = runtimeFor(transport, {
      function: DmmMeasurementFunction.AcVoltage,
      range: { mode: DmmRangeMode.Fixed, value: 10 },
      acquisitionRate: DmmAcquisitionRate.Slow,
    });

    await runtime.setControl({
      kind: DmmControlKind.AcquisitionRate,
      function: DmmMeasurementFunction.AcVoltage,
      value: DmmAcquisitionRate.Fast,
    });

    expect(transport.range).toEqual({ auto: false, value: 100 });
    expect(stateStore.getState()).toEqual({
      function: DmmMeasurementFunction.AcVoltage,
      range: { mode: DmmRangeMode.Fixed, value: 100 },
      acquisitionRate: DmmAcquisitionRate.Fast,
    });
    expect(transport.commands).toContain("CONFigure:VOLTage:AC 100,0.1");
    expect(transport.commands).not.toContain("CONFigure:VOLTage:AC 10,0.01");
  });

  it("preserves a front-panel Auto to fixed range change", async () => {
    const transport = new AcRangeRaceTransport(
      { auto: true, value: 10 },
      { auto: false, value: 100 },
    );
    const { runtime, stateStore } = runtimeFor(transport, {
      function: DmmMeasurementFunction.AcVoltage,
      range: { mode: DmmRangeMode.Auto },
      acquisitionRate: DmmAcquisitionRate.Slow,
    });

    await runtime.setControl({
      kind: DmmControlKind.AcquisitionRate,
      function: DmmMeasurementFunction.AcVoltage,
      value: DmmAcquisitionRate.Fast,
    });

    expect(transport.range).toEqual({ auto: false, value: 100 });
    expect(stateStore.getState()).toEqual({
      function: DmmMeasurementFunction.AcVoltage,
      range: { mode: DmmRangeMode.Fixed, value: 100 },
      acquisitionRate: DmmAcquisitionRate.Fast,
    });
    expect(transport.commands).toContain("CONFigure:VOLTage:AC 100,0.1");
    expect(transport.commands).not.toContain("CONFigure:VOLTage:AC AUTO,0.01");
  });
});
