import { beforeEach, describe, expect, it, vi } from "vitest";

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
  type ScopeInfo,
  type ScopeState,
} from "../shared/scope-types.js";
import {
  ControlKind,
  MessageType,
  type DeepCaptureReadyMessage,
  type MeasurementResultMessage,
} from "../shared/websocket-protocol.js";
import { ScopeActions, type ScopeActionBinding } from "./scope-actions.js";
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

function scope(): ScopeState {
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
    horizontal: { mode: TimebaseMode.Main, scale: 0.001, position: 0 },
    acquisition: {
      type: AcquisitionType.Normal,
      averages: 1,
      memoryDepth: 1_000_000,
      sampleRate: 1e9,
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

interface Deferred {
  promise: Promise<void>;
  resolve(): void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

function fakeBinding(overrides: Partial<ScopeActionBinding> = {}): ScopeActionBinding {
  const deepReady: DeepCaptureReadyMessage = {
    type: MessageType.DeepCaptureReady,
    requestId: 0,
    captureId: 1,
    channels: [{
      channel: Channel.Ch1,
      unit: ChannelUnit.Volts,
      sampleCount: 10,
      xIncrement: 1e-6,
      xOrigin: 0,
      xReference: 0,
    }],
  };
  const measurementResult: MeasurementResultMessage = {
    type: MessageType.MeasurementResult,
    requestId: 0,
    values: [],
  };
  return {
    setControl: vi.fn(async () => undefined),
    interactionUpdate: vi.fn(),
    interactionCommit: vi.fn(async () => undefined),
    acquisition: vi.fn(async () => undefined),
    sleep: vi.fn(async () => undefined),
    deepCapture: vi.fn(async () => deepReady),
    readMeasurements: vi.fn(async () => measurementResult),
    setMeasurements: vi.fn(async () => undefined),
    ...overrides,
  };
}

beforeEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  useScopeStore.setState({
    connection: { kind: BrowserConnectionKind.ScopeConnected, info: INFO, scope: scope() },
    measurementSource: MeasurementSource.Scope,
    measurementSpecs: [],
    measurementValues: [],
    deepCapture: { kind: DeepCaptureKind.None },
    sleepPending: false,
    lastError: null,
  });
});

describe("ScopeActions", () => {
  it("owns optimistic control updates while authoritative state still wins", async () => {
    const binding = fakeBinding();
    const actions = new ScopeActions(binding);

    await actions.setChannelScale(Channel.Ch1, 2);

    const optimistic = useScopeStore.getState().connection;
    expect(optimistic.kind).toBe(BrowserConnectionKind.ScopeConnected);
    if (optimistic.kind !== BrowserConnectionKind.ScopeConnected) {
      throw new Error("expected connected scope");
    }
    expect(optimistic.scope.channels[0].scale).toBe(2);
    expect(binding.setControl).toHaveBeenCalledWith({
      kind: ControlKind.ChannelScale,
      channel: Channel.Ch1,
      value: 2,
    });

    const authoritative = scope();
    authoritative.channels[0] = { ...authoritative.channels[0], scale: 5 };
    useScopeStore.getState().replaceScope(authoritative);
    const reconciled = useScopeStore.getState().connection;
    if (reconciled.kind !== BrowserConnectionKind.ScopeConnected) {
      throw new Error("expected connected scope");
    }
    expect(reconciled.scope.channels[0].scale).toBe(5);
  });

  it("owns command failure presentation", async () => {
    const binding = fakeBinding({
      setControl: vi.fn(async () => {
        throw new Error("scope write failed");
      }),
    });
    const actions = new ScopeActions(binding);

    await actions.setTriggerLevel(1.25);

    expect(useScopeStore.getState().lastError).toBe("scope write failed");
  });

  it("coalesces interactive updates while applying optimistic presentation immediately", () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", {
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
      setInterval: globalThis.setInterval,
      clearInterval: globalThis.clearInterval,
    });
    const binding = fakeBinding();
    const actions = new ScopeActions(binding);

    actions.previewChannelOffset(Channel.Ch2, 1);
    actions.previewChannelOffset(Channel.Ch2, 2);

    const optimistic = useScopeStore.getState().connection;
    if (optimistic.kind !== BrowserConnectionKind.ScopeConnected) {
      throw new Error("expected connected scope");
    }
    expect(optimistic.scope.channels[1].offset).toBe(2);
    expect(binding.interactionUpdate).not.toHaveBeenCalled();

    vi.advanceTimersByTime(50);
    expect(binding.interactionUpdate).toHaveBeenCalledTimes(1);
    expect(binding.interactionUpdate).toHaveBeenCalledWith({
      kind: ControlKind.ChannelOffset,
      channel: Channel.Ch2,
      value: 2,
    });

    actions.dispose();
  });

  it("owns Sleep pending state outside the toolbar", async () => {
    const operation = deferred();
    const binding = fakeBinding({ sleep: vi.fn(() => operation.promise) });
    const actions = new ScopeActions(binding);

    const request = actions.sleep();
    expect(useScopeStore.getState().sleepPending).toBe(true);

    operation.resolve();
    await request;
    expect(useScopeStore.getState().sleepPending).toBe(false);
  });

  it("owns scope measurement configuration and polling", async () => {
    const result: MeasurementResultMessage = {
      type: MessageType.MeasurementResult,
      requestId: 3,
      values: [{
        channel: Channel.Ch1,
        kind: MeasurementKind.Vpp,
        statistics: {
          current: 2.5,
          minimum: 2.4,
          maximum: 2.6,
          average: 2.5,
          deviation: 0.01,
          count: 10,
        },
      }],
    };
    const binding = fakeBinding({
      readMeasurements: vi.fn(async () => result),
    });
    const actions = new ScopeActions(binding);
    const specs = [{ channel: Channel.Ch1, kind: MeasurementKind.Vpp }];

    actions.setMeasurementSpecs(specs);
    await actions.pollMeasurementsOnce();

    expect(binding.setMeasurements).toHaveBeenCalledWith(specs);
    expect(binding.readMeasurements).toHaveBeenCalledWith(specs);
    expect(useScopeStore.getState().measurementValues).toEqual(result.values);

    actions.setMeasurementSource(MeasurementSource.Local);
    expect(binding.setMeasurements).toHaveBeenLastCalledWith([]);
  });
});
