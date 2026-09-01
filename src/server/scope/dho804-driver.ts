import {
  AcquisitionType,
  Channel,
  ChannelCoupling,
  ChannelUnit,
  EdgeSlope,
  MeasurementKind,
  type MeasurementSpec,
  type MeasurementValue,
  type AcquisitionState,
  type ChannelState,
  type HorizontalState,
  type ScopeInfo,
  ScopeRunState,
  type ScopeState,
  TimebaseMode,
  TriggerCoupling,
  TriggerSweep,
  TriggerType,
  type TriggerState,
} from "../../shared/scope-types.js";
import {
  ScpiProgramMessageKind,
  classifyScpiProgramMessage,
} from "../scpi/scpi-program-message.js";
import {
  ScpiOperationKind,
  ScpiPriority,
  type ScpiCoalesceKey,
  type ScpiScheduler,
} from "../scpi/scpi-scheduler.js";
import {
  ScpiResponseKind,
  type ScpiTransport,
} from "../scpi/scpi-transport.js";
import { decodeDho804WordSamples } from "./dho804-word-decoder.js";

export interface Dho804Waveform {
  channel: Channel;
  unit: ChannelUnit;
  samples: Float32Array;
  xIncrement: number;
  xOrigin: number;
  xReference: number;
}

interface WaveformPreamble {
  points: number;
  xIncrement: number;
  xOrigin: number;
  xReference: number;
  yIncrement: number;
  yOrigin: number;
  yReference: number;
}

interface WaveformSetupCache {
  source: Channel | null;
  mode: "NORM" | "RAW" | null;
  format: "BYTE" | "WORD" | null;
  points: number | null;
}

interface LiveWaveformPreambleCache {
  pointCount: number;
  preamble: WaveformPreamble;
}

interface Dho804CoalesceKeys {
  channelScale: Readonly<Record<Channel, ScpiCoalesceKey>>;
  channelOffset: Readonly<Record<Channel, ScpiCoalesceKey>>;
  horizontalScale: ScpiCoalesceKey;
  horizontalPosition: ScpiCoalesceKey;
  triggerLevel: ScpiCoalesceKey;
  liveWaveform: ScpiCoalesceKey;
}

const channels = [Channel.Ch1, Channel.Ch2, Channel.Ch3, Channel.Ch4] as const;
const rawChunkSamples = 250_000;

export class Dho804Driver {
  private waveformSetup: WaveformSetupCache = {
    source: null,
    mode: null,
    format: null,
    points: null,
  };
  private readonly channelUnits = new Map<Channel, ChannelUnit>();
  private readonly liveWaveformPreambles = new Map<Channel, LiveWaveformPreambleCache>();
  private readonly coalesceKeys = createDho804CoalesceKeys();

  public constructor(private readonly scheduler: ScpiScheduler) {}

  public async identify(): Promise<ScopeInfo> {
    const response = await this.queryText("*IDN?", ScpiPriority.Normal, ScpiOperationKind.Identity);
    const parts = response.split(",").map((part) => part.trim());
    if (parts.length !== 4) {
      throw new Error(`Malformed DHO804 identification response: ${response}`);
    }
    const [manufacturer, model, serialNumber, softwareVersion] = parts;
    if (
      manufacturer === undefined ||
      model === undefined ||
      serialNumber === undefined ||
      softwareVersion === undefined
    ) {
      throw new Error(`Malformed DHO804 identification response: ${response}`);
    }
    if (model !== "DHO804") {
      throw new Error(`Unsupported oscilloscope model: ${model}`);
    }
    return { manufacturer, model, serialNumber, softwareVersion };
  }

