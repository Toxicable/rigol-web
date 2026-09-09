import type { AcquisitionOperation } from "./acquisition-types.js";

export const PPK2_SAMPLE_INTERVAL_US = 10;
export const PPK2_SAMPLE_RATE_HZ = 100_000;

export interface Ppk2Info {
  sourceSessionId: number;
  hardwareRevision: string | null;
  calibrated: string | null;
  vddMv: number;
  sampleIntervalUs: typeof PPK2_SAMPLE_INTERVAL_US;
}

export enum Ppk2ConnectionKind {
  Disconnected = 1,
  Connected = 2,
}

export type Ppk2Connection =
  | {
      kind: Ppk2ConnectionKind.Disconnected;
      reason: string;
    }
  | {
      kind: Ppk2ConnectionKind.Connected;
      info: Ppk2Info;
    };

export interface Ppk2CaptureStats {
  operation: AcquisitionOperation | null;
  receivedSamples: number;
  lostSamples: number;
  retainedSamples: number;
  retainedSeconds: number;
  latestSequence: number | null;
  latestCurrentUa: number | null;
  minCurrentUa: number | null;
  maxCurrentUa: number | null;
  meanCurrentUa: number | null;
  rmsCurrentUa: number | null;
  chargeMicroampHours: number;
}

export interface Ppk2DisplayBucket {
  firstSequence: number;
  lastSequence: number;
  sampleCount: number;
  minCurrentUa: number;
  maxCurrentUa: number;
  meanCurrentUa: number;
  logicOr: number;
  logicAnd: number;
}

export interface Ppk2Viewport {
  operationId: number;
  requestedFirstSequence: number;
  requestedEndSequenceExclusive: number;
  firstAvailableSequence: number | null;
  endAvailableSequenceExclusive: number | null;
  buckets: readonly Ppk2DisplayBucket[];
}
