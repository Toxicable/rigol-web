import { describe, expect, it, vi } from "vitest";

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
  type AcquisitionState,
  type ChannelState,
  type HorizontalState,
  type MeasurementSpec,
  type MeasurementValue,
  type ScopeState,
  type TriggerState,
} from "../../shared/scope-types.js";
import {
  AcquisitionAction,
  ControlKind,
  type NonEmptyArray,
} from "../../shared/websocket-protocol.js";
import {
  ScopeController,
  type ScopeControllerDriver,
  type ScopeDriverPriority,
} from "./scope-controller.js";
import { ScopeStateStore } from "./scope-state-store.js";

function createState(triggerType: TriggerType = TriggerType.Edge): ScopeState {
  const trigger: TriggerState = triggerType === TriggerType.Edge
    ? {
        type: TriggerType.Edge,
        sweep: TriggerSweep.Auto,
        source: Channel.Ch1,
        slope: EdgeSlope.Rising,
        level: 0.2,
        coupling: TriggerCoupling.Dc,
      }
    : { type: triggerType as Exclude<TriggerType, TriggerType.Edge>, sweep: TriggerSweep.Auto };

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
    trigger,
  };
}

function measurementValue(spec: MeasurementSpec, current: number): MeasurementValue {
  return {
    ...spec,
    statistics: {
      current,
      minimum: current - 0.1,
      maximum: current + 0.1,
      average: current,
      deviation: 0.01,
      count: 10,
    },
  };
}

class FakeDriver implements ScopeControllerDriver {
  public state = createState();
  public readonly calls: string[] = [];

  public async readScopeState(priority: ScopeDriverPriority): Promise<ScopeState> {
    this.calls.push(`readScopeState:${priority}`);
    return this.state;
  }

  public async readChannelState(channel: Channel, priority: ScopeDriverPriority): Promise<ChannelState> {
    this.calls.push(`readChannelState:${channel}:${priority}`);
    return this.state.channels[channel - 1]!;
  }

  public async readHorizontalState(priority: ScopeDriverPriority): Promise<HorizontalState> {
    this.calls.push(`readHorizontalState:${priority}`);
    return this.state.horizontal;
  }

  public async readAcquisitionState(priority: ScopeDriverPriority): Promise<AcquisitionState> {
    this.calls.push(`readAcquisitionState:${priority}`);
    return this.state.acquisition;
  }

  public async readTriggerState(priority: ScopeDriverPriority): Promise<TriggerState> {
    this.calls.push(`readTriggerState:${priority}`);
    return this.state.trigger;
  }

  public async readRunState(priority: ScopeDriverPriority): Promise<ScopeRunState> {
    this.calls.push(`readRunState:${priority}`);
    return this.state.runState;
  }

  public async setChannelEnabled(channel: Channel, enabled: boolean, priority: ScopeDriverPriority): Promise<void> {
    this.calls.push(`setChannelEnabled:${channel}:${enabled}:${priority}`);
    const channels = [...this.state.channels] as ScopeState["channels"];
    channels[channel - 1] = { ...channels[channel - 1]!, enabled };
    this.state = {
      ...this.state,
      channels,
      acquisition: { ...this.state.acquisition, memoryDepth: enabled ? 500_000 : 1_000_000 },
    };
  }

  public async setChannelScale(channel: Channel, scale: number, priority: ScopeDriverPriority): Promise<void> {
    this.calls.push(`setChannelScale:${channel}:${scale}:${priority}`);
    const channels = [...this.state.channels] as ScopeState["channels"];
    channels[channel - 1] = { ...channels[channel - 1]!, scale, offset: 0.1 };
    this.state = { ...this.state, channels };
  }

  public async setChannelOffset(channel: Channel, offset: number, priority: ScopeDriverPriority): Promise<void> {
    this.calls.push(`setChannelOffset:${channel}:${offset}:${priority}`);
    const channels = [...this.state.channels] as ScopeState["channels"];
    channels[channel - 1] = { ...channels[channel - 1]!, offset };
    this.state = { ...this.state, channels };
  }

  public async setHorizontalScale(scale: number, priority: ScopeDriverPriority): Promise<void> {
    this.calls.push(`setHorizontalScale:${scale}:${priority}`);
    this.state = {
      ...this.state,
      horizontal: { ...this.state.horizontal, scale, position: 0.5 },
      acquisition: { ...this.state.acquisition, sampleRate: 50_000_000 },
    };
  }

