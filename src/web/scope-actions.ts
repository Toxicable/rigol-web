import {
  Channel,
  EdgeSlope,
  TriggerType,
  type MeasurementSpec,
} from "../shared/scope-types.js";
import {
  AcquisitionAction,
  ControlKind,
  type ControlChange,
  type InteractiveControl,
} from "../shared/websocket-protocol.js";
import type { ScopeBinding } from "./scope-binding.js";
import {
  DeepCaptureKind,
  MeasurementSource,
  useScopeStore,
} from "./scope-store.js";

const INTERACTION_UPDATE_INTERVAL_MS = 50;

export type ScopeActionBinding = Pick<
  ScopeBinding,
  | "setControl"
  | "interactionUpdate"
  | "interactionCommit"
  | "acquisition"
  | "sleep"
  | "deepCapture"
  | "readMeasurements"
  | "setMeasurements"
>;

export class ScopeActions {
  private pendingInteraction: InteractiveControl | null = null;
  private interactionTimer: ReturnType<typeof setTimeout> | null = null;
  private measurementInFlight = false;

  public constructor(private readonly binding: ScopeActionBinding) {}

  public dispose(): void {
    if (this.interactionTimer !== null) {
      window.clearTimeout(this.interactionTimer);
      this.interactionTimer = null;
    }
    this.pendingInteraction = null;
  }

  public setChannelEnabled(channel: Channel, value: boolean): Promise<void> {
    return this.setControl({ kind: ControlKind.ChannelEnabled, channel, value });
  }

  public setChannelScale(channel: Channel, value: number): Promise<void> {
    if (!Number.isFinite(value) || value <= 0) {
      return Promise.resolve();
    }
    return this.setControl({ kind: ControlKind.ChannelScale, channel, value });
  }

  public setChannelOffset(channel: Channel, value: number): Promise<void> {
    if (!Number.isFinite(value)) {
      return Promise.resolve();
    }
    return this.setControl({ kind: ControlKind.ChannelOffset, channel, value });
  }

  public setHorizontalScale(value: number): Promise<void> {
    if (!Number.isFinite(value) || value <= 0) {
      return Promise.resolve();
    }
    const deepCapture = useScopeStore.getState().deepCapture;
    if (deepCapture.kind === DeepCaptureKind.Ready) {
      useScopeStore.getState().setDeepHorizontal(deepCapture.position, value);
      return Promise.resolve();
    }
    return this.setControl({ kind: ControlKind.HorizontalScale, value });
  }

  public setHorizontalPosition(value: number): Promise<void> {
    if (!Number.isFinite(value)) {
      return Promise.resolve();
    }
    const deepCapture = useScopeStore.getState().deepCapture;
    if (deepCapture.kind === DeepCaptureKind.Ready) {
      useScopeStore.getState().setDeepHorizontal(value, deepCapture.scale);
      return Promise.resolve();
    }
    return this.setControl({ kind: ControlKind.HorizontalPosition, value });
  }

  public setTriggerType(value: TriggerType): Promise<void> {
    return this.setControl({ kind: ControlKind.TriggerType, value });
  }

  public setTriggerSource(value: Channel): Promise<void> {
    return this.setControl({ kind: ControlKind.TriggerSource, value });
  }

  public setTriggerSlope(value: EdgeSlope): Promise<void> {
    return this.setControl({ kind: ControlKind.TriggerSlope, value });
  }

  public setTriggerLevel(value: number): Promise<void> {
    if (!Number.isFinite(value)) {
      return Promise.resolve();
    }
    return this.setControl({ kind: ControlKind.TriggerLevel, value });
  }

  public previewHorizontalPosition(value: number): void {
    const deepCapture = useScopeStore.getState().deepCapture;
    if (deepCapture.kind === DeepCaptureKind.Ready) {
      useScopeStore.getState().setDeepHorizontal(value, deepCapture.scale);
      return;
    }
    this.previewInteraction({ kind: ControlKind.HorizontalPosition, value });
  }

  public commitHorizontalPosition(value: number): Promise<void> {
    const deepCapture = useScopeStore.getState().deepCapture;
    if (deepCapture.kind === DeepCaptureKind.Ready) {
      useScopeStore.getState().setDeepHorizontal(value, deepCapture.scale);
      return Promise.resolve();
    }
    return this.commitInteraction({ kind: ControlKind.HorizontalPosition, value });
  }

  public previewChannelOffset(channel: Channel, value: number): void {
    this.previewInteraction({ kind: ControlKind.ChannelOffset, channel, value });
  }