  public async readScopeState(priority: ScpiPriority): Promise<ScopeState> {
    const channel1 = await this.readChannelState(Channel.Ch1, priority);
    const channel2 = await this.readChannelState(Channel.Ch2, priority);
    const channel3 = await this.readChannelState(Channel.Ch3, priority);
    const channel4 = await this.readChannelState(Channel.Ch4, priority);
    const horizontal = await this.readHorizontalState(priority);
    const acquisition = await this.readAcquisitionState(priority);
    const runState = await this.readRunState(priority);
    const trigger = await this.readTriggerState(priority);

    return {
      channels: [channel1, channel2, channel3, channel4],
      horizontal,
      acquisition,
      runState,
      trigger,
    };
  }

  public async readChannelState(channel: Channel, priority: ScpiPriority): Promise<ChannelState> {
    const prefix = channelPrefix(channel);
    const enabled = parseBoolean(await this.queryText(`${prefix}:DISPlay?`, priority));
    const coupling = parseChannelCoupling(await this.queryText(`${prefix}:COUPling?`, priority));
    const unit = parseChannelUnit(await this.queryText(`${prefix}:UNITs?`, priority));
    this.channelUnits.set(channel, unit);
    const scale = parseFiniteNumber(await this.queryText(`${prefix}:SCALe?`, priority), "channel scale");
    const offset = parseFiniteNumber(await this.queryText(`${prefix}:OFFSet?`, priority), "channel offset");
    const probeRatio = parsePositiveNumber(
      await this.queryText(`${prefix}:PROBe?`, priority),
      "probe ratio",
    );
    return { channel, enabled, coupling, unit, scale, offset, probeRatio };
  }

  public async readHorizontalState(priority: ScpiPriority): Promise<HorizontalState> {
    const xyEnabled = parseBoolean(await this.queryText(":TIMebase:XY:ENABle?", priority));
    const baseMode = (await this.queryText(":TIMebase:MODE?", priority)).trim().toUpperCase();
    const mode = xyEnabled
      ? TimebaseMode.Xy
      : baseMode === "ROLL"
        ? TimebaseMode.Roll
        : baseMode === "MAIN"
          ? TimebaseMode.Main
          : failToken("timebase mode", baseMode);
    const scale = parsePositiveNumber(
      await this.queryText(":TIMebase:MAIN:SCALe?", priority),
      "horizontal scale",
    );
    const position = parseFiniteNumber(
      await this.queryText(":TIMebase:MAIN:OFFSet?", priority),
      "horizontal position",
    );
    return { mode, scale, position };
  }

  public async readAcquisitionState(priority: ScpiPriority): Promise<AcquisitionState> {
    const type = parseAcquisitionType(await this.queryText(":ACQuire:TYPE?", priority));
    const averages = parsePositiveInteger(
      await this.queryText(":ACQuire:AVERages?", priority),
      "acquisition averages",
    );
    const memoryDepth = parsePositiveIntegerLikeNumber(
      await this.queryText(":ACQuire:MDEPth?", priority),
      "memory depth",
    );
    const sampleRate = parsePositiveNumber(
      await this.queryText(":ACQuire:SRATe?", priority),
      "sample rate",
    );
    return { type, averages, memoryDepth, sampleRate };
  }

  public async readTriggerState(priority: ScpiPriority): Promise<TriggerState> {
    const type = parseTriggerType(await this.queryText(":TRIGger:MODE?", priority));
    const sweep = parseTriggerSweep(await this.queryText(":TRIGger:SWEep?", priority));
    if (type !== TriggerType.Edge) {
      return { type, sweep };
    }
    const source = parseChannelSource(await this.queryText(":TRIGger:EDGE:SOURce?", priority));
    const slope = parseEdgeSlope(await this.queryText(":TRIGger:EDGE:SLOPe?", priority));
    const level = parseFiniteNumber(
      await this.queryText(":TRIGger:EDGE:LEVel?", priority),
      "trigger level",
    );
    const coupling = parseTriggerCoupling(await this.queryText(":TRIGger:COUPling?", priority));
    return { type: TriggerType.Edge, sweep, source, slope, level, coupling };
  }

