import type {
  Channel,
  ChannelUnit,
  EdgeSlope,
  MeasurementSpec,
  MeasurementValue,
  ScopeInfo,
  ScopeState,
  TriggerType,
} from "./scope-types.js";

export const PROTOCOL_VERSION = 1;

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

  CommandCompleted = 20,
  CommandFailed = 21,
  ScpiResult = 22,
  MeasurementResult = 23,
  DeepCaptureReady = 24,
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
      kind: ControlKind.HorizontalScale;
      value: number;
    }
  | {
      kind: ControlKind.HorizontalPosition;
      value: number;
    }
  | {
      kind: ControlKind.TriggerLevel;
      value: number;
    }
  | {
      kind: ControlKind.TriggerType;
      value: TriggerType;
    }
  | {
      kind: ControlKind.TriggerSource;
      value: Channel;
    }
  | {
      kind: ControlKind.TriggerSlope;
      value: EdgeSlope;
    };

export type InteractiveControl =
  | Extract<ControlChange, { kind: ControlKind.ChannelScale }>
  | Extract<ControlChange, { kind: ControlKind.ChannelOffset }>
  | Extract<ControlChange, { kind: ControlKind.HorizontalScale }>
  | Extract<ControlChange, { kind: ControlKind.HorizontalPosition }>
  | Extract<ControlChange, { kind: ControlKind.TriggerLevel }>;

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

export interface MeasurementReadMessage {
  type: MessageType.MeasurementRead;
  requestId: number;
  measurements: MeasurementSpec[];
}

export interface MeasurementResultMessage {
  type: MessageType.MeasurementResult;
  requestId: number;
  values: MeasurementValue[];
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
  channels: DeepCaptureChannelInfo[];
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
  | ControlSetMessage
  | InteractionUpdateMessage
  | InteractionCommitMessage
  | AcquisitionActionMessage
  | DeepCaptureRequestMessage
  | WaveformViewportRequestMessage
  | ScpiExecuteMessage
  | MeasurementReadMessage;

export type ServerJsonMessage =
  | ScopeLifecycleMessage
  | CommandResult
  | ScpiResultMessage
  | MeasurementResultMessage
  | DeepCaptureReadyMessage;
