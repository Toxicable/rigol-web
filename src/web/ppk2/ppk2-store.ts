import { create } from "zustand";

import type {
  Ppk2CaptureStats,
  Ppk2Info,
  Ppk2LiveUpdate,
  Ppk2Viewport,
} from "../../shared/ppk2-types.js";

const MAX_LIVE_BUCKETS = 5_000;

export enum Ppk2BrowserConnectionKind {
  AwaitingInstrument = 1,
  InstrumentDisconnected = 2,
  Connected = 3,
}

export type Ppk2BrowserConnection =
  | { kind: Ppk2BrowserConnectionKind.AwaitingInstrument }
  | { kind: Ppk2BrowserConnectionKind.InstrumentDisconnected; reason: string }
  | { kind: Ppk2BrowserConnectionKind.Connected; info: Ppk2Info };

export type Ppk2RequestKind = "start" | "stop" | "viewport";

export interface Ppk2RequestOwnership {
  token: number;
  kind: Ppk2RequestKind;
}

export interface Ppk2StoreState {
  connection: Ppk2BrowserConnection;
  stats: Ppk2CaptureStats;
  liveBuckets: Ppk2LiveUpdate["buckets"];
  viewport: Ppk2Viewport | null;
  pendingRequest: Ppk2RequestOwnership | null;
  requestError: string | null;
  setAwaitingInstrument(): void;
  setInstrumentDisconnected(reason: string): void;
  setConnected(info: Ppk2Info): void;
  replaceStats(stats: Ppk2CaptureStats): void;
  appendLive(update: Ppk2LiveUpdate): void;
  replaceViewport(viewport: Ppk2Viewport): void;
  beginRequest(kind: Ppk2RequestKind): Ppk2RequestOwnership;
  finishRequest(ownership: Ppk2RequestOwnership): void;
  failRequest(ownership: Ppk2RequestOwnership, error: string): void;
  clearRequestError(): void;
}

let nextRequestToken = 1;

function emptyStats(): Ppk2CaptureStats {
  return {
    operation: null,
    receivedSamples: 0,
    lostSamples: 0,
    retainedSamples: 0,
    retainedSeconds: 0,
    latestSequence: null,
    latestCurrentUa: null,
    minCurrentUa: null,
    maxCurrentUa: null,
    meanCurrentUa: null,
    rmsCurrentUa: null,
    chargeMicroampHours: 0,
  };
}

function operationId(stats: Ppk2CaptureStats): number | null {
  return stats.operation?.id ?? null;
}

function ownsRequest(
  pending: Ppk2RequestOwnership | null,
  ownership: Ppk2RequestOwnership,
): boolean {
  return pending?.token === ownership.token;
}

export const usePpk2Store = create<Ppk2StoreState>((set) => ({
  connection: { kind: Ppk2BrowserConnectionKind.AwaitingInstrument },
  stats: emptyStats(),
  liveBuckets: [],
  viewport: null,
  pendingRequest: null,
  requestError: null,

  setAwaitingInstrument: () => set({
    connection: { kind: Ppk2BrowserConnectionKind.AwaitingInstrument },
  }),

  setInstrumentDisconnected: (reason) => set({
    connection: { kind: Ppk2BrowserConnectionKind.InstrumentDisconnected, reason },
  }),

  setConnected: (info) => set({
    connection: { kind: Ppk2BrowserConnectionKind.Connected, info },
  }),

  replaceStats: (stats) => set((current) => {
    const operationChanged = operationId(current.stats) !== operationId(stats);
    return {
      stats,
      liveBuckets: operationChanged ? [] : current.liveBuckets,
      viewport: operationChanged ? null : current.viewport,
    };
  }),

  appendLive: (update) => set((current) => {
    if (operationId(current.stats) !== update.operationId) {
      return current;
    }
    const combined = [...current.liveBuckets, ...update.buckets];
    return {
      liveBuckets: combined.length <= MAX_LIVE_BUCKETS
        ? combined
        : combined.slice(combined.length - MAX_LIVE_BUCKETS),
      viewport: null,
    };
  }),

  replaceViewport: (viewport) => set((current) => {
    if (operationId(current.stats) !== viewport.operationId) {
      return current;
    }
    return { viewport };
  }),

  beginRequest: (kind) => {
    const ownership = { token: nextRequestToken, kind };
    nextRequestToken += 1;
    set({ pendingRequest: ownership, requestError: null });
    return ownership;
  },

  finishRequest: (ownership) => set((current) =>
    ownsRequest(current.pendingRequest, ownership)
      ? { pendingRequest: null }
      : current),

  failRequest: (ownership, requestError) => set((current) =>
    ownsRequest(current.pendingRequest, ownership)
      ? { pendingRequest: null, requestError }
      : current),

  clearRequestError: () => set({ requestError: null }),
}));
