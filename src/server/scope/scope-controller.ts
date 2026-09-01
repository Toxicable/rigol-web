import type {
  AcquisitionState,
  ChannelState,
  HorizontalState,
  MeasurementSpec,
  MeasurementValue,
  ScopeRunState,
  ScopeState,
  TriggerState,
} from "../../shared/scope-types.js";
import {
  Channel,
  EdgeSlope,
  TriggerType,
} from "../../shared/scope-types.js";
import type { NonEmptyArray } from "../../shared/websocket-protocol.js";
import {
  AcquisitionAction,
  ControlKind,
  type ControlChange,
  type InteractiveControl,
} from "../../shared/websocket-protocol.js";
import { ScopeStateStore } from "./scope-state-store.js";

export type ScopeDriverPriority = 0 | 1 | 2 | 3 | 4;

const PRIORITY_IMMEDIATE: ScopeDriverPriority = 0;
const PRIORITY_INTERACTIVE: ScopeDriverPriority = 1;
const PRIORITY_NORMAL: ScopeDriverPriority = 2;
const PRIORITY_BACKGROUND: ScopeDriverPriority = 4;

export interface ScopeControllerDriver {
  readScopeState(priority: ScopeDriverPriority): Promise<ScopeState>;
  readChannelState(
    channel: Channel,
    priority: ScopeDriverPriority,
  ): Promise<ChannelState>;
  readHorizontalState(priority: ScopeDriverPriority): Promise<HorizontalState>;
  readAcquisitionState(priority: ScopeDriverPriority): Promise<AcquisitionState>;
  readTriggerState(priority: ScopeDriverPriority): Promise<TriggerState>;
  readRunState(priority: ScopeDriverPriority): Promise<ScopeRunState>;

  setChannelEnabled(
    channel: Channel,
    enabled: boolean,
    priority: ScopeDriverPriority,
  ): Promise<void>;
  setChannelScale(
    channel: Channel,
    scale: number,
    priority: ScopeDriverPriority,
  ): Promise<void>;
  setChannelOffset(
    channel: Channel,
    offset: number,
    priority: ScopeDriverPriority,
  ): Promise<void>;
  setHorizontalScale(scale: number, priority: ScopeDriverPriority): Promise<void>;
  setHorizontalPosition(
    position: number,
    priority: ScopeDriverPriority,
  ): Promise<void>;
  setTriggerType(
    type: TriggerType.Edge,
    priority: ScopeDriverPriority,
  ): Promise<void>;
  setTriggerSource(source: Channel, priority: ScopeDriverPriority): Promise<void>;
  setTriggerSlope(slope: EdgeSlope, priority: ScopeDriverPriority): Promise<void>;
  setTriggerLevel(level: number, priority: ScopeDriverPriority): Promise<void>;

  run(): Promise<void>;
  stop(): Promise<void>;
  single(): Promise<void>;

  readMeasurements(
    specs: MeasurementSpec[],
    priority: ScopeDriverPriority,
  ): Promise<MeasurementValue[]>;
  setMeasurements(
    specs: MeasurementSpec[],
    priority: ScopeDriverPriority,
  ): Promise<void>;
  executeRawScpi(command: string): Promise<string>;
}

function replaceChannel(
  state: ScopeState,
  channel: Channel,
  replacement: ChannelState,
): ScopeState {
  if (replacement.channel !== channel) {
    throw new Error(
      `Driver returned CH${replacement.channel} while reading CH${channel}`,
    );
  }

  const channels = state.channels;

  switch (channel) {
    case Channel.Ch1:
      return { ...state, channels: [replacement, channels[1], channels[2], channels[3]] };
    case Channel.Ch2:
      return { ...state, channels: [channels[0], replacement, channels[2], channels[3]] };
    case Channel.Ch3:
      return { ...state, channels: [channels[0], channels[1], replacement, channels[3]] };
    case Channel.Ch4:
      return { ...state, channels: [channels[0], channels[1], channels[2], replacement] };
  }
}

function updateChannel(
  state: ScopeState,
  channel: Channel,
  updater: (channelState: ChannelState) => ChannelState,
): ScopeState {
  const current = state.channels[channel - 1];

  if (current === undefined || current.channel !== channel) {
    throw new Error(`Scope state is missing CH${channel}`);
  }

  return replaceChannel(state, channel, updater(current));
}

function requireFinite(value: number, name: string): void {
  if (!Number.isFinite(value)) {
    throw new Error(`${name} must be finite`);
  }
}

function requirePositive(value: number, name: string): void {
  requireFinite(value, name);

  if (value <= 0) {
    throw new Error(`${name} must be greater than zero`);
  }
}

function requireEdgeTrigger(state: ScopeState): Extract<TriggerState, { type: TriggerType.Edge }> {
  if (state.trigger.type !== TriggerType.Edge) {
    throw new Error("Edge trigger control requires TriggerType.Edge");
  }

  return state.trigger;
}

