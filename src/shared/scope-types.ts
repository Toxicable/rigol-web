export interface ScopeInfo {
  manufacturer: string;
  model: string;
  serialNumber: string;
  softwareVersion: string;
}

export enum Channel {
  Ch1 = 1,
  Ch2 = 2,
  Ch3 = 3,
  Ch4 = 4,
}

export enum WaveformSource {
  Ch1 = 1,
  Ch2 = 2,
  Ch3 = 3,
  Ch4 = 4,
  Math1 = 5,
  Math2 = 6,
  Math3 = 7,
  Math4 = 8,
}

export enum MathChannel {
  Math1 = 1,
  Math2 = 2,
  Math3 = 3,
  Math4 = 4,
}

export enum MathSource {
  Ch1 = 1,
  Ch2 = 2,
  Ch3 = 3,
  Ch4 = 4,
  Math1 = 5,
  Math2 = 6,
  Math3 = 7,
  Math4 = 8,
  Ref1 = 101,
  Ref2 = 102,
  Ref3 = 103,
  Ref4 = 104,
  Ref5 = 105,
  Ref6 = 106,
  Ref7 = 107,
  Ref8 = 108,
  Ref9 = 109,
  Ref10 = 110,
}

export enum MathOperator {
  Add = 1,
  Subtract = 2,
  Multiply = 3,
  Divide = 4,
  And = 5,
  Or = 6,
  Xor = 7,
  Not = 8,
  Fft = 9,
  Integrate = 10,
  Differentiate = 11,
  SquareRoot = 12,
  Log10 = 13,
  NaturalLog = 14,
  Exp = 15,
  Abs = 16,
  LowPass = 17,
  HighPass = 18,
  BandPass = 19,
  BandStop = 20,
  AxB = 21,
}

export function isArithmeticMathOperator(operator: MathOperator): boolean {
  return operator === MathOperator.Add ||
    operator === MathOperator.Subtract ||
    operator === MathOperator.Multiply ||
    operator === MathOperator.Divide;
}

export function waveformSourceForChannel(channel: Channel): WaveformSource {
  return channel as number as WaveformSource;
}

export function waveformSourceForMath(math: MathChannel): WaveformSource {
  return (math + 4) as WaveformSource;
}

export function channelForWaveformSource(source: WaveformSource): Channel | null {
  return source >= WaveformSource.Ch1 && source <= WaveformSource.Ch4
    ? source as number as Channel
    : null;
}

export function mathForWaveformSource(source: WaveformSource): MathChannel | null {
  return source >= WaveformSource.Math1 && source <= WaveformSource.Math4
    ? (source - 4) as MathChannel
    : null;
}

export function mathSourceForChannel(channel: Channel): MathSource {
  return channel as number as MathSource;
}

export function mathSourceForMath(math: MathChannel): MathSource {
  return (math + 4) as MathSource;
}

export enum ChannelCoupling {
  Ac = 1,
  Dc = 2,
  Ground = 3,
}

export enum ChannelBandwidthLimit {
  Off = 1,
  Mhz20 = 2,
}

export enum ChannelUnit {
  Volts = 1,
  Amps = 2,
  Watts = 3,
  Unknown = 4,
}

export interface ChannelState {
  channel: Channel;
  enabled: boolean;
  coupling: ChannelCoupling;
  bandwidthLimit: ChannelBandwidthLimit;
  unit: ChannelUnit;
  scale: number;
  offset: number;
  probeRatio: number;
}

export type ChannelStates = [
  ChannelState,
  ChannelState,
  ChannelState,
  ChannelState,
];

export interface MathState {
  math: MathChannel;
  enabled: boolean;
  operator: MathOperator;
  source1: MathSource;
  source2: MathSource | null;
  scale: number | null;
  offset: number | null;
}

export type MathStates = [MathState, MathState, MathState, MathState];

export enum TimebaseMode {
  Main = 1,
  Roll = 2,
  Xy = 3,
}

export interface HorizontalState {
  mode: TimebaseMode;
  scale: number;
  position: number;
}

export enum AcquisitionType {
  Normal = 1,
  Peak = 2,
  Average = 3,
  Ultra = 4,
}

export interface AcquisitionState {
  type: AcquisitionType;
  averages: number;
  memoryDepth: number;
  sampleRate: number;
}

export enum ScopeRunState {
  Triggered = 1,
  Waiting = 2,
  Running = 3,
  Auto = 4,
  Stopped = 5,
}

export enum TriggerType {
  Edge = 1,
  Pulse = 2,
  Slope = 3,
  Video = 4,
  Pattern = 5,
  Duration = 6,
  Timeout = 7,
  Runt = 8,
  Window = 9,
  Delay = 10,
  SetupHold = 11,
  NthEdge = 12,
  Rs232 = 13,
  I2c = 14,
  Spi = 15,
  Can = 16,
}

