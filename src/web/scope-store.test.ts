import { beforeEach, describe, expect, it } from "vitest";

import {
  AcquisitionType,
  Channel,
  ChannelCoupling,
  ChannelUnit,
  EdgeSlope,
  ScopeRunState,
  TimebaseMode,
  TriggerCoupling,
  TriggerSweep,
  TriggerType,
  type ScopeInfo,
  type ScopeState,
} from "../shared/scope-types.js";
import { ControlKind } from "../shared/websocket-protocol.js";
import {
  BrowserConnectionKind,
  DeepCaptureKind,
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

describe("scope store", () => {
  beforeEach(() => {
    useScopeStore.setState({
      connection: { kind: BrowserConnectionKind.Connecting },
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
});