export class ScopeController {
  private mutationRevision = 0;

  public constructor(
    private readonly driver: ScopeControllerDriver,
    private readonly stateStore: ScopeStateStore,
  ) {}

  public getMutationRevision(): number {
    return this.mutationRevision;
  }

  public applyPolledState(state: ScopeState, capturedRevision: number): boolean {
    if (capturedRevision !== this.mutationRevision) {
      return false;
    }

    this.stateStore.replaceState(state);
    return true;
  }

  public async setControl(control: ControlChange): Promise<void> {
    this.validateControl(control);
    const revision = this.incrementMutationRevision();

    if (control.kind !== ControlKind.TriggerType) {
      this.applyOptimisticControl(control);
    }

    await this.writeControl(control, PRIORITY_NORMAL);
    await this.reconcileControl(control, PRIORITY_NORMAL, revision);
  }

  public async updateInteraction(control: InteractiveControl): Promise<void> {
    this.validateControl(control);
    this.incrementMutationRevision();
    this.applyOptimisticControl(control);
    await this.writeControl(control, PRIORITY_INTERACTIVE);
  }

  public async commitInteraction(control: InteractiveControl): Promise<void> {
    this.validateControl(control);
    const revision = this.incrementMutationRevision();
    this.applyOptimisticControl(control);
    await this.writeControl(control, PRIORITY_IMMEDIATE);
    await this.reconcileControl(control, PRIORITY_IMMEDIATE, revision);
  }

  public async performAcquisitionAction(action: AcquisitionAction): Promise<void> {
    const revision = this.incrementMutationRevision();

    switch (action) {
      case AcquisitionAction.Run:
        await this.driver.run();
        break;
      case AcquisitionAction.Stop:
        await this.driver.stop();
        break;
      case AcquisitionAction.Single:
        await this.driver.single();
        break;
      default:
        throw new Error(`Unsupported acquisition action: ${String(action)}`);
    }

    const runState = await this.driver.readRunState(PRIORITY_IMMEDIATE);
    this.applyReconciledUpdate(revision, (state) => ({ ...state, runState }));
  }

  public async readMeasurements(
    measurements: NonEmptyArray<MeasurementSpec>,
  ): Promise<MeasurementValue[]> {
    const values = await this.driver.readMeasurements(
      measurements,
      PRIORITY_BACKGROUND,
    );

    if (values.length !== measurements.length) {
      throw new Error(
        `Expected ${measurements.length} measurement values, received ${values.length}`,
      );
    }

    for (let index = 0; index < measurements.length; index += 1) {
      const requested = measurements[index];
      const returned = values[index];

      if (
        requested === undefined ||
        returned === undefined ||
        requested.kind !== returned.kind ||
        requested.channel !== returned.channel
      ) {
        throw new Error("Driver returned measurement values out of requested order");
      }
    }

    return values;
  }

  public async setMeasurements(measurements: MeasurementSpec[]): Promise<void> {
    this.incrementMutationRevision();
    await this.driver.setMeasurements(measurements, PRIORITY_NORMAL);
  }

  public async executeRawScpi(command: string): Promise<string> {
    if (command.trim().length === 0) {
      throw new Error("SCPI command must not be empty");
    }

    this.incrementMutationRevision();
    return this.driver.executeRawScpi(command);
  }

  private incrementMutationRevision(): number {
    this.mutationRevision += 1;
    return this.mutationRevision;
  }

  private applyReconciledUpdate(
    capturedRevision: number,
    updater: (state: ScopeState) => ScopeState,
  ): boolean {
    if (capturedRevision !== this.mutationRevision) {
      return false;
    }

    this.stateStore.update(updater);
    return true;
  }

  private validateControl(control: ControlChange): void {
    switch (control.kind) {
      case ControlKind.ChannelEnabled:
        return;
      case ControlKind.ChannelScale:
        requirePositive(control.value, "Channel scale");
        return;
      case ControlKind.ChannelOffset:
        requireFinite(control.value, "Channel offset");
        return;
      case ControlKind.HorizontalScale:
        requirePositive(control.value, "Horizontal scale");
        return;
      case ControlKind.HorizontalPosition:
        requireFinite(control.value, "Horizontal position");
        return;
      case ControlKind.TriggerLevel:
        requireFinite(control.value, "Trigger level");
        requireEdgeTrigger(this.stateStore.getState());
        return;
      case ControlKind.TriggerType:
        if (control.value !== TriggerType.Edge) {
          throw new Error("Version 1 only supports selecting TriggerType.Edge");
        }
        return;
      case ControlKind.TriggerSource:
        requireEdgeTrigger(this.stateStore.getState());
        return;
      case ControlKind.TriggerSlope:
        requireEdgeTrigger(this.stateStore.getState());
        return;
    }
  }

