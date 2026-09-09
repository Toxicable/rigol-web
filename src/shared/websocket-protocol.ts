import type { AcquisitionOperation } from "./acquisition-types.js";
import type {
  DmmControlChange,
  DmmInfo,
  DmmReadingSnapshot,
  DmmState,
} from "./dmm-types.js";
import type { ScpiInstrument, SupportedInstrument } from "./instrument-types.js";
import type {
  Ppk2CaptureStats,
  Ppk2Info,
  Ppk2LiveUpdate,
  Ppk2Viewport,
} from "./ppk2-types.js";
import type {
  AcquisitionType,
  Channel,
  ChannelBandwidthLimit,
  ChannelCoupling,
  ChannelUnit,
  EdgeSlope,
  MeasurementSpec,
  MeasurementValue,
  ScopeInfo,
  ScopeState,
  TimebaseMode,
  TriggerCoupling,
  TriggerSweep,
  TriggerType,
} from "./scope-types.js";

export const PROTOCOL_VERSION = 10;

export type NonEmptyArray<T> = [T, ...T[]];

export enum MessageType {
  ScopeConnected = 1,
  ScopeState = 2,
  ScopeDisconnected = 3,

  ControlSet = 10,
  InteractionUpdate = 11,
  InteractionCommit = 12,
  AcquisitionAction = 13,
  DeepCaptureRequest = 14,
  WaveformViewportRequest = 15,
  ScpiExecute = 16,
  MeasurementRead = 17,
  MeasurementSet = 18,
  ScopeSleep = 19,

  CommandCompleted = 20,
  CommandFailed = 21,
  ScpiResult = 22,
  MeasurementResult = 23,
  DeepCaptureReady = 24,
  ProtocolHello = 25,
  ProtocolHelloAck = 26,

  InstrumentSubscribe = 30,
  InstrumentUnsubscribe = 31,

  DmmConnected = 40,
  DmmState = 41,
  DmmDisconnected = 42,
  DmmSnapshot = 43,

  DmmControlSet = 50,

  AcquisitionOperationStart = 60,
  AcquisitionOperationStop = 61,
  AcquisitionOperationGet = 62,
  AcquisitionOperationList = 63,
  AcquisitionOperationResult = 64,
  AcquisitionOperationListResult = 65,

  Ppk2Connected = 70,
  Ppk2Disconnected = 71,
  Ppk2Stats = 72,
  Ppk2Live = 73,
  Ppk2CaptureStart = 74,
  Ppk2CaptureStop = 75,
  Ppk2ViewportRequest = 76,
  Ppk2ViewportResult = 77,
}

export enum AcquisitionAction {
  Run = 1,
  Stop = 2,
  Single = 3,
}

export enum WaveformKind {
  Live = 1,
  DeepViewport = 2,
}

export enum ControlKind {
  ChannelEnabled = 1,
  ChannelScale = 2,
  ChannelOffset = 3,
  HorizontalScale = 4,
  HorizontalPosition = 5,
  TriggerLevel = 6,
  TriggerType = 7,
  TriggerSource = 8,
  TriggerSlope = 9,
  ChannelCoupling = 10,
  ChannelProbeRatio = 11,
  HorizontalMode = 12,
  TriggerSweep = 13,
  TriggerCoupling = 14,
  AcquisitionType = 15,
  AcquisitionAverages = 16,
  AcquisitionMemoryDepth = 17,
  ChannelBandwidthLimit = 18,
}

export type ControlChange =
  | {
      kind: ControlKind.ChannelEnabled;
      channel: Channel;
      value: boolean;
    }
  | {
      kind: ControlKind.ChannelScale;
      channel: Channel;
      value: number;
    }
  | {
      kind: ControlKind.ChannelOffset;
      channel: Channel;
      value: number;
    }
  | {
      kind: ControlKind.ChannelCoupling;
      channel: Channel;
      value: ChannelCoupling;
    }
  | {
      kind: ControlKind.ChannelProbeRatio;
      channel: Channel;
      value: number;
    }
  | {
      kind: ControlKind.ChannelBandwidthLimit;
      channel: Channel;
      value: ChannelBandwidthLimit;
    }
  | {
      kind: ControlKind.HorizontalScale;
      value: number;
    }
  | {
      kind: ControlKind.HorizontalPosition;
      value: number;
    }
  | {
      kind: ControlKind.HorizontalMode;
      value: TimebaseMode;
    }
  | {
      kind: ControlKind.TriggerLevel;
      value: number;
    }
  | {
      kind: ControlKind.TriggerType;
      value: TriggerType.Edge;
    }
  | {
      kind: ControlKind.TriggerSource;
      value: Channel;
    }
  | {
      kind: ControlKind.TriggerSlope;
      value: EdgeSlope;
    }
  | {
      kind: ControlKind.TriggerSweep;
      value: TriggerSweep;
    }
  | {
      kind: ControlKind.TriggerCoupling;
      value: TriggerCoupling;
    }
  | {
      kind: ControlKind.AcquisitionType;
      value: AcquisitionType;
    }
  | {
      kind: ControlKind.AcquisitionAverages;
      value: number;
    }
  | {
      kind: ControlKind.AcquisitionMemoryDepth;
      value: number;
    };