  public async readRunState(priority: ScpiPriority): Promise<ScopeRunState> {
    const token = (await this.queryText(":TRIGger:STATus?", priority)).trim().toUpperCase();
    switch (token) {
      case "TD": return ScopeRunState.Triggered;
      case "WAIT": return ScopeRunState.Waiting;
      case "RUN": return ScopeRunState.Running;
      case "AUTO": return ScopeRunState.Auto;
      case "STOP": return ScopeRunState.Stopped;
      default: return failToken("run state", token);
    }
  }

  public async readChannelEnabled(channel: Channel, priority: ScpiPriority): Promise<boolean> {
    return parseBoolean(await this.queryText(`${channelPrefix(channel)}:DISPlay?`, priority));
  }

  public async setChannelEnabled(channel: Channel, enabled: boolean, priority: ScpiPriority): Promise<void> {
    await this.command(
      `${channelPrefix(channel)}:DISPlay ${enabled ? "ON" : "OFF"}`,
      priority,
      null,
    );
  }

  public async readChannelScale(channel: Channel, priority: ScpiPriority): Promise<number> {
    return parsePositiveNumber(
      await this.queryText(`${channelPrefix(channel)}:SCALe?`, priority),
      "channel scale",
    );
  }

  public async setChannelScale(channel: Channel, value: number, priority: ScpiPriority): Promise<void> {
    requireFinite(value, "channel scale");
    await this.command(
      `${channelPrefix(channel)}:SCALe ${value}`,
      priority,
      this.coalesceKeys.channelScale[channel],
    );
    this.liveWaveformPreambles.delete(channel);
  }

  public async readChannelOffset(channel: Channel, priority: ScpiPriority): Promise<number> {
    return parseFiniteNumber(
      await this.queryText(`${channelPrefix(channel)}:OFFSet?`, priority),
      "channel offset",
    );
  }

  public async setChannelOffset(channel: Channel, value: number, priority: ScpiPriority): Promise<void> {
    requireFinite(value, "channel offset");
    await this.command(
      `${channelPrefix(channel)}:OFFSet ${value}`,
      priority,
      this.coalesceKeys.channelOffset[channel],
    );
    this.liveWaveformPreambles.delete(channel);
  }

  public async readHorizontalScale(priority: ScpiPriority): Promise<number> {
    return parsePositiveNumber(
      await this.queryText(":TIMebase:MAIN:SCALe?", priority),
      "horizontal scale",
    );
  }

  public async setHorizontalScale(value: number, priority: ScpiPriority): Promise<void> {
    requireFinite(value, "horizontal scale");
    await this.command(
      `:TIMebase:MAIN:SCALe ${value}`,
      priority,
      this.coalesceKeys.horizontalScale,
    );
    this.liveWaveformPreambles.clear();
  }

  public async readHorizontalPosition(priority: ScpiPriority): Promise<number> {
    return parseFiniteNumber(
      await this.queryText(":TIMebase:MAIN:OFFSet?", priority),
      "horizontal position",
    );
  }

  public async setHorizontalPosition(value: number, priority: ScpiPriority): Promise<void> {
    requireFinite(value, "horizontal position");
    await this.command(
      `:TIMebase:MAIN:OFFSet ${value}`,
      priority,
      this.coalesceKeys.horizontalPosition,
    );
    this.liveWaveformPreambles.clear();
  }

  public async readTriggerType(priority: ScpiPriority): Promise<TriggerType> {
    return parseTriggerType(await this.queryText(":TRIGger:MODE?", priority));
  }

  public async setTriggerType(type: TriggerType.Edge, priority: ScpiPriority): Promise<void> {
    if (type !== TriggerType.Edge) {
      throw new Error("Version 1 only supports writing Edge trigger type");
    }
    await this.command(":TRIGger:MODE EDGE", priority, null);
  }

  public async readEdgeSource(priority: ScpiPriority): Promise<Channel> {
    return parseChannelSource(await this.queryText(":TRIGger:EDGE:SOURce?", priority));
  }

  public async setTriggerSource(channel: Channel, priority: ScpiPriority): Promise<void> {
    await this.command(`:TRIGger:EDGE:SOURce CHANnel${channel}`, priority, null);
  }

