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
  AwaitingInstrument = 1,
  ScopeDisconnected = 2,
  ScopeConnected = 3,
}

export type BrowserConnection =
  | { kind: BrowserConnectionKind.AwaitingInstrument }
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
  sleepPending: boolean;
  lastError: string | null;
  setAwaitingInstrument(): void;
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

export function applyControlToScope(scope: ScopeState, control: ControlChange): ScopeState {
  switch (control.kind) {
    case ControlKind.ChannelEnabled:
    case ControlKind.ChannelScale:
    case ControlKind.ChannelOffset:
    case ControlKind.ChannelCoupling:
    case ControlKind.ChannelProbeRatio: {
      const channels = scope.channels.map((channel) => {
        if (channel.channel !== control.channel) return channel;
        switch (control.kind) {
          case ControlKind.ChannelEnabled: return { ...channel, enabled: control.value };
          case ControlKind.ChannelScale: return { ...channel, scale: control.value };
          case ControlKind.ChannelOffset: return { ...channel, offset: control.value };
          case ControlKind.ChannelCoupling: return { ...channel, coupling: control.value };
          case ControlKind.ChannelProbeRatio: return { ...channel, probeRatio: control.value };
          default: return channel;
        }
      }) as ChannelStates;
      return { ...scope, channels };
    }
    case ControlKind.HorizontalScale:
      return { ...scope, horizontal: { ...scope.horizontal, scale: control.value } };
    case ControlKind.HorizontalPosition:
      return { ...scope, horizontal: { ...scope.horizontal, position: control.value } };
    case ControlKind.HorizontalMode:
      return { ...scope, horizontal: { ...scope.horizontal, mode: control.value } };
    case ControlKind.AcquisitionType:
      return { ...scope, acquisition: { ...scope.acquisition, type: control.value } };
    case ControlKind.AcquisitionAverages:
      return { ...scope, acquisition: { ...scope.acquisition, averages: control.value } };
    case ControlKind.AcquisitionMemoryDepth:
      return { ...scope, acquisition: { ...scope.acquisition, memoryDepth: control.value } };
    case ControlKind.TriggerType:
      return scope;
    case ControlKind.TriggerSweep:
      return { ...scope, trigger: { ...scope.trigger, sweep: control.value } };
    case ControlKind.TriggerLevel:
      if (scope.trigger.type !== TriggerType.Edge) return scope;
      return { ...scope, trigger: { ...scope.trigger, level: control.value } };
    case ControlKind.TriggerSource:
      if (scope.trigger.type !== TriggerType.Edge) return scope;
      return { ...scope, trigger: { ...scope.trigger, source: control.value } };
    case ControlKind.TriggerSlope:
      if (scope.trigger.type !== TriggerType.Edge) return scope;
      return { ...scope, trigger: { ...scope.trigger, slope: control.value } };
    case ControlKind.TriggerCoupling:
      if (scope.trigger.type !== TriggerType.Edge) return scope;
      return { ...scope, trigger: { ...scope.trigger, coupling: control.value } };
  }
}

const noDeepCapture = (): DeepCaptureState => ({ kind: DeepCaptureKind.None });

export const useScopeStore = create<ScopeStoreState>((set) => ({
  connection: { kind: BrowserConnectionKind.AwaitingInstrument },
  measurementSource: MeasurementSource.Scope,
  measurementSpecs: [],
  measurementValues: [],
  deepCapture: noDeepCapture(),
  sleepPending: false,
  lastError: null,
  setAwaitingInstrument: () => set({ connection: { kind: BrowserConnectionKind.AwaitingInstrument }, deepCapture: noDeepCapture(), measurementValues: [], sleepPending: false }),
  setScopeDisconnected: (reason) => set({ connection: { kind: BrowserConnectionKind.ScopeDisconnected, reason }, deepCapture: noDeepCapture(), measurementValues: [], sleepPending: false }),
  setScopeConnected: (info, scope) => set({ connection: { kind: BrowserConnectionKind.ScopeConnected, info, scope }, deepCapture: noDeepCapture(), measurementValues: [], sleepPending: false, lastError: null }),
  replaceScope: (scope) => set((state) => state.connection.kind === BrowserConnectionKind.ScopeConnected ? { connection: { ...state.connection, scope } } : state),
  applyOptimisticControl: (control) => set((state) => state.connection.kind === BrowserConnectionKind.ScopeConnected ? { connection: { ...state.connection, scope: applyControlToScope(state.connection.scope, control) } } : state),
  setMeasurementSource: (measurementSource) => set({ measurementSource, measurementValues: [] }),
  setMeasurementSpecs: (measurementSpecs) => set({ measurementSpecs }),
  setMeasurementValues: (measurementValues) => set((state) => state.measurementSource === MeasurementSource.Scope ? { measurementValues } : state),
  setLocalMeasurementValues: (measurementValues) => set((state) => state.measurementSource === MeasurementSource.Local ? { measurementValues } : state),
  setDeepCapturing: (requestId) => set({ deepCapture: { kind: DeepCaptureKind.Capturing, requestId } }),
  setDeepReady: (captureId, channels) => set((state) => {
    if (state.connection.kind !== BrowserConnectionKind.ScopeConnected) throw new Error("Deep capture became ready without a connected scope");
    return { deepCapture: { kind: DeepCaptureKind.Ready, captureId, channels, position: state.connection.scope.horizontal.position, scale: state.connection.scope.horizontal.scale } };
  }),
  setDeepHorizontal: (position, scale) => {
    if (!Number.isFinite(position) || !Number.isFinite(scale) || !(scale > 0)) throw new Error("Deep horizontal position must be finite and scale must be positive");
    set((state) => state.deepCapture.kind === DeepCaptureKind.Ready ? { deepCapture: { ...state.deepCapture, position, scale } } : state);
  },
  clearDeepCapture: () => set({ deepCapture: noDeepCapture() }),
  setError: (lastError) => set({ lastError }),
}));
