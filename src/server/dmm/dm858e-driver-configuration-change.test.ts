import { describe, expect, it } from "vitest";

import {
  DmmAcquisitionRate,
  DmmMeasurementFunction,
  DmmRangeMode,
  DmmReadingKind,
  DmmReadingUnavailableReason,
  DmmUnit,
  type DmmReadingSnapshot,
} from "../../shared/dmm-types.js";
import {
  ScpiOperationKind,
  type ScpiOperation,
  type ScpiOperationRecorder,
  type ScpiScheduler,
} from "../scpi/scpi-scheduler.js";
import { ScpiResponseKind, type ScpiTransport } from "../scpi/scpi-transport.js";
import { Dm858eDriver } from "./dm858e-driver.js";
import { DmmPoller } from "./dmm-poller.js";
import { DmmStateStore } from "./dmm-state-store.js";

class ScriptedTransport {
  public readonly responses = new Map<string, string[]>();

  public command = async (): Promise<void> => {};

  public queryText = async (command: string): Promise<string> => {
    const values = this.responses.get(command);
    const value = values?.shift();
    if (value === undefined) {
      throw new Error(`No scripted response for ${command}`);
    }
    return value;
  };

  public query = async (command: string) => ({
    kind: ScpiResponseKind.Text as const,
    value: await this.queryText(command),
  });

  public isUsable = (): boolean => true;
}

function driverFor(transport: ScriptedTransport): Dm858eDriver {
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

function respond(transport: ScriptedTransport, command: string, ...values: string[]): void {
  transport.responses.set(command, values);
}

describe("Dm858eDriver configuration-change snapshots", () => {
  it("publishes stable same-function configuration changes as unavailable", async () => {
    const transport = new ScriptedTransport();
    respond(transport, "STATus:OPERation:CONDition?", "256", "256");
    respond(
      transport,
      "CONFigure?",
      "VOLT 1.00000000E+01,1.00000000E-04",
      "VOLT 1.00000000E+01,1.00000000E-04",
    );
    respond(transport, "SENSe:FUNCtion?", "VOLT", "VOLT");
    respond(transport, "DATA:LAST?", "-5.08000000E-01 VDC");

    await expect(driverFor(transport).readPrimarySnapshot(
      DmmMeasurementFunction.DcVoltage,
    )).resolves.toEqual({
      kind: DmmReadingKind.Unavailable,
      function: DmmMeasurementFunction.DcVoltage,
      unit: DmmUnit.Volts,
      reason: DmmReadingUnavailableReason.ConfigurationChanged,
    });
  });

  it("keeps function-instability observations unpublished", async () => {
    const transport = new ScriptedTransport();
    respond(transport, "STATus:OPERation:CONDition?", "256", "256");
    respond(
      transport,
      "CONFigure?",
      "VOLT 1.00000000E+01,1.00000000E-04",
      "VOLT 1.00000000E+01,1.00000000E-04",
    );
    respond(transport, "SENSe:FUNCtion?", "VOLT", "RES");
    respond(transport, "DATA:LAST?", "-5.08000000E-01 VDC");

    await expect(driverFor(transport).readPrimarySnapshot(
      DmmMeasurementFunction.DcVoltage,
    )).resolves.toBeNull();
  });

  it("publishes Value X -> ConfigurationChanged -> the same Value X through the poller", async () => {
    const transport = new ScriptedTransport();
    const configuration = "VOLT 1.00000000E+01,1.00000000E-04";
    respond(
      transport,
      "CONFigure?",
      configuration,
      configuration,
      configuration,
      configuration,
      configuration,
      configuration,
      configuration,
    );
    respond(transport, "SENSe:VOLTage:DC:RANGe:AUTO?", "1");
    respond(transport, "SENSe:VOLTage:DC:RANGe?", "1.00000000E+01");
    respond(transport, "SENSe:VOLTage:DC:NPLC?", "2.00000000E+01");
    respond(
      transport,
      "STATus:OPERation:CONDition?",
      "0",
      "0",
      "256",
      "256",
      "0",
      "0",
    );
    respond(
      transport,
      "SENSe:FUNCtion?",
      "VOLT",
      "VOLT",
      "VOLT",
      "VOLT",
      "VOLT",
      "VOLT",
    );
    respond(
      transport,
      "DATA:LAST?",
      "1.25000000E+00 VDC",
      "1.25000000E+00 VDC",
      "1.25000000E+00 VDC",
    );

    const stateStore = new DmmStateStore({
      function: DmmMeasurementFunction.DcVoltage,
      range: { mode: DmmRangeMode.Auto },
      acquisitionRate: DmmAcquisitionRate.Slow,
    });
    const published: DmmReadingSnapshot[] = [];
    let poller!: DmmPoller;
    poller = new DmmPoller({
      driver: driverFor(transport),
      stateStore,
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
      {
        kind: DmmReadingKind.Value,
        function: DmmMeasurementFunction.DcVoltage,
        value: 1.25,
        resolution: 1e-4,
        unit: DmmUnit.Volts,
      },
      {
        kind: DmmReadingKind.Unavailable,
        function: DmmMeasurementFunction.DcVoltage,
        unit: DmmUnit.Volts,
        reason: DmmReadingUnavailableReason.ConfigurationChanged,
      },
      {
        kind: DmmReadingKind.Value,
        function: DmmMeasurementFunction.DcVoltage,
        value: 1.25,
        resolution: 1e-4,
        unit: DmmUnit.Volts,
      },
    ]);
  });
});
