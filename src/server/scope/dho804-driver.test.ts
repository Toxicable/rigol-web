import { describe, expect, it } from "vitest";

import {
  AcquisitionType,
  Channel,
  ChannelBandwidthLimit,
  ChannelCoupling,
  ChannelUnit,
  EdgeSlope,
  MathChannel,
  MathOperator,
  MathSource,
  MeasurementKind,
  ScopeRunState,
  TimebaseMode,
  TriggerCoupling,
  TriggerSweep,
  TriggerType,
  WaveformSource,
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
  bandwidthLimit = "OFF",
): void {
  const prefix = `:CHANnel${channel}`;
  respond(transport, `${prefix}:DISPlay?`, enabled);
  respond(transport, `${prefix}:COUPling?`, coupling);
  respond(transport, `${prefix}:BWLimit?`, bandwidthLimit);
  respond(transport, `${prefix}:UNITs?`, unit);
  respond(transport, `${prefix}:SCALe?`, `${channel}E-1`);
  respond(transport, `${prefix}:OFFSet?`, `-${channel}E-2`);
  respond(transport, `${prefix}:PROBe?`, "10");
}

function respondArithmeticMath(
  transport: ScriptedTransport,
  math: MathChannel,
  enabled: string,
  operator: string,
  source1: string,
  source2: string,
  scale: string,
  offset: string,
): void {
  const prefix = `:MATH${math}`;
  respond(transport, `${prefix}:DISPlay?`, enabled);
  respond(transport, `${prefix}:OPERator?`, operator);
  respond(transport, `${prefix}:SOURce1?`, source1);
  respond(transport, `${prefix}:SOURce2?`, source2);
  respond(transport, `${prefix}:SCALe?`, scale);
  respond(transport, `${prefix}:OFFSet?`, offset);
}

function respondHorizontal(
  transport: ScriptedTransport,
  scale: string,
  position: string,
  mode = "MAIN",
): void {
  respond(transport, ":TIMebase:XY:ENABle?", "0");
  respond(transport, ":TIMebase:MODE?", mode);
  respond(transport, ":TIMebase:MAIN:SCALe?", scale);
  respond(transport, ":TIMebase:MAIN:OFFSet?", position);
}

function waveformSourceToken(source: WaveformSource): string {
  return source <= WaveformSource.Ch4 ? `CHANnel${source}` : `MATH${source - 4}`;
}

function respondMeasurementStatistics(
  transport: ScriptedTransport,
  item: string,
  source: WaveformSource,
  values: readonly [string, string, string, string, string, string],
): void {
  const token = waveformSourceToken(source);
  const [current, minimum, maximum, average, deviation, count] = values;
  respond(transport, `:MEASure:STATistic:ITEM? CURRent,${item},${token}`, current);
  respond(transport, `:MEASure:STATistic:ITEM? MINimum,${item},${token}`, minimum);
  respond(transport, `:MEASure:STATistic:ITEM? MAXimum,${item},${token}`, maximum);
  respond(transport, `:MEASure:STATistic:ITEM? AVERages,${item},${token}`, average);
  respond(transport, `:MEASure:STATistic:ITEM? DEViation,${item},${token}`, deviation);
  respond(transport, `:MEASure:STATistic:ITEM? CNT,${item},${token}`, count);
}

function liveCommand(source: WaveformSource): string {
  return `:WAVeform:SOURce ${waveformSourceToken(source)};:WAVeform:DATA?`;
}

