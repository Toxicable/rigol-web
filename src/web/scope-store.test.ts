import { beforeEach, describe, expect, it } from "vitest";

import {
  AcquisitionType,
  Channel,
  ChannelCoupling,
  ChannelUnit,
  EdgeSlope,
  MeasurementKind,
  ScopeRunState,
  TimebaseMode,
  TriggerCoupling,
  TriggerSweep,
  TriggerType,
  type MeasurementValue,
  type ScopeInfo,
  type ScopeState,
} from "../shared/scope-types.js";
import { ControlKind } from "../shared/websocket-protocol.js";
import {
  BrowserConnectionKind,
  DeepCaptureKind,
  MeasurementSource,
  useScopeStore,
} from "./scope-store.js";

const INFO: ScopeInfo = {
  manufacturer: "RIGOL",
  model: "DHO804",
  serialNumber: "test",
  softwareVersion: "1",
};

function scope(position = 0): ScopeState {
  return {
    channels: [Channel.Ch1, Channel.Ch2, Channel.Ch3, Channel.Ch4].map((channel) => ({
      channel,
      enabled: true,
      coupling: ChannelCoupling.Dc,
      unit: ChannelUnit.Volts,
      scale: 1,
      offset: 0,
      probeRatio: 1,
    })) as ScopeState["channels"],
    horizontal: { mode: TimebaseMode.Main, scale: 0.001, position },
    acquisition: { type: AcquisitionType.Normal, averages: 1, memoryDepth: 1_000_000, sampleRate: 1e9 },
    runState: ScopeRunState.Running,
    trigger: {
      type: TriggerType.Edge,
      sweep: TriggerSweep.Auto,
      source: Channel.Ch1,
      slope: EdgeSlope.Rising,
      level: 0,
      coupling: TriggerCoupling.Dc,
    },
  };
}

const DEEP_CHANNEL = {
  channel: Channel.Ch1,
  unit: ChannelUnit.Volts,
  sampleCount: 1000,
  xIncrement: 1e-6,
  xOrigin: 0,
  xReference: 0,
} as const;

function measurement(current: number): MeasurementValue {
  return {
    channel: Channel.Ch1,
    kind: MeasurementKind.Vpp,
    statistics: {
      current,
      minimum: current,
      maximum: current,
      average: current,
      deviation: 0,
      count: 1,
    },
  };
}

