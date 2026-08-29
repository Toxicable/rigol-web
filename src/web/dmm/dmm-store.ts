import { create } from "zustand";

import {
  DmmRangeMode,
  type DmmControlChange,
  type DmmInfo,
  type DmmRange,
  type DmmReadingSnapshot,
  type DmmState,
} from "../../shared/dmm-types.js";

export enum DmmBrowserConnectionKind {
  Connecting = 1,
  AwaitingInstrument = 2,
  TransportDisconnected = 3,
  InstrumentDisconnected = 4,
  Connected = 5,
}

export type DmmBrowserConnection =
  | { kind: DmmBrowserConnectionKind.Connecting }
  | { kind: DmmBrowserConnectionKind.AwaitingInstrument }
  | { kind: DmmBrowserConnectionKind.TransportDisconnected; reason: string }
  | { kind: DmmBrowserConnectionKind.InstrumentDisconnected; reason: string }
  | {
      kind: DmmBrowserConnectionKind.Connected;
      info: DmmInfo;
      state: DmmState;
    };

export interface DmmControlOwnership {
  readonly token: number;
  readonly generation: number;
}

export interface DmmPendingControl extends DmmControlOwnership {
  readonly control: DmmControlChange;
}

export interface DmmStoreState {
  connection: DmmBrowserConnection;
  latestReading: DmmReadingSnapshot | null;
  pendingControl: DmmPendingControl | null;
  controlError: string | null;
  controlGeneration: number;
  setConnecting(): void;
  setAwaitingInstrument(): void;
  setTransportDisconnected(reason: string): void;
  setInstrumentDisconnected(reason: string): void;
  setConnected(info: DmmInfo, state: DmmState): void;
  replaceState(state: DmmState): void;
  setLatestReading(snapshot: DmmReadingSnapshot): void;
  beginControl(control: DmmControlChange): DmmControlOwnership;
  finishControl(ownership: DmmControlOwnership): void;
  failControl(ownership: DmmControlOwnership, error: string): void;
  clearControlError(): void;
}

let nextControlToken = 1;

export function sameDmmState(left: DmmState, right: DmmState): boolean {
  return left.function === right.function &&
    left.acquisitionRate === right.acquisitionRate &&
    sameDmmRange(left.range, right.range);
}

function sameDmmRange(left: DmmRange | null, right: DmmRange | null): boolean {
  if (left === null || right === null) {
    return left === right;
  }
  if (left.mode !== right.mode) {
    return false;
  }
  if (left.mode === DmmRangeMode.Auto || right.mode === DmmRangeMode.Auto) {
    return true;
  }
  return left.value === right.value;
}

function ownsPendingControl(
  pending: DmmPendingControl | null,
  ownership: DmmControlOwnership,
): boolean {
  return pending !== null &&
    pending.token === ownership.token &&
    pending.generation === ownership.generation;
}

export const useDmmStore = create<DmmStoreState>((set, get) => ({
  connection: { kind: DmmBrowserConnectionKind.Connecting },
  latestReading: null,
  pendingControl: null,
  controlError: null,
  controlGeneration: 0,

  setConnecting: () =>
    set((current) => ({
      connection: { kind: DmmBrowserConnectionKind.Connecting },
      latestReading: null,
      pendingControl: null,
      controlError: null,
      controlGeneration: current.controlGeneration + 1,
    })),

  setAwaitingInstrument: () =>
    set((current) => ({
      connection: { kind: DmmBrowserConnectionKind.AwaitingInstrument },
      latestReading: null,
      pendingControl: null,
      controlError: null,
      controlGeneration: current.controlGeneration + 1,
    })),

  setTransportDisconnected: (reason) =>
    set((current) => ({
      connection: { kind: DmmBrowserConnectionKind.TransportDisconnected, reason },
      latestReading: null,
      pendingControl: null,
      controlError: null,
      controlGeneration: current.controlGeneration + 1,
    })),

  setInstrumentDisconnected: (reason) =>
    set((current) => ({
      connection: { kind: DmmBrowserConnectionKind.InstrumentDisconnected, reason },
      latestReading: null,
      pendingControl: null,
      controlError: null,
      controlGeneration: current.controlGeneration + 1,
    })),

  setConnected: (info, state) =>
    set((current) => ({
      connection: { kind: DmmBrowserConnectionKind.Connected, info, state },
      latestReading: null,
      pendingControl: null,
      controlError: null,
      controlGeneration: current.controlGeneration + 1,
    })),

  replaceState: (state) =>
    set((current) => {
      if (current.connection.kind !== DmmBrowserConnectionKind.Connected) {
        return current;
      }
      const contextChanged = !sameDmmState(current.connection.state, state);
      return {
        connection: { ...current.connection, state },
        latestReading: contextChanged ? null : current.latestReading,
      };
    }),

  setLatestReading: (latestReading) =>
    set((current) => {
      if (
        current.connection.kind !== DmmBrowserConnectionKind.Connected ||
        latestReading.function !== current.connection.state.function
      ) {
        return current;
      }
      return { latestReading };
    }),

  beginControl: (control) => {
    const ownership: DmmControlOwnership = {
      token: nextControlToken,
      generation: get().controlGeneration,
    };
    nextControlToken += 1;
    set({
      pendingControl: { ...ownership, control },
      controlError: null,
    });
    return ownership;
  },

  finishControl: (ownership) =>
    set((current) => ownsPendingControl(current.pendingControl, ownership)
      ? { pendingControl: null }
      : current),

  failControl: (ownership, controlError) =>
    set((current) => ownsPendingControl(current.pendingControl, ownership)
      ? { pendingControl: null, controlError }
      : current),

  clearControlError: () => set({ controlError: null }),
}));
