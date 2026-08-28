import { describe, expect, it } from "vitest";

import {
  DmmAcquisitionRate,
  DmmMeasurementFunction,
  DmmRangeMode,
  DmmReadingKind,
  DmmReadingUnavailableReason,
  DmmUnit,
} from "../../shared/dmm-types.js";
import {
  ScpiOperationKind,
  type ScpiOperation,
  type ScpiOperationRecorder,
  type ScpiScheduler,
} from "../scpi/scpi-scheduler.js";
import { ScpiResponseKind, type ScpiTransport } from "../scpi/scpi-transport.js";
import { Dm858eDriver } from "./dm858e-driver.js";

class ScriptedTransport {
  public readonly commands: string[] = [];
  public readonly text = new Map<string, string[]>();

  public command = async (command: string): Promise<void> => {
    this.commands.push(command);
  };

  public queryText = async (command: string): Promise<string> => {
    this.commands.push(command);
    const values = this.text.get(command);
    const value = values?.shift();
    if (value === undefined) {
      throw new Error(`No scripted text response for ${command}`);
    }
    return value;
  };

  public query = async (command: string) => ({
    kind: ScpiResponseKind.Text as const,
    value: await this.queryText(command),
  });

  public isUsable = (): boolean => true;
}

interface ReadingObservation {
  functionToken: string;
  response: string;
  operationStatus?: number;
}

function scriptedDriver(transport: ScriptedTransport): Dm858eDriver {
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
  transport.text.set(command, values);
}

function scriptReadingObservations(
  transport: ScriptedTransport,
  ...observations: ReadingObservation[]
): void {
  respond(
    transport,
    "STATus:OPERation:CONDition?",
    ...observations.flatMap((observation) => {
      const value = String(observation.operationStatus ?? 0);
      return [value, value];
    }),
  );
  respond(
    transport,
    "SENSe:FUNCtion?",
    ...observations.flatMap((observation) => [
      observation.functionToken,
      observation.functionToken,
    ]),
  );
  respond(
    transport,
    "DATA:LAST?",
    ...observations.map((observation) => observation.response),
  );
}

