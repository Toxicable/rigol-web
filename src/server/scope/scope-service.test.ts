import { describe, expect, it } from "vitest";

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
} from "../../shared/scope-types.js";
import { ControlKind } from "../../shared/websocket-protocol.js";
import type { ScopeControllerDriver } from "./scope-controller.js";
import { ScopeService } from "./scope-service.js";
import { ScopeStateStore } from "./scope-state-store.js";

interface Deferred {
  promise: Promise<void>;
  resolve(): void;
}

interface RuntimeInternals {
  session: unknown;
}

const info: ScopeInfo = {
  manufacturer: "RIGOL TECHNOLOGIES",
  model: "DHO804",
  serialNumber: "TEST",
  softwareVersion: "00.01",
};

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
      memoryDepth: 1_000,
      sampleRate: 1_000_000,
    },
    runState: ScopeRunState.Stopped,
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

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((resolver) => { resolve = resolver; });
  return { promise, resolve };
}

function driverFor(
  stateStore: ScopeStateStore,
  writeGate: Deferred | null = null,
  entered: Deferred | null = null,
): ScopeControllerDriver {
  const unused = async (): Promise<never> => { throw new Error("unused"); };
  return {
    readScopeState: async () => stateStore.getState(),
    readChannelState: async (channel) => stateStore.getState().channels[channel - 1]!,
    readHorizontalState: async () => stateStore.getState().horizontal,
    readAcquisitionState: async () => stateStore.getState().acquisition,
    readTriggerState: async () => stateStore.getState().trigger,
    readRunState: async () => stateStore.getState().runState,
    setChannelEnabled: async () => {
      entered?.resolve();
      await writeGate?.promise;
    },
    setChannelScale: unused,
    setChannelOffset: unused,
    setHorizontalScale: unused,
    setHorizontalPosition: unused,
    setTriggerType: unused,
    setTriggerSource: unused,
    setTriggerSlope: unused,
    setTriggerLevel: unused,
    run: unused,
    stop: unused,
    single: unused,
    readMeasurements: async () => [],
    setMeasurements: async () => undefined,
    executeRawScpi: async (command) => `response:${command}`,
  };
}

function sessionFor(driver: ScopeControllerDriver, stateStore: ScopeStateStore): object {
  return {
    info,
    driver,
    stateStore,
    live: {
      pause: async () => undefined,
      resume: () => undefined,
    },
    deep: {
      capture: async () => ({ captureId: 1, channels: [] }),
      getViewport: () => new Uint8Array(),
    },
  };
}

describe("ScopeService runtime boundary", () => {
  it("owns scope control semantics over the current physical runtime session", async () => {
    const service = new ScopeService({ host: "scope.test", port: 5555 });
    const store = new ScopeStateStore(createState());
    (service.runtime as unknown as RuntimeInternals).session = sessionFor(driverFor(store), store);

    await service.setControl({
      kind: ControlKind.ChannelEnabled,
      channel: Channel.Ch2,
      value: true,
    });

    expect(store.getState().channels[1].enabled).toBe(true);
    await expect(service.executeRawScpi("*IDN?")).resolves.toBe("response:*IDN?");
  });

  it("rejects completion when the physical session changes while a service request is in flight", async () => {
    const service = new ScopeService({ host: "scope.test", port: 5555 });
    const firstStore = new ScopeStateStore(createState());
    const secondStore = new ScopeStateStore(createState());
    const gate = deferred();
    const entered = deferred();
    const runtime = service.runtime as unknown as RuntimeInternals;
    runtime.session = sessionFor(driverFor(firstStore, gate, entered), firstStore);

    const request = service.setControl({
      kind: ControlKind.ChannelEnabled,
      channel: Channel.Ch2,
      value: true,
    });
    await entered.promise;
    runtime.session = sessionFor(driverFor(secondStore), secondStore);
    gate.resolve();

    await expect(request).rejects.toThrow(/Scope session changed/);
    expect(secondStore.getState().channels[1].enabled).toBe(false);
  });
});