export type InteractiveControl =
  | Extract<ControlChange, { kind: ControlKind.ChannelScale }>
  | Extract<ControlChange, { kind: ControlKind.ChannelOffset }>
  | Extract<ControlChange, { kind: ControlKind.HorizontalScale }>
  | Extract<ControlChange, { kind: ControlKind.HorizontalPosition }>
  | Extract<ControlChange, { kind: ControlKind.TriggerLevel }>;

export interface ProtocolHelloMessage {
  type: MessageType.ProtocolHello;
  protocolVersion: number;
}

export interface ProtocolHelloAckMessage {
  type: MessageType.ProtocolHelloAck;
  protocolVersion: number;
}

export interface InstrumentSubscribeMessage {
  type: MessageType.InstrumentSubscribe;
  instrument: SupportedInstrument;
}

export interface InstrumentUnsubscribeMessage {
  type: MessageType.InstrumentUnsubscribe;
  instrument: SupportedInstrument;
}

export interface ControlSetMessage {
  type: MessageType.ControlSet;
  requestId: number;
  control: ControlChange;
}

export interface InteractionUpdateMessage {
  type: MessageType.InteractionUpdate;
  control: InteractiveControl;
}

export interface InteractionCommitMessage {
  type: MessageType.InteractionCommit;
  requestId: number;
  control: InteractiveControl;
}

export interface AcquisitionActionMessage {
  type: MessageType.AcquisitionAction;
  requestId: number;
  action: AcquisitionAction;
}

export interface ScopeSleepMessage {
  type: MessageType.ScopeSleep;
  requestId: number;
}

export interface MeasurementReadMessage {
  type: MessageType.MeasurementRead;
  requestId: number;
  measurements: NonEmptyArray<MeasurementSpec>;
}

export interface MeasurementResultMessage {
  type: MessageType.MeasurementResult;
  requestId: number;
  values: MeasurementValue[];
}

export interface MeasurementSetMessage {
  type: MessageType.MeasurementSet;
  requestId: number;
  measurements: MeasurementSpec[];
}

export interface DeepCaptureRequestMessage {
  type: MessageType.DeepCaptureRequest;
  requestId: number;
}

export interface DeepCaptureChannelInfo {
  channel: Channel;
  unit: ChannelUnit;
  sampleCount: number;
  xIncrement: number;
  xOrigin: number;
  xReference: number;
}

export interface DeepCaptureReadyMessage {
  type: MessageType.DeepCaptureReady;
  requestId: number;
  captureId: number;
  channels: NonEmptyArray<DeepCaptureChannelInfo>;
}

export interface WaveformViewportRequestMessage {
  type: MessageType.WaveformViewportRequest;
  requestId: number;
  captureId: number;
  channel: Channel;
  startSample: number;
  endSample: number;
  pixelWidth: number;
}

export interface ScpiExecuteMessage {
  type: MessageType.ScpiExecute;
  requestId: number;
  instrument: ScpiInstrument;
  command: string;
}

export interface ScpiResultMessage {
  type: MessageType.ScpiResult;
  requestId: number;
  response: string;
}

export interface ScopeConnectedMessage {
  type: MessageType.ScopeConnected;
  protocolVersion: number;
  info: ScopeInfo;
  state: ScopeState;
}

export interface ScopeStateMessage {
  type: MessageType.ScopeState;
  state: ScopeState;
}

export interface ScopeDisconnectedMessage {
  type: MessageType.ScopeDisconnected;
  reason: string;
}

export type ScopeLifecycleMessage =
  | ScopeConnectedMessage
  | ScopeStateMessage
  | ScopeDisconnectedMessage;

export interface DmmConnectedMessage {
  type: MessageType.DmmConnected;
  protocolVersion: number;
  info: DmmInfo;
  state: DmmState;
}

