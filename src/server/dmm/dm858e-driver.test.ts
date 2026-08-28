import { describe, expect, it } from "vitest";

import {
  DmmAcquisitionRate,
  DmmMeasurementFunction,
  DmmRangeMode,
  DmmReadingKind,
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
  points: number;
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
    "DATA:POINts?",
    ...observations.map((observation) => String(observation.points)),
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

  it("preserves the last meaningful rate for functions without programmable speed", async () => {
    const transport = new ScriptedTransport();
    respond(transport, "CONFigure?", "CONT");

    await expect(
      scriptedDriver(transport).readDmmState(DmmAcquisitionRate.Fast),
    ).resolves.toEqual({
      function: DmmMeasurementFunction.Continuity,
      range: { mode: DmmRangeMode.Auto },
      acquisitionRate: DmmAcquisitionRate.Fast,
    });
  });

  it("sets exact function and DM858E range commands", async () => {
    const transport = new ScriptedTransport();
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
      "SENSe:CURRent:DC:RANGe 3",
      "SENSe:CAPacitance:RANGe:AUTO ON",
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

  it("distinguishes adjacent low capacitance ranges", async () => {
    const transport = new ScriptedTransport();
    const driver = scriptedDriver(transport);

    await expect(driver.setRange(DmmMeasurementFunction.Capacitance, {
      mode: DmmRangeMode.Fixed,
      value: 2e-9,
    })).rejects.toThrow(/Unsupported capacitance range/);
    expect(transport.commands).toEqual([]);
  });

  it("maps Slow Medium Fast to the documented NPLC values", async () => {
    const transport = new ScriptedTransport();
    const driver = scriptedDriver(transport);
    const range = { mode: DmmRangeMode.Fixed as const, value: 10 };

    await driver.setAcquisitionRate(DmmMeasurementFunction.DcVoltage, range, DmmAcquisitionRate.Slow);
    await driver.setAcquisitionRate(DmmMeasurementFunction.DcVoltage, range, DmmAcquisitionRate.Medium);
    await driver.setAcquisitionRate(DmmMeasurementFunction.DcVoltage, range, DmmAcquisitionRate.Fast);

    expect(transport.commands).toEqual([
      "SENSe:VOLTage:DC:NPLC 20",
      "SENSe:VOLTage:DC:NPLC 5",
      "SENSe:VOLTage:DC:NPLC 0.4",
    ]);
  });

  it("sets AC speed through one scheduler operation and preserves auto range", async () => {
    const transport = new ScriptedTransport();
    respond(transport, "SENSe:VOLTage:AC:RANGe?", "1.00000000E+01");
    const driver = scriptedDriver(transport);

    await driver.setAcquisitionRate(
      DmmMeasurementFunction.AcVoltage,
      { mode: DmmRangeMode.Auto },
      DmmAcquisitionRate.Fast,
    );

    expect(transport.commands).toEqual([
      "SENSe:VOLTage:AC:RANGe?",
      "CONFigure:VOLTage:AC AUTO,0.01",
    ]);
  });

  it("publishes only when reading-memory or response evidence proves a fresh reading", async () => {
    const transport = new ScriptedTransport();
    scriptReadingObservations(
      transport,
      { functionToken: "VOLT", points: 0, response: "-5.07000000E-01 VDC" },
      { functionToken: "VOLT", points: 1, response: "-5.07000000E-01 VDC" },
      { functionToken: "VOLT", points: 1, response: "-5.07000000E-01 VDC" },
    );
    const driver = scriptedDriver(transport);

    await expect(driver.readPrimaryReading(DmmMeasurementFunction.DcVoltage, 4)).resolves.toBeNull();
    await expect(driver.readPrimaryReading(DmmMeasurementFunction.DcVoltage, 4)).resolves.toEqual({
      kind: DmmReadingKind.Value,
      sequence: 4,
      value: -0.507,
      unit: DmmUnit.Volts,
    });
    await expect(driver.readPrimaryReading(DmmMeasurementFunction.DcVoltage, 5)).resolves.toBeNull();
  });

  it("suppresses a DATA:LAST reading when the authoritative function changed", async () => {
    const transport = new ScriptedTransport();
    scriptReadingObservations(
      transport,
      { functionToken: "VOLT", points: 0, response: "-5.07000000E-01 VDC" },
      { functionToken: "RES", points: 1, response: "1.00000000E+03 OPAQUE_RES" },
      { functionToken: "RES", points: 2, response: "1.00000000E+03 OPAQUE_RES" },
    );
    const driver = scriptedDriver(transport);

    await expect(driver.readPrimaryReading(DmmMeasurementFunction.DcVoltage, 0)).resolves.toBeNull();
    await expect(driver.readPrimaryReading(DmmMeasurementFunction.DcVoltage, 0)).resolves.toBeNull();
    await expect(driver.readPrimaryReading(DmmMeasurementFunction.Resistance2Wire, 0)).resolves.toEqual({
      kind: DmmReadingKind.Value,
      sequence: 0,
      value: 1_000,
      unit: DmmUnit.Ohms,
    });
  });

  it("keeps overload UNKNOWN instead of consuming a latched Questionable Data event", async () => {
    const transport = new ScriptedTransport();
    scriptReadingObservations(
      transport,
      { functionToken: "VOLT", points: 0, response: "-5.07000000E-01 VDC" },
      { functionToken: "VOLT", points: 1, response: "9.90000000E+37 VDC" },
    );
    const driver = scriptedDriver(transport);

    await expect(driver.readPrimaryReading(DmmMeasurementFunction.DcVoltage, 0)).resolves.toBeNull();
    await expect(driver.readPrimaryReading(DmmMeasurementFunction.DcVoltage, 0)).resolves.toBeNull();
    expect(transport.commands).not.toContain("STATus:QUEStionable:EVENt?");
  });

  it("treats only the documented bare DATA:LAST no-data sentinel as no data", async () => {
    const transport = new ScriptedTransport();
    scriptReadingObservations(
      transport,
      { functionToken: "VOLT", points: 0, response: "-5.07000000E-01 VDC" },
      { functionToken: "VOLT", points: 1, response: "9.90000000E+37" },
    );
    const driver = scriptedDriver(transport);

    await expect(driver.readPrimaryReading(DmmMeasurementFunction.DcVoltage, 0)).resolves.toBeNull();
    await expect(driver.readPrimaryReading(DmmMeasurementFunction.DcVoltage, 0)).resolves.toBeNull();
  });

  it("leaves Questionable Data events available to explicit raw SCPI", async () => {
    const transport = new ScriptedTransport();
    respond(transport, "STATus:QUEStionable:EVENt?", "1");
    const driver = scriptedDriver(transport);

    await expect(driver.executeRawScpi("STATus:QUEStionable:EVENt?")).resolves.toBe("1");
    expect(transport.commands).toEqual(["STATus:QUEStionable:EVENt?"]);
  });

  it("normalizes temperature using a unit read in the same measurement transaction", async () => {
    const transport = new ScriptedTransport();
    respond(transport, "CONFigure?", "TEMP FRTD,385");
    respond(transport, "UNIT:TEMPerature?", "F", "F", "F");
    scriptReadingObservations(
      transport,
      { functionToken: "TEMP", points: 0, response: "2.12000000E+02 OPAQUE_TEMP" },
      { functionToken: "TEMP", points: 1, response: "2.12000000E+02 OPAQUE_TEMP" },
    );
    const driver = scriptedDriver(transport);

    await expect(driver.readDmmState()).resolves.toEqual({
      function: DmmMeasurementFunction.Temperature,
      range: { mode: DmmRangeMode.Auto },
      acquisitionRate: DmmAcquisitionRate.Slow,
    });
    await expect(driver.readPrimaryReading(DmmMeasurementFunction.Temperature, 8)).resolves.toBeNull();
    await expect(driver.readPrimaryReading(DmmMeasurementFunction.Temperature, 8)).resolves.toEqual({
      kind: DmmReadingKind.Value,
      sequence: 8,
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