  public async readEdgeSlope(priority: ScpiPriority): Promise<EdgeSlope> {
    return parseEdgeSlope(await this.queryText(":TRIGger:EDGE:SLOPe?", priority));
  }

  public async setTriggerSlope(slope: EdgeSlope, priority: ScpiPriority): Promise<void> {
    await this.command(`:TRIGger:EDGE:SLOPe ${edgeSlopeToken(slope)}`, priority, null);
  }

  public async readEdgeLevel(priority: ScpiPriority): Promise<number> {
    return parseFiniteNumber(
      await this.queryText(":TRIGger:EDGE:LEVel?", priority),
      "trigger level",
    );
  }

  public async setTriggerLevel(value: number, priority: ScpiPriority): Promise<void> {
    requireFinite(value, "trigger level");
    await this.command(
      `:TRIGger:EDGE:LEVel ${value}`,
      priority,
      this.coalesceKeys.triggerLevel,
    );
  }

  public async run(): Promise<void> {
    await this.command(":RUN", ScpiPriority.Immediate, null, ScpiOperationKind.Action);
  }

  public async stop(): Promise<void> {
    await this.command(":STOP", ScpiPriority.Immediate, null, ScpiOperationKind.Action);
  }

  public async single(): Promise<void> {
    await this.command(":SINGle", ScpiPriority.Immediate, null, ScpiOperationKind.Action);
  }

  public async readMeasurements(
    specs: MeasurementSpec[],
    priority: ScpiPriority,
  ): Promise<MeasurementValue[]> {
    const values: MeasurementValue[] = [];
    for (const spec of specs) {
      const item = measurementItem(spec.kind);
      const source = `CHANnel${spec.channel}`;
      const queryStatistic = async (statistic: string, name: string): Promise<number> =>
        parseFiniteNumber(
          await this.queryText(
            `:MEASure:STATistic:ITEM? ${statistic},${item},${source}`,
            priority,
            ScpiOperationKind.Measurement,
          ),
          name,
        );

      const current = await queryStatistic("CURRent", "measurement current");
      const minimum = await queryStatistic("MINimum", "measurement minimum");
      const maximum = await queryStatistic("MAXimum", "measurement maximum");
      const average = await queryStatistic("AVERages", "measurement average");
      const deviation = await queryStatistic("DEViation", "measurement deviation");
      const count = parseNonNegativeInteger(
        await this.queryText(
          `:MEASure:STATistic:ITEM? CNT,${item},${source}`,
          priority,
          ScpiOperationKind.Measurement,
        ),
        "measurement count",
      );
      values.push({
        ...spec,
        statistics: { current, minimum, maximum, average, deviation, count },
      });
    }
    return values;
  }

  public async setMeasurements(
    specs: MeasurementSpec[],
    priority: ScpiPriority,
  ): Promise<void> {
    await this.command(":MEASure:CLEar", priority, null, ScpiOperationKind.Measurement);
    await this.command(":MEASure:STATistic:RESet", priority, null, ScpiOperationKind.Measurement);
    for (const spec of specs) {
      const item = measurementItem(spec.kind);
      const source = `CHANnel${spec.channel}`;
      await this.command(
        `:MEASure:ITEM ${item},${source}`,
        priority,
        null,
        ScpiOperationKind.Measurement,
      );
      await this.command(
        `:MEASure:STATistic:ITEM ${item},${source}`,
        priority,
        null,
        ScpiOperationKind.Measurement,
      );
    }
  }