async function readOneLive(
  driver: Dho804Driver,
  source: WaveformSource,
  pointCount: number,
) {
  return driver.readLiveWaveform(source, pointCount);
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
      ["PULS", TriggerType.Pulse], ["SLOP", TriggerType.Slope], ["VID", TriggerType.Video],
      ["PATT", TriggerType.Pattern], ["DUR", TriggerType.Duration], ["TIM", TriggerType.Timeout],
      ["RUNT", TriggerType.Runt], ["WIND", TriggerType.Window], ["DEL", TriggerType.Delay],
      ["SET", TriggerType.SetupHold], ["NEDG", TriggerType.NthEdge], ["RS232", TriggerType.Rs232],
      ["IIC", TriggerType.I2c], ["SPI", TriggerType.Spi], ["CAN", TriggerType.Can],
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

  it("reads arithmetic, FFT, logic and unary math state without fabricating fields", async () => {
    const transport = new ScriptedTransport();
    respondArithmeticMath(transport, MathChannel.Math1, "1", "ADD", "CHAN1", "CHAN2", "0.5", "0.1");

    respond(transport, ":MATH2:DISPlay?", "1");
    respond(transport, ":MATH2:OPERator?", "FFT");
    respond(transport, ":MATH2:FFT:SOURce?", "MATH1");
    respond(transport, ":MATH2:FFT:SCALe?", "20");
    respond(transport, ":MATH2:FFT:OFFSet?", "-40");

    respond(transport, ":MATH3:DISPlay?", "0");
    respond(transport, ":MATH3:OPERator?", "AND");
    respond(transport, ":MATH3:LSOurce1?", "CHAN3");
    respond(transport, ":MATH3:LSOurce2?", "REF2");

    respond(transport, ":MATH4:DISPlay?", "1");
    respond(transport, ":MATH4:OPERator?", "ABS");
    respond(transport, ":MATH4:SOURce1?", "REF10");
    respond(transport, ":MATH4:SCALe?", "2");
    respond(transport, ":MATH4:OFFSet?", "-1");

    const driver = scriptedDriver(transport);
    await expect(driver.readMathState(MathChannel.Math1, ScpiPriority.Background)).resolves.toEqual({
      math: MathChannel.Math1,
      enabled: true,
      operator: MathOperator.Add,
      source1: MathSource.Ch1,
      source2: MathSource.Ch2,
      scale: 0.5,
      offset: 0.1,
    });
    await expect(driver.readMathState(MathChannel.Math2, ScpiPriority.Background)).resolves.toEqual({
      math: MathChannel.Math2,
      enabled: true,
      operator: MathOperator.Fft,
      source1: MathSource.Math1,
      source2: null,
      scale: 20,
      offset: -40,
    });
    await expect(driver.readMathState(MathChannel.Math3, ScpiPriority.Background)).resolves.toEqual({
      math: MathChannel.Math3,
      enabled: false,
      operator: MathOperator.And,
      source1: MathSource.Ch3,
      source2: MathSource.Ref2,
      scale: null,
      offset: null,
    });
    await expect(driver.readMathState(MathChannel.Math4, ScpiPriority.Background)).resolves.toEqual({
      math: MathChannel.Math4,
      enabled: true,
      operator: MathOperator.Abs,
      source1: MathSource.Ref10,
      source2: null,
      scale: 2,
      offset: -1,
    });
  });

  it("builds a complete scope snapshot including all four math channels", async () => {
    const transport = new ScriptedTransport();
    respondChannel(transport, Channel.Ch1, "1", "DC", "VOLT", "20M");
    respondChannel(transport, Channel.Ch2, "0", "AC", "AMP");
    respondChannel(transport, Channel.Ch3, "1", "GND", "WATT");
    respondChannel(transport, Channel.Ch4, "0", "DC", "UNKN");
    respondArithmeticMath(transport, MathChannel.Math1, "1", "ADD", "CHAN1", "CHAN2", "0.5", "0");
    respondArithmeticMath(transport, MathChannel.Math2, "0", "SUBT", "MATH1", "CHAN3", "1", "0.1");
    respondArithmeticMath(transport, MathChannel.Math3, "0", "MULT", "CHAN1", "CHAN2", "2", "-0.2");
    respondArithmeticMath(transport, MathChannel.Math4, "0", "DIV", "CHAN3", "REF1", "4", "0.3");
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
      bandwidthLimit: ChannelBandwidthLimit.Mhz20,
      unit: ChannelUnit.Volts,
      scale: 0.1,
      offset: -0.01,
      probeRatio: 10,
    });
    expect(state.channels[1].unit).toBe(ChannelUnit.Amps);
    expect(state.channels[2].unit).toBe(ChannelUnit.Watts);
    expect(state.channels[3].unit).toBe(ChannelUnit.Unknown);
    expect(state.math[0]).toMatchObject({
      math: MathChannel.Math1,
      enabled: true,
      operator: MathOperator.Add,
      source1: MathSource.Ch1,
      source2: MathSource.Ch2,
      scale: 0.5,
      offset: 0,
    });
    expect(state.math[1].source1).toBe(MathSource.Math1);
    expect(state.math[3].source2).toBe(MathSource.Ref1);
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

  it("exposes trigger and arithmetic math setters with typed contract names", async () => {
    const transport = new ScriptedTransport();
    const driver = scriptedDriver(transport);
    await driver.setTriggerType(TriggerType.Edge, ScpiPriority.Normal);
    await driver.setTriggerSource(Channel.Ch3, ScpiPriority.Normal);
    await driver.setTriggerSlope(EdgeSlope.Falling, ScpiPriority.Normal);
    await driver.setTriggerLevel(0.25, ScpiPriority.Interactive);
    await driver.setMathEnabled(MathChannel.Math1, true, ScpiPriority.Normal);
    await driver.setMathOperator(MathChannel.Math1, MathOperator.Subtract, ScpiPriority.Normal);
    await driver.setMathSource1(MathChannel.Math1, MathSource.Ch3, ScpiPriority.Normal);
    await driver.setMathSource2(MathChannel.Math1, MathSource.Ch4, ScpiPriority.Normal);
    await driver.setMathScale(MathChannel.Math1, 0.2, ScpiPriority.Normal);
    await driver.setMathOffset(MathChannel.Math1, -0.1, ScpiPriority.Normal);
    expect(transport.commands).toEqual([
      ":TRIGger:MODE EDGE",
      ":TRIGger:EDGE:SOURce CHANnel3",
      ":TRIGger:EDGE:SLOPe NEGative",
      ":TRIGger:EDGE:LEVel 0.25",
      ":MATH1:DISPlay ON",
      ":MATH1:OPERator SUBTract",
      ":MATH1:SOURce1 CHANnel3",
      ":MATH1:SOURce2 CHANnel4",
      ":MATH1:SCALe 0.2",
      ":MATH1:OFFSet -0.1",
    ]);
  });

  it("treats question marks inside quoted raw SCPI arguments as setters", async () => {
    const transport = new ScriptedTransport();
    const driver = scriptedDriver(transport);
    await expect(driver.executeRawScpi(':DISPlay:TEXT "why?"')).resolves.toBe("");
    await expect(driver.executeRawScpi(":DISPlay:TEXT 'still?'" )).resolves.toBe("");
    expect(transport.commands).toEqual([':DISPlay:TEXT "why?"', ":DISPlay:TEXT 'still?'"]);
  });

  it("still detects an unquoted raw SCPI query marker", async () => {
    const transport = new ScriptedTransport();
    respond(transport, ":SYSTem:ERRor?", "0,No error");
    await expect(scriptedDriver(transport).executeRawScpi(":SYSTem:ERRor?")).resolves.toBe("0,No error");
  });

  it("preserves measurement order across physical and math sources", async () => {
    const transport = new ScriptedTransport();
    respondMeasurementStatistics(
      transport,
      "VPP",
      WaveformSource.Ch1,
      ["2.5", "2.4", "2.6", "2.51", "0.02", "17"],
    );
    respondMeasurementStatistics(
      transport,
      "FREQuency",
      WaveformSource.Math1,
      ["1000", "995", "1005", "1000.5", "2.2", "17"],
    );
    const values = await scriptedDriver(transport).readMeasurements([
      { kind: MeasurementKind.Vpp, channel: WaveformSource.Ch1 },
      { kind: MeasurementKind.Frequency, channel: WaveformSource.Math1 },
    ], ScpiPriority.Background);
    expect(values[0]).toMatchObject({
      kind: MeasurementKind.Vpp,
      channel: WaveformSource.Ch1,
      statistics: { current: 2.5, minimum: 2.4, maximum: 2.6, average: 2.51, deviation: 0.02, count: 17 },
    });
    expect(values[1]).toMatchObject({
      kind: MeasurementKind.Frequency,
      channel: WaveformSource.Math1,
      statistics: { current: 1000, minimum: 995, maximum: 1005, average: 1000.5, deviation: 2.2, count: 17 },
    });
  });

  it("configures scope-native statistics for selected physical and math measurements", async () => {
    const transport = new ScriptedTransport();
    await scriptedDriver(transport).setMeasurements([
      { kind: MeasurementKind.Vpp, channel: WaveformSource.Ch1 },
      { kind: MeasurementKind.Vrms, channel: WaveformSource.Math2 },
    ], ScpiPriority.Normal);
    expect(transport.commands).toEqual([
      ":MEASure:CLEar",
      ":MEASure:STATistic:RESet",
      ":MEASure:ITEM VPP,CHANnel1",
      ":MEASure:STATistic:ITEM VPP,CHANnel1",
      ":MEASure:ITEM VRMS,MATH2",
      ":MEASure:STATistic:ITEM VRMS,MATH2",
    ]);
  });

  it("combines live source selection and DATA? for physical channels", async () => {
    const transport = new ScriptedTransport();
    respondChannel(transport, Channel.Ch1, "1", "DC", "VOLT");
    const driver = scriptedDriver(transport);
    await driver.readChannelState(Channel.Ch1, ScpiPriority.Normal);
    respond(transport, ":WAVeform:PREamble?", "0,0,2,1,1e-6,0,0,0.5,10,0");
    const command = liveCommand(WaveformSource.Ch1);
    transport.binary.set(command, [Uint8Array.from([10, 12])]);

    const waveform = await driver.readLiveWaveform(WaveformSource.Ch1, 2);

    expect(waveform.source).toBe(WaveformSource.Ch1);
    expect([...waveform.samples]).toEqual([0, 1]);
    expect(transport.commands.filter((entry) => entry === command)).toHaveLength(1);
  });

  it("reads native MATH waveforms through the same NORMAL data path", async () => {
    const transport = new ScriptedTransport();
    const driver = scriptedDriver(transport);
    respond(transport, ":WAVeform:PREamble?", "0,0,2,1,1e-6,0,0,0.25,10,0");
    const command = liveCommand(WaveformSource.Math1);
    transport.binary.set(command, [Uint8Array.from([10, 14])]);

    const waveform = await driver.readLiveWaveform(WaveformSource.Math1, 2);

    expect(waveform.source).toBe(WaveformSource.Math1);
    expect(waveform.unit).toBe(ChannelUnit.Unknown);
    expect([...waveform.samples]).toEqual([0, 1]);
    expect(transport.commands).toContain(":WAVeform:SOURce MATH1");
    expect(transport.commands).toContain(command);
  });

  it("reuses cached live unit and preamble metadata", async () => {
    const transport = new ScriptedTransport();
    respondChannel(transport, Channel.Ch1, "1", "DC", "VOLT");
    const driver = scriptedDriver(transport);
    await driver.readChannelState(Channel.Ch1, ScpiPriority.Normal);

    const command = liveCommand(WaveformSource.Ch1);
    transport.binary.set(command, [Uint8Array.from([10, 12]), Uint8Array.from([10, 14])]);
    respond(transport, ":WAVeform:PREamble?", "0,0,2,1,1e-6,0,0,0.5,10,0");

    const first = await readOneLive(driver, WaveformSource.Ch1, 2);
    const second = await readOneLive(driver, WaveformSource.Ch1, 2);

    expect(first.unit).toBe(ChannelUnit.Volts);
    expect([...first.samples]).toEqual([0, 1]);
    expect([...second.samples]).toEqual([0, 2]);
    expect(transport.commands.filter((entry) => entry === ":WAVeform:PREamble?")).toHaveLength(1);
    expect(transport.commands.filter((entry) => entry === ":CHANnel1:UNITs?")).toHaveLength(1);
  });

  it("updates cached vertical scale metadata without another preamble query", async () => {
    const transport = new ScriptedTransport();
    respondChannel(transport, Channel.Ch1, "1", "DC", "VOLT");
    respond(transport, ":CHANnel1:OFFSet?", "0");
    const driver = scriptedDriver(transport);
    await driver.readChannelState(Channel.Ch1, ScpiPriority.Normal);

    const command = liveCommand(WaveformSource.Ch1);
    transport.binary.set(command, [Uint8Array.from([10, 12]), Uint8Array.from([10, 12])]);
    respond(transport, ":WAVeform:PREamble?", "0,0,2,1,1e-6,0,0,0.5,0,10");

    const first = await readOneLive(driver, WaveformSource.Ch1, 2);
    await driver.setChannelScale(Channel.Ch1, 0.2, ScpiPriority.Normal);
    const second = await readOneLive(driver, WaveformSource.Ch1, 2);

    expect([...first.samples]).toEqual([0, 1]);
    expect([...second.samples]).toEqual([0, 2]);
    expect(transport.commands.filter((entry) => entry === ":WAVeform:PREamble?")).toHaveLength(1);
  });

  it("updates cached vertical offset metadata without another preamble query", async () => {
    const transport = new ScriptedTransport();
    respondChannel(transport, Channel.Ch1, "1", "DC", "VOLT");
    respond(transport, ":CHANnel1:OFFSet?", "0");
    const driver = scriptedDriver(transport);
    await driver.readChannelState(Channel.Ch1, ScpiPriority.Normal);

    const command = liveCommand(WaveformSource.Ch1);
    transport.binary.set(command, [Uint8Array.from([12]), Uint8Array.from([12])]);
    respond(transport, ":WAVeform:PREamble?", "0,0,1,1,1e-6,0,0,0.5,0,10");

    const first = await readOneLive(driver, WaveformSource.Ch1, 1);
    await driver.setChannelOffset(Channel.Ch1, 0.5, ScpiPriority.Normal);
    const second = await readOneLive(driver, WaveformSource.Ch1, 1);

    expect(first.samples[0]).toBe(1);
    expect(second.samples[0]).toBe(0.5);
    expect(transport.commands.filter((entry) => entry === ":WAVeform:PREamble?")).toHaveLength(1);
  });

  it("refreshes horizontal position metadata after a write", async () => {
    const transport = new ScriptedTransport();
    respondHorizontal(transport, "1E-3", "2E-4");
    const driver = scriptedDriver(transport);
    await driver.readHorizontalState(ScpiPriority.Normal);

    const command = liveCommand(WaveformSource.Ch1);
    transport.binary.set(command, [Uint8Array.from([10]), Uint8Array.from([10])]);
    respond(
      transport,
      ":WAVeform:PREamble?",
      "0,0,1,1,1e-5,-4.8e-3,0,0.5,0,10",
      "0,0,1,1,1e-5,-4.6e-3,0,0.5,0,10",
    );
    respond(transport, ":TIMebase:MAIN:OFFSet?", "4e-4");
    respond(transport, ":CHANnel1:UNITs?", "VOLT");

    const first = await readOneLive(driver, WaveformSource.Ch1, 1);
    await driver.setHorizontalPosition(4e-4, ScpiPriority.Interactive);
    const second = await readOneLive(driver, WaveformSource.Ch1, 1);

    expect(first.xOrigin).toBeCloseTo(-4.8e-3);
    expect(second.xOrigin).toBeCloseTo(-4.6e-3);
    expect(second.xIncrement).toBeCloseTo(1e-5);
    expect(transport.commands.filter((entry) => entry === ":WAVeform:PREamble?")).toHaveLength(2);
  });

  it("refreshes horizontal scale metadata after a write", async () => {
    const transport = new ScriptedTransport();
    respondHorizontal(transport, "1E-3", "2E-4");
    const driver = scriptedDriver(transport);
    await driver.readHorizontalState(ScpiPriority.Normal);

    const command = liveCommand(WaveformSource.Ch1);
    transport.binary.set(command, [Uint8Array.from([10]), Uint8Array.from([10])]);
    respond(
      transport,
      ":WAVeform:PREamble?",
      "0,0,1,1,1e-5,-4.8e-3,0,0.5,0,10",
      "0,0,1,1,2e-5,-9.8e-3,0,0.5,0,10",
    );
    respond(transport, ":TIMebase:MAIN:SCALe?", "2e-3");
    respond(transport, ":CHANnel1:UNITs?", "VOLT");

    const first = await readOneLive(driver, WaveformSource.Ch1, 1);
    await driver.setHorizontalScale(2e-3, ScpiPriority.Interactive);
    const second = await readOneLive(driver, WaveformSource.Ch1, 1);

    expect(first.xOrigin).toBeCloseTo(-4.8e-3);
    expect(second.xOrigin).toBeCloseTo(-9.8e-3);
    expect(second.xIncrement).toBeCloseTo(2e-5);
    expect(transport.commands.filter((entry) => entry === ":WAVeform:PREamble?")).toHaveLength(2);
  });

  it("refreshes horizontal metadata after XY writes", async () => {
    const transport = new ScriptedTransport();
    respond(transport, ":TIMebase:XY:ENABle?", "1");
    respond(transport, ":TIMebase:MODE?", "MAIN");
    respond(transport, ":TIMebase:MAIN:SCALe?", "1E-3");
    respond(transport, ":TIMebase:MAIN:OFFSet?", "0");
    const driver = scriptedDriver(transport);
    await driver.readHorizontalState(ScpiPriority.Normal);

    const command = liveCommand(WaveformSource.Ch1);
    transport.binary.set(command, [Uint8Array.from([10]), Uint8Array.from([10])]);
    respond(
      transport,
      ":WAVeform:PREamble?",
      "0,0,1,1,1e-5,-5e-3,0,0.5,0,10",
      "0,0,1,1,2e-5,-1e-2,0,0.5,0,10",
    );
    respond(transport, ":TIMebase:MAIN:SCALe?", "2e-3");
    respond(transport, ":CHANnel1:UNITs?", "VOLT");

    await readOneLive(driver, WaveformSource.Ch1, 1);
    await driver.setHorizontalScale(2e-3, ScpiPriority.Normal);
    const second = await readOneLive(driver, WaveformSource.Ch1, 1);

    expect(second.xIncrement).toBeCloseTo(2e-5);
    expect(transport.commands.filter((entry) => entry === ":WAVeform:PREamble?")).toHaveLength(2);
  });

  it("assembles RAW WORD chunks for physical channels without exposing native codes", async () => {
    const transport = new ScriptedTransport();
    transport.binary.set(":WAVeform:DATA?", [Uint8Array.from([1, 0, 2, 0, 3, 0])]);
    respond(transport, ":WAVeform:PREamble?", "1,0,3,1,1e-6,0,0,1,0,0");
    respond(transport, ":CHANnel1:UNITs?", "VOLT");
    const waveform = await scriptedDriver(transport).readRawWaveform(Channel.Ch1, 3);
    expect(waveform.source).toBe(WaveformSource.Ch1);
    expect([...waveform.samples]).toEqual([1, 2, 3]);
    expect(transport.commands).toContain(":WAVeform:STARt 1");
    expect(transport.commands).toContain(":WAVeform:STOP 3");
  });
});
