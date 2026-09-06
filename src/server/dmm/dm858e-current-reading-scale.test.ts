import { describe, expect, it } from "vitest";

import {
  DmmMeasurementFunction,
  DmmReadingKind,
  DmmUnit,
} from "../../shared/dmm-types.js";
import {
  type ScpiOperation,
  type ScpiOperationRecorder,
  type ScpiScheduler,
} from "../scpi/scpi-scheduler.js";
import type { ScpiTransport } from "../scpi/scpi-transport.js";
import { Dm858eDriver } from "./dm858e-driver.js";

class ScriptedTransport {
  public readonly text = new Map<string, string[]>();

  public queryText = async (command: string): Promise<string> => {
    const values = this.text.get(command);
    const value = values?.shift();
    if (value === undefined) {
      throw new Error(`No scripted text response for ${command}`);
    }
    return value;
  };
}

function scriptedDriver(transport: ScriptedTransport): Dm858eDriver {
  const recorder: ScpiOperationRecorder = { addBinaryBytes: () => {} };
  const scheduler = {
    schedule: <T>(operation: ScpiOperation<T>): Promise<T> => operation.execute(
      transport as unknown as ScpiTransport,
      recorder,
    ),
  } as unknown as ScpiScheduler;
  return new Dm858eDriver(scheduler);
}

function respond(transport: ScriptedTransport, command: string, ...values: string[]): void {
  transport.text.set(command, values);
}

async function readCurrent(
  measurementFunction: DmmMeasurementFunction.DcCurrent | DmmMeasurementFunction.AcCurrent,
  functionToken: string,
  configuration: string,
  response: string,
) {
  const transport = new ScriptedTransport();
  respond(transport, "STATus:OPERation:CONDition?", "0", "0");
  respond(transport, "CONFigure?", configuration, configuration);
  respond(transport, "SENSe:FUNCtion?", functionToken, functionToken);
  respond(transport, "DATA:LAST?", response);

  return scriptedDriver(transport).readPrimarySnapshot(measurementFunction);
}

describe("Dm858eDriver current DATA:LAST? scaling", () => {
  it("normalizes milliamp-range DC readings to amperes", async () => {
    await expect(readCurrent(
      DmmMeasurementFunction.DcCurrent,
      "CURR",
      "CURR 1.00000000E-02,1.00000000E-07",
      "5.00000000E+00 ADC",
    )).resolves.toEqual({
      kind: DmmReadingKind.Value,
      function: DmmMeasurementFunction.DcCurrent,
      value: 0.005,
      resolution: 1e-7,
      unit: DmmUnit.Amps,
    });
  });

  it("normalizes the 100 microamp DC range to amperes", async () => {
    await expect(readCurrent(
      DmmMeasurementFunction.DcCurrent,
      "CURR",
      "CURR 1.00000000E-04,1.00000000E-09",
      "5.00000000E+01 ADC",
    )).resolves.toEqual({
      kind: DmmReadingKind.Value,
      function: DmmMeasurementFunction.DcCurrent,
      value: 50 * 1e-6,
      resolution: 1e-9,
      unit: DmmUnit.Amps,
    });
  });

  it("leaves amp-range DC readings in amperes", async () => {
    await expect(readCurrent(
      DmmMeasurementFunction.DcCurrent,
      "CURR",
      "CURR 3.00000000E+00,3.00000000E-05",
      "2.00000000E+00 ADC",
    )).resolves.toEqual({
      kind: DmmReadingKind.Value,
      function: DmmMeasurementFunction.DcCurrent,
      value: 2,
      resolution: 3e-5,
      unit: DmmUnit.Amps,
    });
  });

  it("normalizes milliamp-range AC readings to amperes", async () => {
    await expect(readCurrent(
      DmmMeasurementFunction.AcCurrent,
      "CURR:AC",
      "CURR:AC 1.00000000E-01,1.00000000E-06",
      "2.50000000E+01 AAC",
    )).resolves.toEqual({
      kind: DmmReadingKind.Value,
      function: DmmMeasurementFunction.AcCurrent,
      value: 0.025,
      resolution: 1e-6,
      unit: DmmUnit.Amps,
    });
  });
});
