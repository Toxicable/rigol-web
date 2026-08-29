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
  configuration?: string;
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
  transport.text.set(command, [...(transport.text.get(command) ?? []), ...values]);
}

function defaultConfiguration(functionToken: string): string {
  switch (functionToken.trim().replace(/^"|"$/g, "").toUpperCase()) {
    case "VOLT":
    case "VOLT:DC":
      return "VOLT 1.00000000E+00,1.00000000E-05";
    case "VOLT:AC":
      return "VOLT:AC 1.00000000E+00,1.00000000E-05";
    case "CURR":
    case "CURR:DC":
      return "CURR 1.00000000E+00,1.00000000E-05";
    case "CURR:AC":
      return "CURR:AC 1.00000000E+00,1.00000000E-05";
    case "RES":
      return "RES 1.00000000E+03,1.00000000E-02";
    case "FRES":
      return "FRES 1.00000000E+03,1.00000000E-02";
    case "FREQ":
      return "FREQ 1.00000000E+01,1.00000000E-01";
    case "PER":
      return "PER 1.00000000E+00,1.00000000E-05";
    case "CAP":
      return "CAP 1.00000000E-06,1.00000000E-09";
    case "TEMP":
      return "TEMP FRTD,385";
    case "CONT":
      return "CONT";
    case "DIOD":
      return "DIOD";
    default:
      throw new Error(`Missing default configuration for ${functionToken}`);
  }
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
    "CONFigure?",
    ...observations.flatMap((observation) => {
      const value = observation.configuration ?? defaultConfiguration(observation.functionToken);
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
    respond(transport, "SENSe:FUNCtion?", "VOLT:AC", "VOLT:AC");
    respond(transport, "SENSe:VOLTage:AC:RANGe:AUTO?", "1", "1");
    respond(
      transport,
      "SENSe:VOLTage:AC:RANGe?",
      "1.00000000E+01",
      "1.00000000E+01",
    );
    const driver = scriptedDriver(transport);

    await driver.setAcquisitionRate(
      DmmMeasurementFunction.AcVoltage,
      DmmAcquisitionRate.Fast,
    );

    expect(transport.commands).toEqual([
      "SENSe:FUNCtion?",
      "SENSe:VOLTage:AC:RANGe:AUTO?",
      "SENSe:VOLTage:AC:RANGe?",
      "SENSe:VOLTage:AC:RANGe:AUTO?",
      "SENSe:VOLTage:AC:RANGe?",
      "SENSe:FUNCtion?",
      "CONFigure:VOLTage:AC AUTO,0.01",
    ]);
  });

  it("preserves the current physical fixed AC range while changing only rate", async () => {
    const transport = new ScriptedTransport();
    respond(transport, "SENSe:FUNCtion?", "VOLT:AC", "VOLT:AC");
    respond(transport, "SENSe:VOLTage:AC:RANGe:AUTO?", "0", "0");
    respond(
      transport,
      "SENSe:VOLTage:AC:RANGe?",
      "1.00000000E+02",
      "1.00000000E+02",
    );
    const driver = scriptedDriver(transport);

    await driver.setAcquisitionRate(
      DmmMeasurementFunction.AcVoltage,
      DmmAcquisitionRate.Fast,
    );

    expect(transport.commands).toEqual([
      "SENSe:FUNCtion?",
      "SENSe:VOLTage:AC:RANGe:AUTO?",
      "SENSe:VOLTage:AC:RANGe?",
      "SENSe:VOLTage:AC:RANGe:AUTO?",
      "SENSe:VOLTage:AC:RANGe?",
      "SENSe:FUNCtion?",
      "CONFigure:VOLTage:AC 100,0.1",
    ]);
  });

  it("retries when AC range mode changes between mode and value observations", async () => {
    const transport = new ScriptedTransport();
    respond(transport, "SENSe:FUNCtion?", "VOLT:AC", "VOLT:AC");
    respond(transport, "SENSe:VOLTage:AC:RANGe:AUTO?", "1", "0", "0");
    respond(
      transport,
      "SENSe:VOLTage:AC:RANGe?",
      "1.00000000E+02",
      "1.00000000E+02",
      "1.00000000E+02",
    );
    const driver = scriptedDriver(transport);

    await driver.setAcquisitionRate(
      DmmMeasurementFunction.AcVoltage,
      DmmAcquisitionRate.Fast,
    );

    expect(transport.commands).toEqual([
      "SENSe:FUNCtion?",
      "SENSe:VOLTage:AC:RANGe:AUTO?",
      "SENSe:VOLTage:AC:RANGe?",
      "SENSe:VOLTage:AC:RANGe:AUTO?",
      "SENSe:VOLTage:AC:RANGe?",
      "SENSe:VOLTage:AC:RANGe:AUTO?",
      "SENSe:VOLTage:AC:RANGe?",
      "SENSe:FUNCtion?",
      "CONFigure:VOLTage:AC 100,0.1",
    ]);
    expect(transport.commands).not.toContain("CONFigure:VOLTage:AC AUTO,0.1");
  });

  it("rejects an AC rate write when the physical range never stabilizes", async () => {
    const transport = new ScriptedTransport();
    respond(transport, "SENSe:FUNCtion?", "VOLT:AC");
    respond(transport, "SENSe:VOLTage:AC:RANGe:AUTO?", "1", "0", "1");
    respond(
      transport,
      "SENSe:VOLTage:AC:RANGe?",
      "1.00000000E+01",
      "1.00000000E+02",
      "1.00000000E+01",
    );
    const driver = scriptedDriver(transport);

    await expect(driver.setAcquisitionRate(
      DmmMeasurementFunction.AcVoltage,
      DmmAcquisitionRate.Fast,
    )).rejects.toThrow(/Unstable AC voltage range/);
    expect(transport.commands.some((command) => (
      command.startsWith("CONFigure:VOLTage:AC ")
    ))).toBe(false);
  });

  it("rejects an AC function change while resolving the physical range", async () => {
    const transport = new ScriptedTransport();
    respond(transport, "SENSe:FUNCtion?", "VOLT:AC", "RES");
    respond(transport, "SENSe:VOLTage:AC:RANGe:AUTO?", "0", "0");
    respond(
      transport,
      "SENSe:VOLTage:AC:RANGe?",
      "1.00000000E+02",
      "1.00000000E+02",
    );
    const driver = scriptedDriver(transport);

    await expect(driver.setAcquisitionRate(
      DmmMeasurementFunction.AcVoltage,
      DmmAcquisitionRate.Fast,
    )).rejects.toThrow(/Stale DMM control/);
    expect(transport.commands).toEqual([
      "SENSe:FUNCtion?",
      "SENSe:VOLTage:AC:RANGe:AUTO?",
      "SENSe:VOLTage:AC:RANGe?",
      "SENSe:VOLTage:AC:RANGe:AUTO?",
      "SENSe:VOLTage:AC:RANGe?",
      "SENSe:FUNCtion?",
    ]);
    expect(transport.commands.some((command) => (
      command.startsWith("CONFigure:VOLTage:AC ")
    ))).toBe(false);
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

  it("publishes the first stable DATA:LAST value with its configured resolution", async () => {
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
      resolution: 1e-5,
      unit: DmmUnit.Volts,
    });
    expect(transport.commands).not.toContain("DATA:POINts?");
  });

  it("carries the actual 100 V Fast AC resolution with the reading", async () => {
    const transport = new ScriptedTransport();
    scriptReadingObservations(
      transport,
      {
        functionToken: "VOLT:AC",
        response: "1.23456780E+01 OPAQUE_ACV",
        configuration: "VOLT:AC 1.00000000E+02,1.00000000E-01",
      },
    );
    const driver = scriptedDriver(transport);

    await expect(driver.readPrimarySnapshot(DmmMeasurementFunction.AcVoltage)).resolves.toEqual({
      kind: DmmReadingKind.Value,
      function: DmmMeasurementFunction.AcVoltage,
      value: 12.345678,
      resolution: 0.1,
      unit: DmmUnit.Volts,
    });
  });

  it("rejects a reading when configured range/resolution changes across DATA:LAST", async () => {
    const transport = new ScriptedTransport();
    respond(transport, "STATus:OPERation:CONDition?", "0", "0");
    respond(
      transport,
      "CONFigure?",
      "VOLT:AC 1.00000000E+01,1.00000000E-02",
      "VOLT:AC 1.00000000E+02,1.00000000E-01",
    );
    respond(transport, "SENSe:FUNCtion?", "VOLT:AC", "VOLT:AC");
    respond(transport, "DATA:LAST?", "1.23456780E+01 OPAQUE_ACV");

    await expect(
      scriptedDriver(transport).readPrimarySnapshot(DmmMeasurementFunction.AcVoltage),
    ).resolves.toBeNull();
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
      resolution: 1e-5,
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
      resolution: 0.01,
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

    await expect(driver.readPrimarySnapshot(DmmMeasurementFunction.DcVoltage)).resolves.toEqual({
      kind: DmmReadingKind.Unavailable,
      function: DmmMeasurementFunction.DcVoltage,
      unit: DmmUnit.Volts,
      reason: DmmReadingUnavailableReason.ConfigurationChanged,
    });
    await expect(driver.readPrimarySnapshot(DmmMeasurementFunction.DcVoltage)).resolves.toEqual({
      kind: DmmReadingKind.Value,
      function: DmmMeasurementFunction.DcVoltage,
      value: -0.508,
      resolution: 1e-5,
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
      resolution: 1e-5,
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

  it("does not publish a numeric temperature reading without an authoritative resolution", async () => {
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
      kind: DmmReadingKind.Unavailable,
      function: DmmMeasurementFunction.Temperature,
      unit: DmmUnit.Celsius,
      reason: DmmReadingUnavailableReason.ResolutionUnavailable,
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