  public async setHorizontalPosition(position: number, priority: ScopeDriverPriority): Promise<void> {
    this.calls.push(`setHorizontalPosition:${position}:${priority}`);
    this.state = { ...this.state, horizontal: { ...this.state.horizontal, position } };
  }

  public async setTriggerType(type: TriggerType.Edge, priority: ScopeDriverPriority): Promise<void> {
    this.calls.push(`setTriggerType:${type}:${priority}`);
    this.state = {
      ...this.state,
      trigger: {
        type: TriggerType.Edge,
        sweep: TriggerSweep.Auto,
        source: Channel.Ch2,
        slope: EdgeSlope.Falling,
        level: 0.4,
        coupling: TriggerCoupling.Dc,
      },
    };
  }

  public async setTriggerSource(source: Channel, priority: ScopeDriverPriority): Promise<void> {
    this.calls.push(`setTriggerSource:${source}:${priority}`);
    const trigger = this.state.trigger;
    if (trigger.type !== TriggerType.Edge) throw new Error("not edge");
    this.state = { ...this.state, trigger: { ...trigger, source } };
  }

  public async setTriggerSlope(slope: EdgeSlope, priority: ScopeDriverPriority): Promise<void> {
    this.calls.push(`setTriggerSlope:${slope}:${priority}`);
    const trigger = this.state.trigger;
    if (trigger.type !== TriggerType.Edge) throw new Error("not edge");
    this.state = { ...this.state, trigger: { ...trigger, slope } };
  }

  public async setTriggerLevel(level: number, priority: ScopeDriverPriority): Promise<void> {
    this.calls.push(`setTriggerLevel:${level}:${priority}`);
    const trigger = this.state.trigger;
    if (trigger.type !== TriggerType.Edge) throw new Error("not edge");
    this.state = { ...this.state, trigger: { ...trigger, level } };
  }

  public async run(): Promise<void> {
    this.calls.push("run");
    this.state = { ...this.state, runState: ScopeRunState.Running };
  }

  public async stop(): Promise<void> {
    this.calls.push("stop");
    this.state = { ...this.state, runState: ScopeRunState.Stopped };
  }

  public async single(): Promise<void> {
    this.calls.push("single");
    this.state = { ...this.state, runState: ScopeRunState.Waiting };
  }

  public async readMeasurements(specs: MeasurementSpec[], priority: ScopeDriverPriority): Promise<MeasurementValue[]> {
    this.calls.push(`readMeasurements:${priority}`);
    return specs.map((spec, index) => measurementValue(spec, index + 1));
  }

  public async setMeasurements(specs: MeasurementSpec[], priority: ScopeDriverPriority): Promise<void> {
    this.calls.push(`setMeasurements:${specs.length}:${priority}`);
  }

  public async executeRawScpi(command: string): Promise<string> {
    this.calls.push(`raw:${command}`);
    return "OK";
  }
}

function createController(state = createState()): { driver: FakeDriver; store: ScopeStateStore; controller: ScopeController } {
  const driver = new FakeDriver();
  driver.state = state;
  const store = new ScopeStateStore(state);
  return { driver, store, controller: new ScopeController(driver, store) };
}