export enum TriggerSweep {
  Auto = 1,
  Normal = 2,
  Single = 3,
}

export enum EdgeSlope {
  Rising = 1,
  Falling = 2,
  Either = 3,
}

export enum TriggerCoupling {
  Ac = 1,
  Dc = 2,
  LowFrequencyReject = 3,
  HighFrequencyReject = 4,
}

export type OtherTriggerType =
  | TriggerType.Pulse
  | TriggerType.Slope
  | TriggerType.Video
  | TriggerType.Pattern
  | TriggerType.Duration
  | TriggerType.Timeout
  | TriggerType.Runt
  | TriggerType.Window
  | TriggerType.Delay
  | TriggerType.SetupHold
  | TriggerType.NthEdge
  | TriggerType.Rs232
  | TriggerType.I2c
  | TriggerType.Spi
  | TriggerType.Can;

export type TriggerState =
  | {
      type: TriggerType.Edge;
      sweep: TriggerSweep;
      source: Channel;
      slope: EdgeSlope;
      level: number;
      coupling: TriggerCoupling;
    }
  | {
      type: OtherTriggerType;
      sweep: TriggerSweep;
    };

export interface ScopeState {
  channels: ChannelStates;
  math: MathStates;
  horizontal: HorizontalState;
  acquisition: AcquisitionState;
  runState: ScopeRunState;
  trigger: TriggerState;
}

function mathSourceUnit(
  state: ScopeState,
  source: MathSource,
  visited: Set<MathChannel>,
): ChannelUnit {
  if (source >= MathSource.Ch1 && source <= MathSource.Ch4) {
    return state.channels[source - 1]?.unit ?? ChannelUnit.Unknown;
  }
  if (source >= MathSource.Math1 && source <= MathSource.Math4) {
    return mathOutputUnit(state, (source - 4) as MathChannel, visited);
  }
  return ChannelUnit.Unknown;
}

function mathOutputUnit(
  state: ScopeState,
  math: MathChannel,
  visited: Set<MathChannel>,
): ChannelUnit {
  if (visited.has(math)) return ChannelUnit.Unknown;
  const mathState = state.math[math - 1];
  if (mathState === undefined || mathState.math !== math) return ChannelUnit.Unknown;
  const nextVisited = new Set(visited);
  nextVisited.add(math);
  const first = mathSourceUnit(state, mathState.source1, nextVisited);
  const second = mathState.source2 === null
    ? ChannelUnit.Unknown
    : mathSourceUnit(state, mathState.source2, nextVisited);

  switch (mathState.operator) {
    case MathOperator.Add:
    case MathOperator.Subtract:
      return first === second ? first : ChannelUnit.Unknown;
    case MathOperator.Multiply:
      if (
        (first === ChannelUnit.Volts && second === ChannelUnit.Amps) ||
        (first === ChannelUnit.Amps && second === ChannelUnit.Volts)
      ) return ChannelUnit.Watts;
      return ChannelUnit.Unknown;
    case MathOperator.Divide:
      if (first === ChannelUnit.Watts && second === ChannelUnit.Amps) return ChannelUnit.Volts;
      if (first === ChannelUnit.Watts && second === ChannelUnit.Volts) return ChannelUnit.Amps;
      return ChannelUnit.Unknown;
    case MathOperator.Abs:
    case MathOperator.LowPass:
    case MathOperator.HighPass:
    case MathOperator.BandPass:
    case MathOperator.BandStop:
    case MathOperator.AxB:
      return first;
    default:
      return ChannelUnit.Unknown;
  }
}

export function waveformSourceUnit(state: ScopeState, source: WaveformSource): ChannelUnit {
  const channel = channelForWaveformSource(source);
  if (channel !== null) return state.channels[channel - 1]?.unit ?? ChannelUnit.Unknown;
  const math = mathForWaveformSource(source);
  return math === null ? ChannelUnit.Unknown : mathOutputUnit(state, math, new Set());
}

export enum MeasurementKind {
  Vpp = 1,
  Vmax = 2,
  Vmin = 3,
  Vavg = 4,
  Vrms = 5,
  Frequency = 6,
  Period = 7,
  Vtop = 8,
  Vbase = 9,
  Vamp = 10,
  Vupper = 11,
  Vmid = 12,
  Vlower = 13,
  Overshoot = 14,
  Preshoot = 15,
  RiseTime = 16,
  FallTime = 17,
  PositiveWidth = 18,
  NegativeWidth = 19,
  PositiveDuty = 20,
  NegativeDuty = 21,
  Tvmax = 22,
  Tvmin = 23,
}

export interface MeasurementSpec {
  kind: MeasurementKind;
  channel: WaveformSource;
}

export interface MeasurementStatistics {
  current: number;
  minimum: number;
  maximum: number;
  average: number;
  deviation: number;
  count: number;
}

export interface MeasurementValue extends MeasurementSpec {
  statistics: MeasurementStatistics;
}