  public async executeRawScpi(command: string): Promise<string> {
    const messageKind = classifyScpiProgramMessage(command);
    try {
      if (messageKind === ScpiProgramMessageKind.Query) {
        return await this.scheduler.schedule({
          priority: ScpiPriority.Normal,
          kind: ScpiOperationKind.RawScpi,
          execute: async (transport, recorder) => {
            const response = await transport.query(command);
            if (response.kind === ScpiResponseKind.Binary) {
              recorder.addBinaryBytes(response.value.byteLength);
              throw new Error("Binary SCPI console responses are not supported in version 1");
            }
            return response.value;
          },
        });
      }
      await this.scheduler.schedule({
        priority: ScpiPriority.Normal,
        kind: ScpiOperationKind.RawScpi,
        execute: async (transport) => {
          await transport.command(command);
          return undefined;
        },
      });
      return "";
    } finally {
      this.invalidateWaveformSetup();
    }
  }

  public async readLiveWaveform(channel: Channel, pointCount: number): Promise<Dho804Waveform> {
    if (!Number.isInteger(pointCount) || pointCount < 1 || pointCount > 1_000) {
      throw new Error("Live waveform pointCount must be an integer from 1 to 1000");
    }

    return this.scheduler.scheduleLatest(
      ScpiPriority.Waveform,
      this.coalesceKeys.liveWaveform,
      ScpiOperationKind.BinaryTransfer,
      async (transport, recorder) => {
        await this.ensureWaveformSetup(transport, channel, "NORM", "BYTE", pointCount);
        const payload = await transport.queryBinary(":WAVeform:DATA?");
        recorder.addBinaryBytes(payload.byteLength);
        if (payload.byteLength !== pointCount) {
          throw new Error(
            `Expected ${pointCount} live waveform samples, received ${payload.byteLength}`,
          );
        }
        const preamble = await this.liveWaveformPreamble(transport, channel, pointCount);
        const unit = await this.channelUnit(transport, channel);
        return createWaveform(channel, unit, payload, preamble);
      },
    );
  }

  public async readRawWaveform(channel: Channel, sampleCount: number): Promise<Dho804Waveform> {
    if (!Number.isSafeInteger(sampleCount) || sampleCount < 1) {
      throw new Error("RAW waveform sampleCount must be a positive safe integer");
    }

    return this.scheduler.schedule({
      priority: ScpiPriority.Normal,
      kind: ScpiOperationKind.BinaryTransfer,
      execute: async (transport, recorder) => {
        await this.ensureWaveformSetup(transport, channel, "RAW", "WORD", sampleCount);
        const native = new Uint16Array(sampleCount);
        let written = 0;
        while (written < sampleCount) {
          const count = Math.min(rawChunkSamples, sampleCount - written);
          const start = written + 1;
          const stop = written + count;
          await transport.command(`:WAVeform:STARt ${start}`);
          await transport.command(`:WAVeform:STOP ${stop}`);
          const payload = await transport.queryBinary(":WAVeform:DATA?");
          recorder.addBinaryBytes(payload.byteLength);
          const decoded = decodeDho804WordSamples(payload);
          if (decoded.length !== count) {
            throw new Error(
              `RAW waveform chunk ${start}-${stop} returned ${decoded.length} samples instead of ${count}`,
            );
          }
          native.set(decoded, written);
          written += decoded.length;
        }

        if (written !== sampleCount) {
          throw new Error(`RAW waveform returned ${written} samples instead of ${sampleCount}`);
        }

        const preamble = parseWaveformPreamble(await transport.queryText(":WAVeform:PREamble?"));
        const unit = parseChannelUnit(await transport.queryText(`${channelPrefix(channel)}:UNITs?`));
        this.channelUnits.set(channel, unit);
        return createWaveform(channel, unit, native, preamble);
      },
    });
  }

  public invalidateWaveformSetup(): void {
    this.waveformSetup = { source: null, mode: null, format: null, points: null };
    this.liveWaveformPreambles.clear();
    this.channelUnits.clear();
  }

  private async queryText(
    command: string,
    priority: ScpiPriority,
    kind = ScpiOperationKind.StateRead,
  ): Promise<string> {
    return this.scheduler.schedule({
      priority,
      kind,
      execute: (transport) => transport.queryText(command),
    });
  }