describe("Dm858eDriver", () => {
  it("identifies only a DM858E", async () => {
    const transport = new ScriptedTransport();
    respond(transport, "*IDN?", "RIGOL TECHNOLOGIES,DM858E,DM8A123456,00.01.00.00.22");

    await expect(scriptedDriver(transport).identify()).resolves.toEqual({
      manufacturer: "RIGOL TECHNOLOGIES",
      model: "DM858E",
      serialNumber: "DM8A123456",
      firmwareVersion: "00.01.00.00.22",
    });

    const wrong = new ScriptedTransport();
    respond(wrong, "*IDN?", "RIGOL TECHNOLOGIES,DM858,DM8A123456,00.01");
    await expect(scriptedDriver(wrong).identify()).rejects.toThrow(/Unsupported multimeter model/);
  });

  it("reads fixed DC voltage range and maps 20 PLC to Slow", async () => {
    const transport = new ScriptedTransport();
    respond(transport, "CONFigure?", "VOLT 1.00000000E+01,1.00000000E-04");
    respond(transport, "SENSe:VOLTage:DC:RANGe:AUTO?", "0");
    respond(transport, "SENSe:VOLTage:DC:RANGe?", "1.00000000E+01");
    respond(transport, "SENSe:VOLTage:DC:NPLC?", "2.00000000E+01");

    await expect(scriptedDriver(transport).readDmmState()).resolves.toEqual({
      function: DmmMeasurementFunction.DcVoltage,
      range: { mode: DmmRangeMode.Fixed, value: 10 },
      acquisitionRate: DmmAcquisitionRate.Slow,
    });
  });

  it("reads AC auto range and derives Medium from configured resolution", async () => {
    const transport = new ScriptedTransport();
    respond(transport, "CONFigure?", "VOLT:AC 1.00000000E+01,1.00000000E-03");
    respond(transport, "SENSe:VOLTage:AC:RANGe:AUTO?", "1");
    respond(transport, "SENSe:VOLTage:AC:RANGe?", "1.00000000E+01");

    await expect(scriptedDriver(transport).readDmmState()).resolves.toEqual({
      function: DmmMeasurementFunction.AcVoltage,
      range: { mode: DmmRangeMode.Auto },
      acquisitionRate: DmmAcquisitionRate.Medium,
    });
  });

  it("reports non-applicable range and rate as null", async () => {
    const transport = new ScriptedTransport();
    respond(transport, "CONFigure?", "CONT");

    await expect(scriptedDriver(transport).readDmmState()).resolves.toEqual({
      function: DmmMeasurementFunction.Continuity,
      range: null,
      acquisitionRate: null,
    });
  });

  it("sets exact function and DM858E range commands after checking physical function", async () => {
    const transport = new ScriptedTransport();
    respond(transport, "SENSe:FUNCtion?", "CURR", "CAP", "FREQ");
    const driver = scriptedDriver(transport);

    await driver.setFunction(DmmMeasurementFunction.Resistance4Wire);
    await driver.setRange(DmmMeasurementFunction.DcCurrent, {
      mode: DmmRangeMode.Fixed,
      value: 3,
    });
    await driver.setRange(DmmMeasurementFunction.Capacitance, {
      mode: DmmRangeMode.Auto,
    });
    await driver.setRange(DmmMeasurementFunction.Frequency, {
      mode: DmmRangeMode.Fixed,
      value: 750,
    });

    expect(transport.commands).toEqual([
      "SENSe:FUNCtion \"FRESistance\"",
      "SENSe:FUNCtion?",
      "SENSe:CURRent:DC:RANGe 3",
      "SENSe:FUNCtion?",
      "SENSe:CAPacitance:RANGe:AUTO ON",
      "SENSe:FUNCtion?",
      "SENSe:FREQuency:VOLTage:RANGe 750",
    ]);
  });

  it("rejects DM858-only and unsupported ranges before sending SCPI", async () => {
    const transport = new ScriptedTransport();
    const driver = scriptedDriver(transport);

    await expect(driver.setRange(DmmMeasurementFunction.DcCurrent, {
      mode: DmmRangeMode.Fixed,
      value: 10,
    })).rejects.toThrow(/Unsupported DC current range/);
    await expect(driver.setRange(DmmMeasurementFunction.Capacitance, {
      mode: DmmRangeMode.Fixed,
      value: 0.01,
    })).rejects.toThrow(/Unsupported capacitance range/);
    await expect(driver.setRange(DmmMeasurementFunction.Diode, {
      mode: DmmRangeMode.Auto,
    })).rejects.toThrow(/does not expose a programmable range/);

    expect(transport.commands).toEqual([]);
  });

  it("rejects a stale range request before writing", async () => {
    const transport = new ScriptedTransport();
    respond(transport, "SENSe:FUNCtion?", "RES");
    const driver = scriptedDriver(transport);

    await expect(driver.setRange(DmmMeasurementFunction.DcVoltage, {
      mode: DmmRangeMode.Fixed,
      value: 1_000,
    })).rejects.toThrow(/Stale DMM control/);
    expect(transport.commands).toEqual(["SENSe:FUNCtion?"]);
  });

  it("maps Slow Medium Fast to documented NPLC values with function validation", async () => {
    const transport = new ScriptedTransport();
    respond(transport, "SENSe:FUNCtion?", "VOLT", "VOLT", "VOLT");
    const driver = scriptedDriver(transport);

    await driver.setAcquisitionRate(DmmMeasurementFunction.DcVoltage, DmmAcquisitionRate.Slow);
    await driver.setAcquisitionRate(DmmMeasurementFunction.DcVoltage, DmmAcquisitionRate.Medium);
    await driver.setAcquisitionRate(DmmMeasurementFunction.DcVoltage, DmmAcquisitionRate.Fast);

    expect(transport.commands).toEqual([
      "SENSe:FUNCtion?",
      "SENSe:VOLTage:DC:NPLC 20",
      "SENSe:FUNCtion?",
      "SENSe:VOLTage:DC:NPLC 5",
      "SENSe:FUNCtion?",
      "SENSe:VOLTage:DC:NPLC 0.4",
    ]);
  });

  it("sets AC speed in one scheduler operation and preserves current auto range", async () => {
    const transport = new ScriptedTransport();
    respond(transport, "SENSe:FUNCtion?", "VOLT:AC");
    respond(transport, "SENSe:VOLTage:AC:RANGe:AUTO?", "1");
    respond(transport, "SENSe:VOLTage:AC:RANGe?", "1.00000000E+01");
    const driver = scriptedDriver(transport);

    await driver.setAcquisitionRate(
      DmmMeasurementFunction.AcVoltage,
      DmmAcquisitionRate.Fast,
    );

    expect(transport.commands).toEqual([
      "SENSe:FUNCtion?",
      "SENSe:VOLTage:AC:RANGe:AUTO?",
      "SENSe:VOLTage:AC:RANGe?",
      "CONFigure:VOLTage:AC AUTO,0.01",
    ]);
  });

  it("preserves the current physical fixed AC range while changing only rate", async () => {
    const transport = new ScriptedTransport();
    respond(transport, "SENSe:FUNCtion?", "VOLT:AC");
    respond(transport, "SENSe:VOLTage:AC:RANGe:AUTO?", "0");
    respond(transport, "SENSe:VOLTage:AC:RANGe?", "1.00000000E+02");
    const driver = scriptedDriver(transport);

    await driver.setAcquisitionRate(
      DmmMeasurementFunction.AcVoltage,
      DmmAcquisitionRate.Fast,
    );

    expect(transport.commands).toEqual([
      "SENSe:FUNCtion?",
      "SENSe:VOLTage:AC:RANGe:AUTO?",
      "SENSe:VOLTage:AC:RANGe?",
      "CONFigure:VOLTage:AC 100,0.1",
    ]);
  });

  it("rejects a stale AC rate request before CONFigure can change function", async () => {
    const transport = new ScriptedTransport();
    respond(transport, "SENSe:FUNCtion?", "RES");
    const driver = scriptedDriver(transport);

    await expect(driver.setAcquisitionRate(
      DmmMeasurementFunction.AcVoltage,
      DmmAcquisitionRate.Fast,
    )).rejects.toThrow(/Stale DMM control/);
    expect(transport.commands).toEqual(["SENSe:FUNCtion?"]);
  });

  it("publishes the first stable DATA:LAST value as a latest-reading snapshot", async () => {
    const transport = new ScriptedTransport();
    scriptReadingObservations(
      transport,
      { functionToken: "VOLT", response: "-5.07000000E-01 VDC" },
    );
    const driver = scriptedDriver(transport);

    await expect(driver.readPrimarySnapshot(DmmMeasurementFunction.DcVoltage)).resolves.toEqual({
      kind: DmmReadingKind.Value,
      function: DmmMeasurementFunction.DcVoltage,
      value: -0.507,
      unit: DmmUnit.Volts,
    });
    expect(transport.commands).not.toContain("DATA:POINts?");
  });

  it("does not pretend repeated DATA:LAST snapshots are distinct samples", async () => {
    const transport = new ScriptedTransport();
    scriptReadingObservations(
      transport,
      { functionToken: "VOLT", response: "-5.07000000E-01 VDC" },
      { functionToken: "VOLT", response: "-5.07000000E-01 VDC" },
    );
    const driver = scriptedDriver(transport);

    const expected = {
      kind: DmmReadingKind.Value,
      function: DmmMeasurementFunction.DcVoltage,
      value: -0.507,
      unit: DmmUnit.Volts,
    };
    await expect(driver.readPrimarySnapshot(DmmMeasurementFunction.DcVoltage)).resolves.toEqual(expected);
    await expect(driver.readPrimarySnapshot(DmmMeasurementFunction.DcVoltage)).resolves.toEqual(expected);
  });

  it("retries the same stopped reading after a stale function observation", async () => {
    const transport = new ScriptedTransport();
    scriptReadingObservations(
      transport,
      { functionToken: "RES", response: "1.00000000E+03 OPAQUE_RES" },
      { functionToken: "RES", response: "1.00000000E+03 OPAQUE_RES" },
    );
    const driver = scriptedDriver(transport);

    await expect(driver.readPrimarySnapshot(DmmMeasurementFunction.DcVoltage)).resolves.toBeNull();
    await expect(driver.readPrimarySnapshot(DmmMeasurementFunction.Resistance2Wire)).resolves.toEqual({
      kind: DmmReadingKind.Value,
      function: DmmMeasurementFunction.Resistance2Wire,
      value: 1_000,
      unit: DmmUnit.Ohms,
    });
  });

  it("retries the same reading after a configuration-change observation", async () => {
    const transport = new ScriptedTransport();
    scriptReadingObservations(
      transport,
      {
        functionToken: "VOLT",
        response: "-5.08000000E-01 VDC",
        operationStatus: 256,
      },
      { functionToken: "VOLT", response: "-5.08000000E-01 VDC" },
    );
    const driver = scriptedDriver(transport);

    await expect(driver.readPrimarySnapshot(DmmMeasurementFunction.DcVoltage)).resolves.toBeNull();
    await expect(driver.readPrimarySnapshot(DmmMeasurementFunction.DcVoltage)).resolves.toEqual({
      kind: DmmReadingKind.Value,
      function: DmmMeasurementFunction.DcVoltage,
      value: -0.508,
      unit: DmmUnit.Volts,
    });
  });

  it("publishes documented bare DATA:LAST no-data as unavailable", async () => {
    const transport = new ScriptedTransport();
    scriptReadingObservations(
      transport,
      { functionToken: "VOLT", response: "9.90000000E+37" },
    );
    const driver = scriptedDriver(transport);

    await expect(driver.readPrimarySnapshot(DmmMeasurementFunction.DcVoltage)).resolves.toEqual({
      kind: DmmReadingKind.Unavailable,
      function: DmmMeasurementFunction.DcVoltage,
      unit: DmmUnit.Volts,
      reason: DmmReadingUnavailableReason.NoData,
    });
  });

  it("does not consume latched Questionable Data events while reading snapshots", async () => {
    const transport = new ScriptedTransport();
    scriptReadingObservations(
      transport,
      { functionToken: "VOLT", response: "-5.08000000E-01 VDC" },
    );
    const driver = scriptedDriver(transport);

    await expect(driver.readPrimarySnapshot(DmmMeasurementFunction.DcVoltage)).resolves.toMatchObject({
      kind: DmmReadingKind.Value,
      value: -0.508,
    });
    expect(transport.commands).not.toContain("STATus:QUEStionable:EVENt?");
  });

  it("leaves Questionable Data events available to explicit raw SCPI", async () => {
    const transport = new ScriptedTransport();
    respond(transport, "STATus:QUEStionable:EVENt?", "1");
    const driver = scriptedDriver(transport);

    await expect(driver.executeRawScpi("STATus:QUEStionable:EVENt?")).resolves.toBe("1");
    expect(transport.commands).toEqual(["STATus:QUEStionable:EVENt?"]);
  });

  it("normalizes temperature using a unit read in the same snapshot transaction", async () => {
    const transport = new ScriptedTransport();
    respond(transport, "CONFigure?", "TEMP FRTD,385");
    respond(transport, "UNIT:TEMPerature?", "F", "F");
    scriptReadingObservations(
      transport,
      { functionToken: "TEMP", response: "2.12000000E+02 OPAQUE_TEMP" },
    );
    const driver = scriptedDriver(transport);

    await expect(driver.readDmmState()).resolves.toEqual({
      function: DmmMeasurementFunction.Temperature,
      range: null,
      acquisitionRate: null,
    });
    await expect(driver.readPrimarySnapshot(DmmMeasurementFunction.Temperature)).resolves.toEqual({
      kind: DmmReadingKind.Value,
      function: DmmMeasurementFunction.Temperature,
      value: 100,
      unit: DmmUnit.Celsius,
    });
  });

  it("runs raw SCPI through the scheduler for both queries and commands", async () => {
    const transport = new ScriptedTransport();
    respond(transport, "*OPT?", "NONE");
    const driver = scriptedDriver(transport);

    await expect(driver.executeRawScpi("*OPT?")).resolves.toBe("NONE");
    await expect(driver.executeRawScpi("*CLS")).resolves.toBe("");
    expect(transport.commands).toEqual(["*OPT?", "*CLS"]);
  });
});
