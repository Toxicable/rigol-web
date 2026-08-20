import { describe, expect, it, vi } from "vitest";

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
  type ScopeState,
} from "../../shared/scope-types.js";
import { ScopeStateStore } from "./scope-state-store.js";

function createState(): ScopeState {
  return {
    channels: [Channel.Ch1, Channel.Ch2, Channel.Ch3, Channel.Ch4].map((channel) => ({
      channel,
      enabled: channel === Channel.Ch1,
      coupling: ChannelCoupling.Dc,
      unit: ChannelUnit.Volts,
      scale: 1,
      offset: 0,
      probeRatio: 1,
    })) as ScopeState["channels"],
    horizontal: { mode: TimebaseMode.Main, scale: 1e-3, position: 0 },
    acquisition: {
      type: AcquisitionType.Normal,
      averages: 2,
      memoryDepth: 1_000_000,
      sampleRate: 100_000_000,
    },
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

describe("ScopeStateStore", () => {
  it("stores and publishes complete replacement snapshots", () => {
    const initial = createState();
    const store = new ScopeStateStore(initial);
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    const replacement = { ...initial, runState: ScopeRunState.Stopped };

    store.replaceState(replacement);

    expect(store.getState()).toBe(replacement);
    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith(replacement);

    unsubscribe();
    store.update((state) => ({ ...state, runState: ScopeRunState.Running }));
    expect(listener).toHaveBeenCalledOnce();
  });

  it("does not publish when the exact same snapshot object is replaced", () => {
    const state = createState();
    const store = new ScopeStateStore(state);
    const listener = vi.fn();
    store.subscribe(listener);

    store.replaceState(state);

    expect(listener).not.toHaveBeenCalled();
  });
});
