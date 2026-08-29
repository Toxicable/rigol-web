import { create } from "zustand";

import type {
  DmmControlChange,
  DmmInfo,
  DmmReadingSnapshot,
  DmmState,
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

export interface DmmStoreState {
  connection: DmmBrowserConnection;
  latestReading: DmmReadingSnapshot | null;
  pendingControl: DmmControlChange | null;
  controlError: string | null;
  setConnecting(): void;
  setAwaitingInstrument(): void;
  setTransportDisconnected(reason: string): void;
  setInstrumentDisconnected(reason: string): void;
  setConnected(info: DmmInfo, state: DmmState): void;
  replaceState(state: DmmState): void;
  setLatestReading(snapshot: DmmReadingSnapshot): void;
  beginControl(control: DmmControlChange): void;
  finishControl(): void;
  failControl(error: string): void;
  clearControlError(): void;
}

export const useDmmStore = create<DmmStoreState>((set) => ({
  connection: { kind: DmmBrowserConnectionKind.Connecting },
  latestReading: null,
  pendingControl: null,
  controlError: null,

  setConnecting: () =>
    set({
      connection: { kind: DmmBrowserConnectionKind.Connecting },
      latestReading: null,
      pendingControl: null,
      controlError: null,
    }),

  setAwaitingInstrument: () =>
    set({
      connection: { kind: DmmBrowserConnectionKind.AwaitingInstrument },
      latestReading: null,
      pendingControl: null,
    }),

  setTransportDisconnected: (reason) =>
    set({
      connection: { kind: DmmBrowserConnectionKind.TransportDisconnected, reason },
      latestReading: null,
      pendingControl: null,
    }),

  setInstrumentDisconnected: (reason) =>
    set({
      connection: { kind: DmmBrowserConnectionKind.InstrumentDisconnected, reason },
      latestReading: null,
      pendingControl: null,
    }),

  setConnected: (info, state) =>
    set({
      connection: { kind: DmmBrowserConnectionKind.Connected, info, state },
      latestReading: null,
      pendingControl: null,
      controlError: null,
    }),

  replaceState: (state) =>
    set((current) => {
      if (current.connection.kind !== DmmBrowserConnectionKind.Connected) {
        return current;
      }
      return {
        connection: { ...current.connection, state },
        latestReading: current.latestReading?.function === state.function
          ? current.latestReading
          : null,
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

  beginControl: (pendingControl) => set({ pendingControl, controlError: null }),
  finishControl: () => set({ pendingControl: null }),
  failControl: (controlError) => set({ pendingControl: null, controlError }),
  clearControlError: () => set({ controlError: null }),
}));
