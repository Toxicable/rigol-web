export type AcquisitionOperationId = number;

export enum AcquisitionOperationState {
  Running = 1,
  Stopped = 2,
  Failed = 3,
}

export enum AcquisitionInitiatorKind {
  Server = 1,
  Browser = 2,
}

export type AcquisitionInitiator =
  | { kind: AcquisitionInitiatorKind.Server }
  | { kind: AcquisitionInitiatorKind.Browser; sessionId: number };

export interface AcquisitionProgress {
  receivedItems: number;
  sourceLostItems: number;
  lastSequence: number | null;
}

interface AcquisitionOperationBase {
  id: AcquisitionOperationId;
  label: string;
  initiator: AcquisitionInitiator;
  startedAtUnixMs: number;
  progress: AcquisitionProgress;
}

export interface RunningAcquisitionOperation extends AcquisitionOperationBase {
  state: AcquisitionOperationState.Running;
}

export interface StoppedAcquisitionOperation extends AcquisitionOperationBase {
  state: AcquisitionOperationState.Stopped;
  stoppedAtUnixMs: number;
}

export interface FailedAcquisitionOperation extends AcquisitionOperationBase {
  state: AcquisitionOperationState.Failed;
  stoppedAtUnixMs: number;
  failure: string;
}

export type AcquisitionOperation =
  | RunningAcquisitionOperation
  | StoppedAcquisitionOperation
  | FailedAcquisitionOperation;
