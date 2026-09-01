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

export enum ChannelCoupling {
  Ac = 1,
  Dc = 2,
  Ground = 3,
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
  horizontal: HorizontalState;
  acquisition: AcquisitionState;
  runState: ScopeRunState;
  trigger: TriggerState;
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
  channel: Channel;
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