  private async command(
    command: string,
    priority: ScpiPriority,
    coalesceKey: ScpiCoalesceKey | null,
    kind = ScpiOperationKind.Write,
  ): Promise<void> {
    const execute = async (transport: ScpiTransport): Promise<void> => {
      await transport.command(command);
    };

    if (priority === ScpiPriority.Interactive) {
      if (coalesceKey === null) {
        throw new Error("Interactive SCPI writes require a semantic coalescing key");
      }
      await this.scheduler.scheduleInteractive(kind, coalesceKey, execute);
      return;
    }
    if (priority === ScpiPriority.Immediate) {
      await this.scheduler.scheduleImmediate(kind, coalesceKey, execute);
      return;
    }
    await this.scheduler.schedule({ priority, kind, execute });
  }

  private async ensureWaveformSetup(
    transport: ScpiTransport,
    channel: Channel,
    mode: "NORM" | "RAW",
    format: "BYTE" | "WORD",
    points: number,
  ): Promise<void> {
    if (this.waveformSetup.source !== channel) {
      await transport.command(`:WAVeform:SOURce CHANnel${channel}`);
      this.waveformSetup.source = channel;
    }
    if (this.waveformSetup.mode !== mode) {
      await transport.command(`:WAVeform:MODE ${mode}`);
      this.waveformSetup.mode = mode;
    }
    if (this.waveformSetup.format !== format) {
      await transport.command(`:WAVeform:FORMat ${format}`);
      this.waveformSetup.format = format;
    }
    if (this.waveformSetup.points !== points) {
      await transport.command(`:WAVeform:POINts ${points}`);
      this.waveformSetup.points = points;
    }
  }

  private async liveWaveformPreamble(
    transport: ScpiTransport,
    channel: Channel,
    pointCount: number,
  ): Promise<WaveformPreamble> {
    const cached = this.liveWaveformPreambles.get(channel);
    if (cached !== undefined && cached.pointCount === pointCount) {
      return cached.preamble;
    }
    const preamble = parseWaveformPreamble(await transport.queryText(":WAVeform:PREamble?"));
    this.liveWaveformPreambles.set(channel, { pointCount, preamble });
    return preamble;
  }

  private async channelUnit(transport: ScpiTransport, channel: Channel): Promise<ChannelUnit> {
    const cached = this.channelUnits.get(channel);
    if (cached !== undefined) {
      return cached;
    }
    const unit = parseChannelUnit(await transport.queryText(`${channelPrefix(channel)}:UNITs?`));
    this.channelUnits.set(channel, unit);
    return unit;
  }
}

function createDho804CoalesceKeys(): Dho804CoalesceKeys {
  return {
    channelScale: {
      [Channel.Ch1]: Symbol("DHO804 channel 1 scale"),
      [Channel.Ch2]: Symbol("DHO804 channel 2 scale"),
      [Channel.Ch3]: Symbol("DHO804 channel 3 scale"),
      [Channel.Ch4]: Symbol("DHO804 channel 4 scale"),
    },
    channelOffset: {
      [Channel.Ch1]: Symbol("DHO804 channel 1 offset"),
      [Channel.Ch2]: Symbol("DHO804 channel 2 offset"),
      [Channel.Ch3]: Symbol("DHO804 channel 3 offset"),
      [Channel.Ch4]: Symbol("DHO804 channel 4 offset"),
    },
    horizontalScale: Symbol("DHO804 horizontal scale"),
    horizontalPosition: Symbol("DHO804 horizontal position"),
    triggerLevel: Symbol("DHO804 trigger level"),
    liveWaveform: Symbol("DHO804 live waveform"),
  };
}

function channelPrefix(channel: Channel): string {
  if (!channels.includes(channel)) {
    throw new Error(`Invalid DHO804 channel: ${channel}`);
  }
  return `:CHANnel${channel}`;
}

function parseBoolean(value: string): boolean {
  switch (value.trim()) {
    case "0": return false;
    case "1": return true;
    default: return failToken("boolean", value);
  }
}

