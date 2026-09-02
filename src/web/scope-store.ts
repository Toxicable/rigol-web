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
  type NonEmptyArray,
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

export enum MeasurementSource {
  Scope = 1,
  Local = 2,
}

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
      channels: NonEmptyArray<DeepCaptureChannelInfo>;
      position: number;
      scale: number;
    };

export interface ScopeStoreState {
  connection: BrowserConnection;
  measurementSource: MeasurementSource;
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
  setMeasurementSource(source: MeasurementSource): void;
  setMeasurementSpecs(specs: MeasurementSpec[]): void;
  setMeasurementValues(values: MeasurementValue[]): void;
  setLocalMeasurementValues(values: MeasurementValue[]): void;
  setDeepCapturing(requestId: number): void;
  setDeepReady(
    captureId: number,
    channels: NonEmptyArray<DeepCaptureChannelInfo>,
  ): void;
  setDeepHorizontal(position: number, scale: number): void;
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

const noDeepCapture = (): DeepCaptureState => ({ kind: DeepCaptureKind.None });

export const useScopeStore = create<ScopeStoreState>((set) => ({
  connection: { kind: BrowserConnectionKind.Connecting },
  measurementSource: MeasurementSource.Scope,
  measurementSpecs: [],
  measurementValues: [],
  deepCapture: noDeepCapture(),
  lastError: null,

  setConnecting: () =>
    set({
      connection: { kind: BrowserConnectionKind.Connecting },
      deepCapture: noDeepCapture(),
      measurementValues: [],
    }),

  setTransportDisconnected: (reason) =>
    set({
      connection: { kind: BrowserConnectionKind.TransportDisconnected, reason },
      deepCapture: noDeepCapture(),
      measurementValues: [],
    }),

  setScopeDisconnected: (reason) =>
    set({
      connection: { kind: BrowserConnectionKind.ScopeDisconnected, reason },
      deepCapture: noDeepCapture(),
      measurementValues: [],
    }),

  setScopeConnected: (info, scope) =>
    set({
      connection: { kind: BrowserConnectionKind.ScopeConnected, info, scope },
      deepCapture: noDeepCapture(),
      measurementValues: [],
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

  setMeasurementSource: (measurementSource) =>
    set({ measurementSource, measurementValues: [] }),
  setMeasurementSpecs: (measurementSpecs) => set({ measurementSpecs }),
  setMeasurementValues: (measurementValues) =>
    set((state) =>
      state.measurementSource === MeasurementSource.Scope ? { measurementValues } : state,
    ),
  setLocalMeasurementValues: (measurementValues) =>
    set((state) =>
      state.measurementSource === MeasurementSource.Local ? { measurementValues } : state,
    ),
  setDeepCapturing: (requestId) =>
    set({ deepCapture: { kind: DeepCaptureKind.Capturing, requestId } }),
  setDeepReady: (captureId, channels) =>
    set((state) => {
      if (state.connection.kind !== BrowserConnectionKind.ScopeConnected) {
        throw new Error("Deep capture became ready without a connected scope");
      }
      return {
        deepCapture: {
          kind: DeepCaptureKind.Ready,
          captureId,
          channels,
          position: state.connection.scope.horizontal.position,
          scale: state.connection.scope.horizontal.scale,
        },
      };
    }),
  setDeepHorizontal: (position, scale) => {
    if (!Number.isFinite(position) || !Number.isFinite(scale) || !(scale > 0)) {
      throw new Error("Deep horizontal position must be finite and scale must be positive");
    }
    set((state) => {
      if (state.deepCapture.kind !== DeepCaptureKind.Ready) {
        return state;
      }
      return {
        deepCapture: { ...state.deepCapture, position, scale },
      };
    });
  },
  clearDeepCapture: () => set({ deepCapture: noDeepCapture() }),
  setError: (lastError) => set({ lastError }),
}));
