import { describe, expect, it } from "vitest";

import {
  Channel,
  ChannelUnit,
  EdgeSlope,
  MeasurementKind,
  TriggerType,
} from "../../shared/scope-types.js";
import {
  ScpiOperationKind,
  ScpiPriority,
  type ScpiOperation,
  type ScpiOperationRecorder,
  type ScpiScheduler,
} from "../scpi/scpi-scheduler.js";
import { ScpiResponseKind, type ScpiTransport } from "../scpi/scpi-transport.js";
import { Dho804Driver } from "./dho804-driver.js";

class ScriptedTransport {
  public readonly commands: string[] = [];
  public readonly text = new Map<string, string[]>();
  public readonly binary = new Map<string, Uint8Array[]>();

  public command = async (command: string): Promise<void> => { this.commands.push(command); };
  public queryText = async (command: string): Promise<string> => {
    this.commands.push(command);
    const values = this.text.get(command);
    const value = values?.shift();
    if (value === undefined) throw new Error(`No scripted text response for ${command}`);
    return value;
  };
  public queryBinary = async (command: string): Promise<Uint8Array> => {
    this.commands.push(command);
    const values = this.binary.get(command);
    const value = values?.shift();
    if (value === undefined) throw new Error(`No scripted binary response for ${command}`);
    return value;
  };
  public query = async (command: string) => ({ kind: ScpiResponseKind.Text as const, value: await this.queryText(command) });
  public isUsable = (): boolean => true;
}

function scriptedDriver(transport: ScriptedTransport): Dho804Driver {
  const recorder: ScpiOperationRecorder = { addBinaryBytes: () => {} };
  const run = <T>(operation: ScpiOperation<T>): Promise<T> => operation.execute(transport as unknown as ScpiTransport, recorder);
  const scheduler = {
    schedule: run,
    scheduleInteractive: <T>(_kind: ScpiOperationKind, _key: unknown, execute: ScpiOperation<T>["execute"]) => execute(transport as unknown as ScpiTransport, recorder),
    scheduleImmediate: <T>(_kind: ScpiOperationKind, _key: unknown, execute: ScpiOperation<T>["execute"]) => execute(transport as unknown as ScpiTransport, recorder),
    scheduleLive: <T>(_kind: ScpiOperationKind, execute: ScpiOperation<T>["execute"]) => execute(transport as unknown as ScpiTransport, recorder),
  } as unknown as ScpiScheduler;
  return new Dho804Driver(scheduler);
}

function respond(transport: ScriptedTransport, command: string, ...values: string[]): void {
  transport.text.set(command, values);
}

describe("Dho804Driver", () => {
  it("identifies only an exact DHO804", async () => {
    const transport = new ScriptedTransport();
    respond(transport, "*IDN?", "RIGOL TECHNOLOGIES,DHO804,ABC123,00.01");
    await expect(scriptedDriver(transport).identify()).resolves.toEqual({
      manufacturer: "RIGOL TECHNOLOGIES", model: "DHO804", serialNumber: "ABC123", softwareVersion: "00.01",
    });

    const wrong = new ScriptedTransport();
    respond(wrong, "*IDN?", "RIGOL TECHNOLOGIES,DHO914,ABC123,00.01");
    await expect(scriptedDriver(wrong).identify()).rejects.toThrow(/Unsupported/);
  });

  it("maps trigger tokens and only reads Edge detail for Edge", async () => {
    const transport = new ScriptedTransport();
    respond(transport, ":TRIGger:MODE?", "EDGE");
    respond(transport, ":TRIGger:SWEep?", "NORM");
    respond(transport, ":TRIGger:EDGE:SOURce?", "CHAN2");
    respond(transport, ":TRIGger:EDGE:SLOPe?", "RFAL");
    respond(transport, ":TRIGger:EDGE:LEVel?", "1.25E-1");
    respond(transport, ":TRIGger:COUPling?", "DC");
    const state = await scriptedDriver(transport).readTriggerState(ScpiPriority.Background);
    expect(state).toMatchObject({ type: TriggerType.Edge, source: Channel.Ch2, slope: EdgeSlope.Either, level: 0.125 });
  });

  it("preserves measurement order", async () => {
    const transport = new ScriptedTransport();
    respond(transport, ":MEASure:ITEM? VPP,CHANnel1", "2.5");
    respond(transport, ":MEASure:ITEM? FREQuency,CHANnel2", "1000");
    const values = await scriptedDriver(transport).readMeasurements([
      { kind: MeasurementKind.Vpp, channel: Channel.Ch1 },
      { kind: MeasurementKind.Frequency, channel: Channel.Ch2 },
    ], ScpiPriority.Background);
    expect(values.map((value) => value.value)).toEqual([2.5, 1000]);
  });

  it("converts NORMAL BYTE data using preamble Y metadata", async () => {
    const transport = new ScriptedTransport();
    transport.binary.set(":WAVeform:DATA?", [Uint8Array.from([10, 12])]);
    respond(transport, ":WAVeform:PREamble?", "0,0,2,1,1e-6,0,0,0.5,10,0");
    respond(transport, ":CHANnel1:UNITs?", "VOLT");
    const waveform = await scriptedDriver(transport).readLiveWaveform(Channel.Ch1, 2);
    expect(waveform.unit).toBe(ChannelUnit.Volts);
    expect([...waveform.samples]).toEqual([0, 1]);
  });

  it("assembles RAW WORD chunks without exposing native codes", async () => {
    const transport = new ScriptedTransport();
    transport.binary.set(":WAVeform:DATA?", [Uint8Array.from([1, 0, 2, 0, 3, 0])]);
    respond(transport, ":WAVeform:PREamble?", "1,0,3,1,1e-6,0,0,1,0,0");
    respond(transport, ":CHANnel1:UNITs?", "VOLT");
    const waveform = await scriptedDriver(transport).readRawWaveform(Channel.Ch1, 3);
    expect([...waveform.samples]).toEqual([1, 2, 3]);
    expect(transport.commands).toContain(":WAVeform:STARt 1");
    expect(transport.commands).toContain(":WAVeform:STOP 3");
  });
});