function parseChannelCoupling(value: string): ChannelCoupling {
  switch (value.trim().toUpperCase()) {
    case "AC": return ChannelCoupling.Ac;
    case "DC": return ChannelCoupling.Dc;
    case "GND": return ChannelCoupling.Ground;
    default: return failToken("channel coupling", value);
  }
}

function parseChannelUnit(value: string): ChannelUnit {
  switch (value.trim().toUpperCase()) {
    case "VOLT": return ChannelUnit.Volts;
    case "AMP": return ChannelUnit.Amps;
    case "WATT": return ChannelUnit.Watts;
    case "UNKN": return ChannelUnit.Unknown;
    default: return failToken("channel unit", value);
  }
}

function parseAcquisitionType(value: string): AcquisitionType {
  switch (value.trim().toUpperCase()) {
    case "NORM": return AcquisitionType.Normal;
    case "PEAK": return AcquisitionType.Peak;
    case "AVER": return AcquisitionType.Average;
    case "ULTR": return AcquisitionType.Ultra;
    default: return failToken("acquisition type", value);
  }
}

function parseTriggerType(value: string): TriggerType {
  switch (value.trim().toUpperCase()) {
    case "EDGE": return TriggerType.Edge;
    case "PULS": return TriggerType.Pulse;
    case "SLOP": return TriggerType.Slope;
    case "VID": return TriggerType.Video;
    case "PATT": return TriggerType.Pattern;
    case "DUR": return TriggerType.Duration;
    case "TIM": return TriggerType.Timeout;
    case "RUNT": return TriggerType.Runt;
    case "WIND": return TriggerType.Window;
    case "DEL": return TriggerType.Delay;
    case "SET": return TriggerType.SetupHold;
    case "NEDG": return TriggerType.NthEdge;
    case "RS232": return TriggerType.Rs232;
    case "IIC": return TriggerType.I2c;
    case "SPI": return TriggerType.Spi;
    case "CAN": return TriggerType.Can;
    default: return failToken("trigger type", value);
  }
}

function parseTriggerSweep(value: string): TriggerSweep {
  switch (value.trim().toUpperCase()) {
    case "AUTO": return TriggerSweep.Auto;
    case "NORM": return TriggerSweep.Normal;
    case "SING": return TriggerSweep.Single;
    default: return failToken("trigger sweep", value);
  }
}

function parseChannelSource(value: string): Channel {
  const match = /^CHAN(?:NEL)?([1-4])$/i.exec(value.trim());
  if (match === null || match[1] === undefined) {
    return failToken("trigger source", value);
  }
  return Number(match[1]) as Channel;
}

function parseEdgeSlope(value: string): EdgeSlope {
  switch (value.trim().toUpperCase()) {
    case "POS": return EdgeSlope.Rising;
    case "NEG": return EdgeSlope.Falling;
    case "RFAL": return EdgeSlope.Either;
    default: return failToken("edge slope", value);
  }
}

function edgeSlopeToken(value: EdgeSlope): string {
  switch (value) {
    case EdgeSlope.Rising: return "POSitive";
    case EdgeSlope.Falling: return "NEGative";
    case EdgeSlope.Either: return "RFALl";
  }
}

function parseTriggerCoupling(value: string): TriggerCoupling {
  switch (value.trim().toUpperCase()) {
    case "AC": return TriggerCoupling.Ac;
    case "DC": return TriggerCoupling.Dc;
    case "LFR": return TriggerCoupling.LowFrequencyReject;
    case "HFR": return TriggerCoupling.HighFrequencyReject;
    default: return failToken("trigger coupling", value);
  }
}