export interface DmmStateMessage {
  type: MessageType.DmmState;
  state: DmmState;
}

export interface DmmDisconnectedMessage {
  type: MessageType.DmmDisconnected;
  reason: string;
}

export interface DmmSnapshotMessage {
  type: MessageType.DmmSnapshot;
  snapshot: DmmReadingSnapshot;
}

export interface DmmControlSetMessage {
  type: MessageType.DmmControlSet;
  requestId: number;
  control: DmmControlChange;
}

export type DmmLifecycleMessage =
  | DmmConnectedMessage
  | DmmStateMessage
  | DmmDisconnectedMessage
  | DmmSnapshotMessage;

export interface AcquisitionOperationStartMessage {
  type: MessageType.AcquisitionOperationStart;
  requestId: number;
  label: string;
}

export interface AcquisitionOperationStopMessage {
  type: MessageType.AcquisitionOperationStop;
  requestId: number;
  operationId: number;
}

export interface AcquisitionOperationGetMessage {
  type: MessageType.AcquisitionOperationGet;
  requestId: number;
  operationId: number;
}

export interface AcquisitionOperationListMessage {
  type: MessageType.AcquisitionOperationList;
  requestId: number;
}

export interface AcquisitionOperationResultMessage {
  type: MessageType.AcquisitionOperationResult;
  requestId: number;
  operation: AcquisitionOperation;
}

export interface AcquisitionOperationListResultMessage {
  type: MessageType.AcquisitionOperationListResult;
  requestId: number;
  operations: AcquisitionOperation[];
}

export interface Ppk2ConnectedMessage {
  type: MessageType.Ppk2Connected;
  protocolVersion: number;
  info: Ppk2Info;
}

export interface Ppk2DisconnectedMessage {
  type: MessageType.Ppk2Disconnected;
  reason: string;
}

export type Ppk2LifecycleMessage = Ppk2ConnectedMessage | Ppk2DisconnectedMessage;

export interface Ppk2StatsMessage {
  type: MessageType.Ppk2Stats;
  stats: Ppk2CaptureStats;
}

export interface Ppk2LiveMessage {
  type: MessageType.Ppk2Live;
  update: Ppk2LiveUpdate;
}

export interface Ppk2CaptureStartMessage {
  type: MessageType.Ppk2CaptureStart;
  requestId: number;
}

export interface Ppk2CaptureStopMessage {
  type: MessageType.Ppk2CaptureStop;
  requestId: number;
  operationId: number;
}

export interface Ppk2ViewportRequestMessage {
  type: MessageType.Ppk2ViewportRequest;
  requestId: number;
  operationId: number;
  firstSequence: number;
  endSequenceExclusive: number;
  maxBuckets: number;
}

export interface Ppk2ViewportResultMessage {
  type: MessageType.Ppk2ViewportResult;
  requestId: number;
  viewport: Ppk2Viewport;
}

export interface CommandCompletedMessage {
  type: MessageType.CommandCompleted;
  requestId: number;
}

export interface CommandFailedMessage {
  type: MessageType.CommandFailed;
  requestId: number;
  error: string;
}

export type CommandResult = CommandCompletedMessage | CommandFailedMessage;

export type ClientMessage =
  | ProtocolHelloAckMessage
  | InstrumentSubscribeMessage
  | InstrumentUnsubscribeMessage
  | ControlSetMessage
  | InteractionUpdateMessage
  | InteractionCommitMessage
  | AcquisitionActionMessage
  | ScopeSleepMessage
  | DeepCaptureRequestMessage
  | WaveformViewportRequestMessage
  | ScpiExecuteMessage
  | MeasurementReadMessage
  | MeasurementSetMessage
  | DmmControlSetMessage
  | AcquisitionOperationStartMessage
  | AcquisitionOperationStopMessage
  | AcquisitionOperationGetMessage
  | AcquisitionOperationListMessage
  | Ppk2CaptureStartMessage
  | Ppk2CaptureStopMessage
  | Ppk2ViewportRequestMessage;

export type ServerJsonMessage =
  | ProtocolHelloMessage
  | ScopeLifecycleMessage
  | DmmLifecycleMessage
  | Ppk2LifecycleMessage
  | Ppk2StatsMessage
  | Ppk2LiveMessage
  | CommandResult
  | ScpiResultMessage
  | MeasurementResultMessage
  | DeepCaptureReadyMessage
  | AcquisitionOperationResultMessage
  | AcquisitionOperationListResultMessage
  | Ppk2ViewportResultMessage;