  private applyOptimisticControl(control: Exclude<ControlChange, { kind: ControlKind.TriggerType }>): void {
    this.stateStore.update((state) => {
      switch (control.kind) {
        case ControlKind.ChannelEnabled:
          return updateChannel(state, control.channel, (channelState) => ({
            ...channelState,
            enabled: control.value,
          }));
        case ControlKind.ChannelScale:
          return updateChannel(state, control.channel, (channelState) => ({
            ...channelState,
            scale: control.value,
          }));
        case ControlKind.ChannelOffset:
          return updateChannel(state, control.channel, (channelState) => ({
            ...channelState,
            offset: control.value,
          }));
        case ControlKind.HorizontalScale:
          return {
            ...state,
            horizontal: { ...state.horizontal, scale: control.value },
          };
        case ControlKind.HorizontalPosition:
          return {
            ...state,
            horizontal: { ...state.horizontal, position: control.value },
          };
        case ControlKind.TriggerLevel: {
          const trigger = requireEdgeTrigger(state);
          return { ...state, trigger: { ...trigger, level: control.value } };
        }
        case ControlKind.TriggerSource: {
          const trigger = requireEdgeTrigger(state);
          return { ...state, trigger: { ...trigger, source: control.value } };
        }
        case ControlKind.TriggerSlope: {
          const trigger = requireEdgeTrigger(state);
          return { ...state, trigger: { ...trigger, slope: control.value } };
        }
      }
    });
  }

  private async writeControl(
    control: ControlChange,
    priority: ScopeDriverPriority,
  ): Promise<void> {
    switch (control.kind) {
      case ControlKind.ChannelEnabled:
        await this.driver.setChannelEnabled(control.channel, control.value, priority);
        return;
      case ControlKind.ChannelScale:
        await this.driver.setChannelScale(control.channel, control.value, priority);
        return;
      case ControlKind.ChannelOffset:
        await this.driver.setChannelOffset(control.channel, control.value, priority);
        return;
      case ControlKind.HorizontalScale:
        await this.driver.setHorizontalScale(control.value, priority);
        return;
      case ControlKind.HorizontalPosition:
        await this.driver.setHorizontalPosition(control.value, priority);
        return;
      case ControlKind.TriggerLevel:
        await this.driver.setTriggerLevel(control.value, priority);
        return;
      case ControlKind.TriggerType:
        await this.driver.setTriggerType(control.value, priority);
        return;
      case ControlKind.TriggerSource:
        await this.driver.setTriggerSource(control.value, priority);
        return;
      case ControlKind.TriggerSlope:
        await this.driver.setTriggerSlope(control.value, priority);
        return;
    }
  }

  private async reconcileControl(
    control: ControlChange,
    priority: ScopeDriverPriority,
    capturedRevision: number,
  ): Promise<void> {
    switch (control.kind) {
      case ControlKind.ChannelEnabled: {
        const channel = await this.driver.readChannelState(control.channel, priority);
        const acquisition = await this.driver.readAcquisitionState(priority);
        this.applyReconciledUpdate(capturedRevision, (state) => ({
          ...replaceChannel(state, control.channel, channel),
          acquisition,
        }));
        return;
      }
      case ControlKind.ChannelScale:
      case ControlKind.ChannelOffset: {
        const channel = await this.driver.readChannelState(control.channel, priority);
        const currentState = this.stateStore.getState();
        const triggerMatches =
          currentState.trigger.type === TriggerType.Edge &&
          currentState.trigger.source === control.channel;
        const trigger = triggerMatches
          ? await this.driver.readTriggerState(priority)
          : undefined;

        this.applyReconciledUpdate(capturedRevision, (state) => {
          const withChannel = replaceChannel(state, control.channel, channel);
          return trigger === undefined ? withChannel : { ...withChannel, trigger };
        });
        return;
      }
      case ControlKind.HorizontalScale: {
        const horizontal = await this.driver.readHorizontalState(priority);
        const acquisition = await this.driver.readAcquisitionState(priority);
        this.applyReconciledUpdate(capturedRevision, (state) => ({
          ...state,
          horizontal,
          acquisition,
        }));
        return;
      }
      case ControlKind.HorizontalPosition: {
        const horizontal = await this.driver.readHorizontalState(priority);
        this.applyReconciledUpdate(capturedRevision, (state) => ({ ...state, horizontal }));
        return;
      }
      case ControlKind.TriggerType:
      case ControlKind.TriggerSource:
      case ControlKind.TriggerSlope:
      case ControlKind.TriggerLevel: {
        const trigger = await this.driver.readTriggerState(priority);
        this.applyReconciledUpdate(capturedRevision, (state) => ({ ...state, trigger }));
        return;
      }
    }
  }
}