function measurementItem(kind: MeasurementKind): string {
  switch (kind) {
    case MeasurementKind.Vpp: return "VPP";
    case MeasurementKind.Vmax: return "VMAX";
    case MeasurementKind.Vmin: return "VMIN";
    case MeasurementKind.Vavg: return "VAVG";
    case MeasurementKind.Vrms: return "VRMS";
    case MeasurementKind.Frequency: return "FREQuency";
    case MeasurementKind.Period: return "PERiod";
    case MeasurementKind.Vtop: return "VTOP";
    case MeasurementKind.Vbase: return "VBASe";
    case MeasurementKind.Vamp: return "VAMP";
    case MeasurementKind.Vupper: return "VUPPer";
    case MeasurementKind.Vmid: return "VMID";
    case MeasurementKind.Vlower: return "VLOWer";
    case MeasurementKind.Overshoot: return "OVERshoot";
    case MeasurementKind.Preshoot: return "PREShoot";
    case MeasurementKind.RiseTime: return "RTIMe";
    case MeasurementKind.FallTime: return "FTIMe";
    case MeasurementKind.PositiveWidth: return "PWIDth";
    case MeasurementKind.NegativeWidth: return "NWIDth";
    case MeasurementKind.PositiveDuty: return "PDUTy";
    case MeasurementKind.NegativeDuty: return "NDUTy";
    case MeasurementKind.Tvmax: return "TVMAX";
    case MeasurementKind.Tvmin: return "TVMIN";
  }
}

function parseWaveformPreamble(value: string): WaveformPreamble {
  const fields = value.trim().split(",");
  if (fields.length < 10) {
    throw new Error(`Malformed DHO804 waveform preamble: ${value}`);
  }
  const points = parsePositiveIntegerLikeNumber(requiredField(fields, 2), "waveform points");
  return {
    points,
    xIncrement: parsePositiveNumber(requiredField(fields, 4), "waveform X increment"),
    xOrigin: parseFiniteNumber(requiredField(fields, 5), "waveform X origin"),
    xReference: parseFiniteNumber(requiredField(fields, 6), "waveform X reference"),
    yIncrement: parseFiniteNumber(requiredField(fields, 7), "waveform Y increment"),
    yOrigin: parseFiniteNumber(requiredField(fields, 8), "waveform Y origin"),
    yReference: parseFiniteNumber(requiredField(fields, 9), "waveform Y reference"),
  };
}

function requiredField(fields: string[], index: number): string {
  const value = fields[index];
  if (value === undefined) {
    throw new Error(`Missing waveform preamble field ${index}`);
  }
  return value;
}

function createWaveform(
  channel: Channel,
  unit: ChannelUnit,
  native: Uint8Array | Uint16Array,
  preamble: WaveformPreamble,
): Dho804Waveform {
  const samples = new Float32Array(native.length);
  for (let index = 0; index < native.length; index += 1) {
    const code = native[index];
    if (code === undefined) {
      throw new Error("Missing native waveform sample");
    }
    samples[index] = (code - preamble.yOrigin - preamble.yReference) * preamble.yIncrement;
  }
  return {
    channel,
    unit,
    samples,
    xIncrement: preamble.xIncrement,
    xOrigin: preamble.xOrigin,
    xReference: preamble.xReference,
  };
}

function parseFiniteNumber(value: string, name: string): number {
  const parsed = Number(value.trim());
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid ${name}: ${value}`);
  }
  return parsed;
}

function parsePositiveNumber(value: string, name: string): number {
  const parsed = parseFiniteNumber(value, name);
  if (parsed <= 0) {
    throw new Error(`Invalid ${name}: ${value}`);
  }
  return parsed;
}

function parsePositiveInteger(value: string, name: string): number {
  const parsed = Number(value.trim());
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${name}: ${value}`);
  }
  return parsed;
}

function parseNonNegativeInteger(value: string, name: string): number {
  const parsed = Number(value.trim());
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid ${name}: ${value}`);
  }
  return parsed;
}

function parsePositiveIntegerLikeNumber(value: string, name: string): number {
  const parsed = parsePositiveNumber(value, name);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`Invalid ${name}: ${value}`);
  }
  return parsed;
}

function requireFinite(value: number, name: string): void {
  if (!Number.isFinite(value)) {
    throw new Error(`${name} must be finite`);
  }
}

function failToken(name: string, value: string): never {
  throw new Error(`Unknown DHO804 ${name} token: ${value}`);
}