  public commitChannelOffset(channel: Channel, value: number): Promise<void> {
    return this.commitInteraction({ kind: ControlKind.ChannelOffset, channel, value });
  }

  public previewTriggerLevel(value: number): void {
    this.previewInteraction({ kind: ControlKind.TriggerLevel, value });
  }

  public commitTriggerLevel(value: number): Promise<void> {
    return this.commitInteraction({ kind: ControlKind.TriggerLevel, value });
  }

  public run(): Promise<void> {
    return this.runAcquisition(AcquisitionAction.Run);
  }

  public stop(): Promise<void> {
    return this.runAcquisition(AcquisitionAction.Stop);
  }

  public single(): Promise<void> {
    return this.runAcquisition(AcquisitionAction.Single);
  }

  public async sleep(): Promise<void> {
    if (useScopeStore.getState().sleepPending) {
      return;
    }

    useScopeStore.setState({ sleepPending: true });
    try {
      await this.binding.sleep();
    } catch (error) {
      this.surfaceError(error);
    } finally {
      useScopeStore.setState({ sleepPending: false });
    }
  }

  public async deepCapture(): Promise<void> {
    try {
      await this.binding.deepCapture();
    } catch (error) {
      this.surfaceError(error);
    }
  }

  public setMeasurementSource(source: MeasurementSource): void {
    const store = useScopeStore.getState();
    store.setMeasurementSource(source);
    const measurements = source === MeasurementSource.Scope
      ? useScopeStore.getState().measurementSpecs
      : [];
    void this.binding.setMeasurements(measurements).catch((error: unknown) => {
      this.surfaceError(error);
    });
  }

  public setMeasurementSpecs(measurements: MeasurementSpec[]): void {
    useScopeStore.getState().setMeasurementSpecs(measurements);
    if (useScopeStore.getState().measurementSource !== MeasurementSource.Scope) {
      return;
    }
    void this.binding.setMeasurements(measurements).catch((error: unknown) => {
      this.surfaceError(error);
    });
  }

  public startMeasurementPolling(intervalMs = 1000): () => void {
    const poll = () => {
      void this.pollMeasurementsOnce();
    };
    poll();
    const timer = window.setInterval(poll, intervalMs);
    return () => window.clearInterval(timer);
  }

  public async pollMeasurementsOnce(): Promise<void> {
    const store = useScopeStore.getState();
    if (
      store.measurementSource !== MeasurementSource.Scope ||
      store.measurementSpecs.length === 0 ||
      this.measurementInFlight
    ) {
      return;
    }

    const [first, ...rest] = store.measurementSpecs;
    if (first === undefined) {
      return;
    }

    this.measurementInFlight = true;
    try {
      const response = await this.binding.readMeasurements([first, ...rest]);
      useScopeStore.getState().setMeasurementValues(response.values);
    } catch (error) {
      this.surfaceError(error);
    } finally {
      this.measurementInFlight = false;
    }
  }

  private setControl(control: ControlChange): Promise<void> {
    useScopeStore.getState().applyOptimisticControl(control);
    return this.binding.setControl(control).catch((error: unknown) => {
      this.surfaceError(error);
    });
  }

  private previewInteraction(control: InteractiveControl): void {
    useScopeStore.getState().applyOptimisticControl(control);
    this.pendingInteraction = control;
    if (this.interactionTimer !== null) {
      return;
    }

    this.interactionTimer = window.setTimeout(() => {
      this.interactionTimer = null;
      const pending = this.pendingInteraction;
      this.pendingInteraction = null;
      if (pending === null) {
        return;
      }
      try {
        this.binding.interactionUpdate(pending);
      } catch (error) {
        this.surfaceError(error);
      }
    }, INTERACTION_UPDATE_INTERVAL_MS);
  }

  private commitInteraction(control: InteractiveControl): Promise<void> {
    if (this.interactionTimer !== null) {
      window.clearTimeout(this.interactionTimer);
      this.interactionTimer = null;
    }
    this.pendingInteraction = null;
    useScopeStore.getState().applyOptimisticControl(control);
    return this.binding.interactionCommit(control).catch((error: unknown) => {
      this.surfaceError(error);
    });
  }

  private runAcquisition(action: AcquisitionAction): Promise<void> {
    return this.binding.acquisition(action).catch((error: unknown) => {
      this.surfaceError(error);
    });
  }

  private surfaceError(error: unknown): void {
    useScopeStore.getState().setError(
      error instanceof Error ? error.message : String(error),
    );
  }
}
