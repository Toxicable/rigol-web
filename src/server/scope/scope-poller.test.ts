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
import { ScopeController, type ScopeControllerDriver } from "./scope-controller.js";
import { ScopePoller } from "./scope-poller.js";
import { ScopeStateStore } from "./scope-state-store.js";

function state(runState = ScopeRunState.Running): ScopeState {
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
    acquisition: { type: AcquisitionType.Normal, averages: 2, memoryDepth: 1_000_000, sampleRate: 100_000_000 },
    runState,
    trigger: { type: TriggerType.Edge, sweep: TriggerSweep.Auto, source: Channel.Ch1, slope: EdgeSlope.Rising, level: 0, coupling: TriggerCoupling.Dc },
  };
}

function fakeControllerDriver(readScopeState: ScopeControllerDriver["readScopeState"]): ScopeControllerDriver {
  const reject = async (): Promise<never> => { throw new Error("unused"); };
  return {
    readScopeState,
    readChannelState: reject,
    readHorizontalState: reject,
    readAcquisitionState: reject,
    readTriggerState: reject,
    readRunState: reject,
    setChannelEnabled: reject,
    setChannelScale: reject,
    setChannelOffset: reject,
    setHorizontalScale: reject,
    setHorizontalPosition: reject,
    setTriggerType: reject,
    setTriggerSource: reject,
    setTriggerSlope: reject,
    setTriggerLevel: reject,
    run: reject,
    stop: reject,
    single: reject,
    readMeasurements: reject,
    executeRawScpi: reject,
  } as ScopeControllerDriver;
}

describe("ScopePoller", () => {
  it("uses Background priority and does not overlap cycles", async () => {
    let resolveRead: ((value: ScopeState) => void) | undefined;
    const readScopeState = vi.fn(() => new Promise<ScopeState>((resolve) => {
      resolveRead = resolve;
    }));
    const driver = fakeControllerDriver(readScopeState);
    const store = new ScopeStateStore(state());
    const controller = new ScopeController(driver, store);
    const poller = new ScopePoller(driver, controller, vi.fn());

    const first = poller.runOnce();
    await expect(poller.runOnce()).resolves.toBe(false);
    expect(readScopeState).toHaveBeenCalledOnce();
    expect(readScopeState).toHaveBeenCalledWith(4);

    resolveRead?.(state(ScopeRunState.Stopped));
    await expect(first).resolves.toBe(true);
    expect(store.getState().runState).toBe(ScopeRunState.Stopped);
  });

  it("owns its timer and reports poll failures", async () => {
    vi.useFakeTimers();
    const error = new Error("scope offline");
    const driver = fakeControllerDriver(vi.fn().mockRejectedValue(error));
    const controller = new ScopeController(driver, new ScopeStateStore(state()));
    const onError = vi.fn();
    const poller = new ScopePoller(driver, controller, onError, 1_000);

    poller.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(onError).toHaveBeenCalledWith(error);

    poller.stop();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(onError).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });
});