describe("scope store", () => {
  beforeEach(() => {
    useScopeStore.setState({
      connection: { kind: BrowserConnectionKind.Connecting },
      measurementSource: MeasurementSource.Scope,
      measurementSpecs: [],
      measurementValues: [],
      deepCapture: { kind: DeepCaptureKind.None },
      lastError: null,
    });
  });

  it("uses explicit numeric connection variants", () => {
    useScopeStore.getState().setTransportDisconnected("lost");
    expect(useScopeStore.getState().connection).toEqual({
      kind: BrowserConnectionKind.TransportDisconnected,
      reason: "lost",
    });
    useScopeStore.getState().setScopeDisconnected("scope offline");
    expect(useScopeStore.getState().connection.kind).toBe(BrowserConnectionKind.ScopeDisconnected);
    useScopeStore.getState().setScopeConnected(INFO, scope());
    expect(useScopeStore.getState().connection.kind).toBe(BrowserConnectionKind.ScopeConnected);
  });

  it("replaces authoritative scope snapshots as a whole", () => {
    useScopeStore.getState().setScopeConnected(INFO, scope(1));
    const replacement = scope(2);
    replacement.channels[0] = { ...replacement.channels[0], scale: 5 };
    useScopeStore.getState().replaceScope(replacement);
    const connection = useScopeStore.getState().connection;
    expect(connection.kind).toBe(BrowserConnectionKind.ScopeConnected);
    if (connection.kind === BrowserConnectionKind.ScopeConnected) {
      expect(connection.scope).toBe(replacement);
      expect(connection.scope.horizontal.position).toBe(2);
      expect(connection.scope.channels[0].scale).toBe(5);
    }
  });

  it("applies semantic optimistic control changes", () => {
    useScopeStore.getState().setScopeConnected(INFO, scope());
    useScopeStore.getState().applyOptimisticControl({
      kind: ControlKind.ChannelOffset,
      channel: Channel.Ch3,
      value: 2.5,
    });
    useScopeStore.getState().applyOptimisticControl({
      kind: ControlKind.TriggerLevel,
      value: 1.25,
    });
    const connection = useScopeStore.getState().connection;
    if (connection.kind !== BrowserConnectionKind.ScopeConnected) {
      throw new Error("expected connected scope");
    }
    expect(connection.scope.channels[2].offset).toBe(2.5);
    expect(connection.scope.trigger.type).toBe(TriggerType.Edge);
    if (connection.scope.trigger.type === TriggerType.Edge) {
      expect(connection.scope.trigger.level).toBe(1.25);
    }
  });

  it("isolates scope and local measurement updates", () => {
    useScopeStore.getState().setMeasurementSource(MeasurementSource.Local);
    useScopeStore.getState().setMeasurementValues([measurement(1)]);
    expect(useScopeStore.getState().measurementValues).toEqual([]);

    useScopeStore.getState().setLocalMeasurementValues([measurement(2)]);
    expect(useScopeStore.getState().measurementValues[0]?.statistics.current).toBe(2);

    useScopeStore.getState().setMeasurementSource(MeasurementSource.Scope);
    useScopeStore.getState().setLocalMeasurementValues([measurement(3)]);
    expect(useScopeStore.getState().measurementValues).toEqual([]);

    useScopeStore.getState().setMeasurementValues([measurement(4)]);
    expect(useScopeStore.getState().measurementValues[0]?.statistics.current).toBe(4);
  });

  it("keeps deep horizontal view local to the retained capture", () => {
    useScopeStore.getState().setScopeConnected(INFO, scope(0.25));
    useScopeStore.getState().setDeepReady(9, [DEEP_CHANNEL]);

    let deepCapture = useScopeStore.getState().deepCapture;
    expect(deepCapture.kind).toBe(DeepCaptureKind.Ready);
    if (deepCapture.kind !== DeepCaptureKind.Ready) {
      throw new Error("expected ready deep capture");
    }
    expect(deepCapture.position).toBe(0.25);
    expect(deepCapture.scale).toBe(0.001);

    useScopeStore.getState().setDeepHorizontal(0.5, 0.0005);
    deepCapture = useScopeStore.getState().deepCapture;
    if (deepCapture.kind !== DeepCaptureKind.Ready) {
      throw new Error("expected ready deep capture");
    }
    expect(deepCapture.position).toBe(0.5);
    expect(deepCapture.scale).toBe(0.0005);

    const connection = useScopeStore.getState().connection;
    if (connection.kind !== BrowserConnectionKind.ScopeConnected) {
      throw new Error("expected connected scope");
    }
    expect(connection.scope.horizontal.position).toBe(0.25);
    expect(connection.scope.horizontal.scale).toBe(0.001);
  });

  it("retires deep capture metadata at scope-session boundaries", () => {
    useScopeStore.getState().setScopeConnected(INFO, scope());
    useScopeStore.getState().setDeepReady(9, [DEEP_CHANNEL]);
    expect(useScopeStore.getState().deepCapture.kind).toBe(DeepCaptureKind.Ready);

    useScopeStore.getState().setTransportDisconnected("lost");
    expect(useScopeStore.getState().deepCapture).toEqual({ kind: DeepCaptureKind.None });

    useScopeStore.getState().setScopeConnected(INFO, scope());
    useScopeStore.getState().setDeepReady(10, [
      { ...DEEP_CHANNEL, channel: Channel.Ch2 },
    ]);
    useScopeStore.getState().setScopeConnected(INFO, scope());
    expect(useScopeStore.getState().deepCapture).toEqual({ kind: DeepCaptureKind.None });
  });
});
