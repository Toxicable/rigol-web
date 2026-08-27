import { describe, expect, it } from "vitest";

import {
  AcquisitionType,
  Channel,
  ChannelCoupling,
  ChannelUnit,
  EdgeSlope,
  MeasurementKind,
  ScopeRunState,
  TimebaseMode,
  TriggerCoupling,
  TriggerSweep,
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
    scheduleLatest: <T>(_priority: ScpiPriority, _key: unknown, _kind: ScpiOperationKind, execute: ScpiOperation<T>["execute"]) => execute(transport as unknown as ScpiTransport, recorder),
  } as unknown as ScpiScheduler;
  return new Dho804Driver(scheduler);
}

function respond(transport: ScriptedTransport, command: string, ...values: string[]): void {
  transport.text.set(command, values);
}

function respondChannel(
  transport: ScriptedTransport,
  channel: Channel,
  enabled: string,
  coupling: string,
  unit: string,
): void {
  const prefix = `:CHANnel${channel}`;
  respond(transport, `${prefix}:DISPlay?`, enabled);
  respond(transport, `${prefix}:COUPling?`, coupling);
  respond(transport, `${prefix}:UNITs?`, unit);
  respond(transport, `${prefix}:SCALe?`, `${channel}E-1`);
  respond(transport, `${prefix}:OFFSet?`, `-${channel}E-2`);
  respond(transport, `${prefix}:PROBe?`, "10");
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
    expect(state).toEqual({
      type: TriggerType.Edge,
      sweep: TriggerSweep.Normal,
      source: Channel.Ch2,
      slope: EdgeSlope.Either,
      level: 0.125,
      coupling: TriggerCoupling.Dc,
    });
  });

  it("maps every non-Edge DHO804 trigger token without reading Edge-only fields", async () => {
    const mappings: Array<[string, TriggerType]> = [
      ["PULS", TriggerType.Pulse],
      ["SLOP", TriggerType.Slope],
      ["VID", TriggerType.Video],
      ["PATT", TriggerType.Pattern],
      ["DUR", TriggerType.Duration],
      ["TIM", TriggerType.Timeout],
      ["RUNT", TriggerType.Runt],
      ["WIND", TriggerType.Window],
      ["DEL", TriggerType.Delay],
      ["SET", TriggerType.SetupHold],
      ["NEDG", TriggerType.NthEdge],
      ["RS232", TriggerType.Rs232],
      ["IIC", TriggerType.I2c],
      ["SPI", TriggerType.Spi],
      ["CAN", TriggerType.Can],
    ];

    for (const [token, expectedType] of mappings) {
      const transport = new ScriptedTransport();
      respond(transport, ":TRIGger:MODE?", token);
      respond(transport, ":TRIGger:SWEep?", "AUTO");
      await expect(scriptedDriver(transport).readTriggerState(ScpiPriority.Background)).resolves.toEqual({
        type: expectedType,
        sweep: TriggerSweep.Auto,
      });
      expect(transport.commands).toEqual([":TRIGger:MODE?", ":TRIGger:SWEep?"]);
    }
  });

  it("builds a complete scope snapshot from focused state reads", async () => {
    const transport = new ScriptedTransport();
    respondChannel(transport, Channel.Ch1, "1", "DC", "VOLT");
    respondChannel(transport, Channel.Ch2, "0", "AC", "AMP");
    respondChannel(transport, Channel.Ch3, "1", "GND", "WATT");
    respondChannel(transport, Channel.Ch4, "0", "DC", "UNKN");
    respond(transport, ":TIMebase:XY:ENABle?", "0");
    respond(transport, ":TIMebase:MODE?", "ROLL");
    respond(transport, ":TIMebase:MAIN:SCALe?", "1E-3");
    respond(transport, ":TIMebase:MAIN:OFFSet?", "2E-4");
    respond(transport, ":ACQuire:TYPE?", "AVER");
    respond(transport, ":ACQuire:AVERages?", "16");
    respond(transport, ":ACQuire:MDEPth?", "5.0000E+06");
    respond(transport, ":ACQuire:SRATe?", "6.25E+08");
    respond(transport, ":TRIGger:STATus?", "WAIT");
    respond(transport, ":TRIGger:MODE?", "PULS");
    respond(transport, ":TRIGger:SWEep?", "SING");

    const state = await scriptedDriver(transport).readScopeState(ScpiPriority.Background);
    expect(state.channels[0]).toEqual({
      channel: Channel.Ch1,
      enabled: true,
      coupling: ChannelCoupling.Dc,
      unit: ChannelUnit.Volts,
      scale: 0.1,
      offset: -0.01,
      probeRatio: 10,
    });
    expect(state.channels[1].unit).toBe(ChannelUnit.Amps);
    expect(state.channels[2].unit).toBe(ChannelUnit.Watts);
    expect(state.channels[3].unit).toBe(ChannelUnit.Unknown);
    expect(state.horizontal).toEqual({ mode: TimebaseMode.Roll, scale: 0.001, position: 0.0002 });
    expect(state.acquisition).toEqual({
      type: AcquisitionType.Average,
      averages: 16,
      memoryDepth: 5_000_000,
      sampleRate: 625_000_000,
    });
    expect(state.runState).toBe(ScopeRunState.Waiting);
    expect(state.trigger).toEqual({ type: TriggerType.Pulse, sweep: TriggerSweep.Single });
  });

  it("derives XY mode independently of the base timebase token", async () => {
    const transport = new ScriptedTransport();
    respond(transport, ":TIMebase:XY:ENABle?", "1");
    respond(transport, ":TIMebase:MODE?", "MAIN");
    respond(transport, ":TIMebase:MAIN:SCALe?", "1E-6");
    respond(transport, ":TIMebase:MAIN:OFFSet?", "0");
    await expect(scriptedDriver(transport).readHorizontalState(ScpiPriority.Background)).resolves.toEqual({
      mode: TimebaseMode.Xy,
      scale: 0.000001,
      position: 0,
    });
  });

  it("exposes trigger setters with the Server Control contract names", async () => {
    const transport = new ScriptedTransport();
    const driver = scriptedDriver(transport);
    await driver.setTriggerType(TriggerType.Edge, ScpiPriority.Normal);
    await driver.setTriggerSource(Channel.Ch3, ScpiPriority.Normal);
    await driver.setTriggerSlope(EdgeSlope.Falling, ScpiPriority.Normal);
    await driver.setTriggerLevel(0.25, ScpiPriority.Interactive);
    expect(transport.commands).toEqual([
      ":TRIGger:MODE EDGE",
      ":TRIGger:EDGE:SOURce CHANnel3",
      ":TRIGger:EDGE:SLOPe NEGative",
      ":TRIGger:EDGE:LEVel 0.25",
    ]);
  });

  it("treats question marks inside quoted raw SCPI arguments as setters", async () => {
    const transport = new ScriptedTransport();
    const driver = scriptedDriver(transport);
    await expect(driver.executeRawScpi(':DISPlay:TEXT "why?"')).resolves.toBe("");
    await expect(driver.executeRawScpi(":DISPlay:TEXT 'still?'" )).resolves.toBe("");
    expect(transport.commands).toEqual([
      ':DISPlay:TEXT "why?"',
      ":DISPlay:TEXT 'still?'",
    ]);
  });

  it("still detects an unquoted raw SCPI query marker", async () => {
    const transport = new ScriptedTransport();
    respond(transport, ":SYSTem:ERRor?", "0,No error");
    await expect(scriptedDriver(transport).executeRawScpi(":SYSTem:ERRor?")).resolves.toBe("0,No error");
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