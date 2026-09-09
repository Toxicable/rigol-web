import { create } from "zustand";

export enum AppTransportKind {
  Connecting = 1,
  Connected = 2,
  Disconnected = 3,
}

export type AppTransportState =
  | { kind: AppTransportKind.Connecting }
  | { kind: AppTransportKind.Connected }
  | { kind: AppTransportKind.Disconnected; reason: string };

export interface AppTransportStoreState {
  transport: AppTransportState;
  setConnecting(): void;
  setConnected(): void;
  setDisconnected(reason: string): void;
}

export const useAppTransportStore = create<AppTransportStoreState>((set) => ({
  transport: { kind: AppTransportKind.Connecting },
  setConnecting: () => set({ transport: { kind: AppTransportKind.Connecting } }),
  setConnected: () => set({ transport: { kind: AppTransportKind.Connected } }),
  setDisconnected: (reason) =>
    set({ transport: { kind: AppTransportKind.Disconnected, reason } }),
}));