describe("ScopeController", () => {
  it("applies interactive values optimistically at Interactive priority without readback", async () => {
    const { controller, driver, store } = createController();

    await controller.updateInteraction({
      kind: ControlKind.ChannelOffset,
      channel: Channel.Ch1,
      value: 0.35,
    });

    expect(store.getState().channels[0].offset).toBe(0.35);
    expect(driver.calls).toEqual(["setChannelOffset:1:0.35:1"]);
  });

  it("reads channel and acquisition state after changing channel enable", async () => {
    const { controller, driver, store } = createController();

    await controller.setControl({
      kind: ControlKind.ChannelEnabled,
      channel: Channel.Ch2,
      value: true,
    });

    expect(driver.calls).toEqual([
      "setChannelEnabled:2:true:2",
      "readChannelState:2:2",
      "readAcquisitionState:2",
    ]);
    expect(store.getState().channels[1].enabled).toBe(true);
    expect(store.getState().acquisition.memoryDepth).toBe(500_000);
  });

  it("reads dependent Edge trigger state after changing the trigger source channel scale", async () => {
    const { controller, driver } = createController();

    await controller.setControl({
      kind: ControlKind.ChannelScale,
      channel: Channel.Ch1,
      value: 2,
    });

    expect(driver.calls).toEqual([
      "setChannelScale:1:2:2",
      "readChannelState:1:2",
      "readTriggerState:2",
    ]);
  });

  it("commits final interactive values at Immediate priority before authoritative readback", async () => {
    const { controller, driver, store } = createController();

    await controller.commitInteraction({
      kind: ControlKind.HorizontalScale,
      value: 2e-3,
    });

    expect(driver.calls).toEqual([
      "setHorizontalScale:0.002:0",
      "readHorizontalState:0",
      "readAcquisitionState:0",
    ]);
    expect(store.getState().horizontal.position).toBe(0.5);
    expect(store.getState().acquisition.sampleRate).toBe(50_000_000);
  });

  it("does not apply an older readback after a newer optimistic mutation", async () => {
    const { controller, driver, store } = createController();
    let resolveRead: ((value: HorizontalState) => void) | undefined;
    const readHorizontalState = vi.spyOn(driver, "readHorizontalState").mockImplementationOnce(
      () => new Promise<HorizontalState>((resolve) => {
        resolveRead = resolve;
      }),
    );

    const commit = controller.commitInteraction({
      kind: ControlKind.HorizontalPosition,
      value: 0.25,
    });
    await vi.waitFor(() => expect(readHorizontalState).toHaveBeenCalledOnce());

    await controller.updateInteraction({
      kind: ControlKind.HorizontalPosition,
      value: 0.5,
    });

    if (resolveRead === undefined) {
      throw new Error("Expected pending horizontal readback");
    }

    resolveRead({ ...driver.state.horizontal, position: 0.25 });
    await commit;

    expect(store.getState().horizontal.position).toBe(0.5);
  });

  it("rejects Edge-only controls while another trigger type is authoritative", async () => {
    const { controller } = createController(createState(TriggerType.Pulse));

    await expect(controller.setControl({
      kind: ControlKind.TriggerSource,
      value: Channel.Ch2,
    })).rejects.toThrow("requires TriggerType.Edge");
  });

  it("transitions to Edge by writing first and replacing with a complete trigger readback", async () => {
    const state = createState(TriggerType.Pulse);
    const { controller, driver, store } = createController(state);

    await controller.setControl({
      kind: ControlKind.TriggerType,
      value: TriggerType.Edge,
    });

    expect(driver.calls).toEqual(["setTriggerType:1:2", "readTriggerState:2"]);
    expect(store.getState().trigger).toEqual(driver.state.trigger);
    expect(store.getState().trigger.type).toBe(TriggerType.Edge);
  });

  it("discards stale poll snapshots and applies fresh ones", async () => {
    const { controller, store } = createController();
    const staleRevision = controller.getMutationRevision();

    await controller.updateInteraction({
      kind: ControlKind.HorizontalPosition,
      value: 0.25,
    });

    expect(controller.applyPolledState(createState(), staleRevision)).toBe(false);
    expect(store.getState().horizontal.position).toBe(0.25);

    const fresh = { ...createState(), runState: ScopeRunState.Stopped };
    expect(controller.applyPolledState(fresh, controller.getMutationRevision())).toBe(true);
    expect(store.getState()).toBe(fresh);
  });

  it("preserves measurement order and rejects mismatched driver results", async () => {
    const { controller, driver } = createController();
    const specs: NonEmptyArray<MeasurementSpec> = [
      { kind: MeasurementKind.Vpp, channel: Channel.Ch2 },
      { kind: MeasurementKind.Frequency, channel: Channel.Ch1 },
    ];

    await expect(controller.readMeasurements(specs)).resolves.toEqual([
      measurementValue(specs[0], 1),
      measurementValue(specs[1], 2),
    ]);
    expect(driver.calls).toContain("readMeasurements:4");

    vi.spyOn(driver, "readMeasurements").mockResolvedValueOnce([
      measurementValue({ kind: MeasurementKind.Frequency, channel: Channel.Ch1 }, 1),
      measurementValue({ kind: MeasurementKind.Vpp, channel: Channel.Ch2 }, 2),
    ]);
    await expect(controller.readMeasurements(specs)).rejects.toThrow("out of requested order");
  });

  it("invalidates poll revision for raw SCPI and acquisition actions", async () => {
    const { controller, store } = createController();
    const initialRevision = controller.getMutationRevision();

    await expect(controller.executeRawScpi("*IDN?")).resolves.toBe("OK");
    expect(controller.getMutationRevision()).toBe(initialRevision + 1);

    await controller.performAcquisitionAction(AcquisitionAction.Stop);
    expect(controller.getMutationRevision()).toBe(initialRevision + 2);
    expect(store.getState().runState).toBe(ScopeRunState.Stopped);
  });
});
