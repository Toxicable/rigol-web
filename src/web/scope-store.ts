import { create } from "zustand";

import {
  TriggerType,
  type ChannelStates,
  type MeasurementSpec,
  type MeasurementValue,
  type ScopeInfo,
  type ScopeState,
} from "../shared/scope-types.js";
import {
  ControlKind,
  type ControlChange,
  type DeepCaptureChannelInfo,
} from "../shared/websocket-protocol.js";

export enum BrowserConnectionKind {
  Connecting = 1,
  TransportDisconnected = 2,
  ScopeDisconnected = 3,
  ScopeConnected = 4,
}

export type BrowserConnection =
  | { kind: BrowserConnectionKind.Connecting }
  | { kind: BrowserConnectionKind.TransportDisconnected; reason: string }
  | { kind: BrowserConnectionKind.ScopeDisconnected; reason: string }
  | {
      kind: BrowserConnectionKind.ScopeConnected;
      info: ScopeInfo;
      scope: ScopeState;
    };

export enum DeepCaptureKind {
  None = 1,
  Capturing = 2,
  Ready = 3,
}

export type DeepCaptureState =
  | { kind: DeepCaptureKind.None }
  | { kind: DeepCaptureKind.Capturing; requestId: number }
  | {
      kind: DeepCaptureKind.Ready;
      captureId: number;
      channels: DeepCaptureChannelInfo[];
    };

export interface ScopeStoreState {
  connection: BrowserConnection;
  measurementSpecs: MeasurementSpec[];
  measurementValues: MeasurementValue[];
  deepCapture: DeepCaptureState;
  lastError: string | null;
  setConnecting(): void;
  setTransportDisconnected(reason: string): void;
  setScopeDisconnected(reason: string): void;
  setScopeConnected(info: ScopeInfo, scope: ScopeState): void;
  replaceScope(scope: ScopeState): void;
  applyOptimisticControl(control: ControlChange): void;
  setMeasurementSpecs(specs: MeasurementSpec[]): void;
  setMeasurementValues(values: MeasurementValue[]): void;
  setDeepCapturing(requestId: number): void;
  setDeepReady(captureId: number, channels: DeepCaptureChannelInfo[]): void;
  clearDeepCapture(): void;
  setError(error: string | null): void;
}

export function applyControlToScope(
  scope: ScopeState,
  control: ControlChange,
): ScopeState {
  switch (control.kind) {
    case ControlKind.ChannelEnabled:
    case ControlKind.ChannelScale:
    case ControlKind.ChannelOffset: {
      const channels = scope.channels.map((channel) => {
        if (channel.channel !== control.channel) {
          return channel;
        }

        switch (control.kind) {
          case ControlKind.ChannelEnabled:
            return { ...channel, enabled: control.value };
          case ControlKind.ChannelScale:
            return { ...channel, scale: control.value };
          case ControlKind.ChannelOffset:
            return { ...channel, offset: control.value };
          default:
            return channel;
        }
      }) as ChannelStates;

      return { ...scope, channels };
    }

    case ControlKind.HorizontalScale:
      return {
        ...scope,
        horizontal: { ...scope.horizontal, scale: control.value },
      };

    case ControlKind.HorizontalPosition:
      return {
        ...scope,
        horizontal: { ...scope.horizontal, position: control.value },
      };

    case ControlKind.TriggerType:
      // Edge needs source/slope/level fields that do not exist on non-Edge state.
      // Keep the current complete snapshot until the server returns authoritative Edge state.
      return scope;

    case ControlKind.TriggerLevel:
      if (scope.trigger.type !== TriggerType.Edge) {
        return scope;
      }
      return { ...scope, trigger: { ...scope.trigger, level: control.value } };

    case ControlKind.TriggerSource:
      if (scope.trigger.type !== TriggerType.Edge) {
        return scope;
      }
      return { ...scope, trigger: { ...scope.trigger, source: control.value } };

    case ControlKind.TriggerSlope:
      if (scope.trigger.type !== TriggerType.Edge) {
        return scope;
      }
      return { ...scope, trigger: { ...scope.trigger, slope: control.value } };
  }
}

export const useScopeStore = create<ScopeStoreState>((set) => ({
  connection: { kind: BrowserConnectionKind.Connecting },
  measurementSpecs: [],
  measurementValues: [],
  deepCapture: { kind: DeepCaptureKind.None },
  lastError: null,

  setConnecting: () =>
    set({ connection: { kind: BrowserConnectionKind.Connecting } }),

  setTransportDisconnected: (reason) =>
    set({
      connection: { kind: BrowserConnectionKind.TransportDisconnected, reason },
    }),

  setScopeDisconnected: (reason) =>
    set({ connection: { kind: BrowserConnectionKind.ScopeDisconnected, reason } }),

  setScopeConnected: (info, scope) =>
    set({
      connection: { kind: BrowserConnectionKind.ScopeConnected, info, scope },
      lastError: null,
    }),

  replaceScope: (scope) =>
    set((state) => {
      if (state.connection.kind !== BrowserConnectionKind.ScopeConnected) {
        return state;
      }
      return {
        connection: { ...state.connection, scope },
      };
    }),

  applyOptimisticControl: (control) =>
    set((state) => {
      if (state.connection.kind !== BrowserConnectionKind.ScopeConnected) {
        return state;
      }
      return {
        connection: {
          ...state.connection,
          scope: applyControlToScope(state.connection.scope, control),
        },
      };
    }),

  setMeasurementSpecs: (measurementSpecs) => set({ measurementSpecs }),
  setMeasurementValues: (measurementValues) => set({ measurementValues }),
  setDeepCapturing: (requestId) =>
    set({ deepCapture: { kind: DeepCaptureKind.Capturing, requestId } }),
  setDeepReady: (captureId, channels) =>
    set({ deepCapture: { kind: DeepCaptureKind.Ready, captureId, channels } }),
  clearDeepCapture: () => set({ deepCapture: { kind: DeepCaptureKind.None } }),
  setError: (lastError) => set({ lastError }),
}));
