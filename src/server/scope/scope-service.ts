import type {
  MeasurementSpec,
  MeasurementValue,
  ScopeState,
} from "../../shared/scope-types.js";
import type {
  AcquisitionAction,
  ControlChange,
  InteractiveControl,
  NonEmptyArray,
} from "../../shared/websocket-protocol.js";
import type {
  ScopeConnection,
} from "../instruments/instrument-connection.js";
import {
  ScopeConnectionKind,
} from "../instruments/instrument-connection.js";
import { ScopeRuntime, type ScopeRuntimeOptions, type ScopeRuntimeSession } from "../scope-runtime.js";
import type {
  DeepCaptureInfo,
  DeepViewportRequest,
} from "../waveform/deep-capture-service.js";
import { Dho804PowerControl } from "./dho804-power-control.js";
import { ScopeController } from "./scope-controller.js";
import { ScopePowerLifecycle } from "./scope-power-lifecycle.js";

const DEFAULT_SCOPE_ADB_PORT = 55_555;

export type ScopeConnectionListener = (connection: ScopeConnection) => void;
export type ScopeStateListener = (state: ScopeState) => void;
export type ScopeWaveformListener = (frame: Uint8Array) => void;

export interface ScopeApplicationService {
  getConnection(): ScopeConnection;
  subscribeConnection(listener: ScopeConnectionListener): () => void;
  subscribeState(listener: ScopeStateListener): () => void;
  subscribeWaveform(listener: ScopeWaveformListener): () => void;
  setControl(control: ControlChange): Promise<void>;
  updateInteraction(control: InteractiveControl): Promise<void>;
  commitInteraction(control: InteractiveControl): Promise<void>;
  performAcquisitionAction(action: AcquisitionAction): Promise<void>;
  sleep(): Promise<void>;
  readMeasurements(measurements: NonEmptyArray<MeasurementSpec>): Promise<MeasurementValue[]>;
  setMeasurements(measurements: MeasurementSpec[]): Promise<void>;
  executeRawScpi(command: string): Promise<string>;
  captureDeep(): Promise<DeepCaptureInfo>;
  requestViewport(request: DeepViewportRequest): Promise<Uint8Array>;
  pauseLiveWaveform(): Promise<void>;
  resumeLiveWaveform(): void;
}

export type ScopeServiceOptions = Omit<
  ScopeRuntimeOptions,
  "publishConnection" | "publishState" | "publishWaveform"
> & {
  adbPort?: number;
};

export class ScopeService implements ScopeApplicationService {
  public readonly runtime: ScopeRuntime;

  private connection: ScopeConnection = {
    kind: ScopeConnectionKind.Disconnected,
    reason: "Scope runtime inactive",
  };
  private readonly connectionListeners = new Set<ScopeConnectionListener>();
  private readonly stateListeners = new Set<ScopeStateListener>();
  private readonly waveformListeners = new Set<ScopeWaveformListener>();
  private readonly controllers = new WeakMap<ScopeRuntimeSession, ScopeController>();
  private readonly powerLifecycle: ScopePowerLifecycle;

  public constructor(options: ScopeServiceOptions) {
    const {
      adbPort = DEFAULT_SCOPE_ADB_PORT,
      ...runtimeOptions
    } = options;
    if (!Number.isInteger(adbPort) || adbPort < 1 || adbPort > 65_535) {
      throw new Error("RIGOL_SCOPE_ADB_PORT must be an integer from 1 through 65535");
    }

    this.runtime = new ScopeRuntime({
      ...runtimeOptions,
      publishConnection: (connection) => this.acceptConnection(connection),
      publishState: (state) => this.acceptState(state),
      publishWaveform: (frame) => this.publishWaveform(frame),
    });
    this.powerLifecycle = new ScopePowerLifecycle(
      runtimeOptions.host,
      runtimeOptions.port,
      this.runtime,
      new Dho804PowerControl(runtimeOptions.host, adbPort),
    );
  }

  public getConnection(): ScopeConnection {
    return this.connection;
  }

  public subscribeConnection(listener: ScopeConnectionListener): () => void {
    this.connectionListeners.add(listener);
    return () => this.connectionListeners.delete(listener);
  }

  public subscribeState(listener: ScopeStateListener): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  public subscribeWaveform(listener: ScopeWaveformListener): () => void {
    this.waveformListeners.add(listener);
    return () => this.waveformListeners.delete(listener);
  }

  public async setControl(control: ControlChange): Promise<void> {
    const session = this.runtime.requireSession();
    await this.controllerFor(session).setControl(control);
    this.runtime.requireSameSession(session);
  }

  public async updateInteraction(control: InteractiveControl): Promise<void> {
    const session = this.runtime.requireSession();
    await this.controllerFor(session).updateInteraction(control);
    this.runtime.requireSameSession(session);
  }

  public async commitInteraction(control: InteractiveControl): Promise<void> {
    const session = this.runtime.requireSession();
    await this.controllerFor(session).commitInteraction(control);
    this.runtime.requireSameSession(session);
  }

  public async performAcquisitionAction(action: AcquisitionAction): Promise<void> {
    const session = this.runtime.requireSession();
    await this.controllerFor(session).performAcquisitionAction(action);
    this.runtime.requireSameSession(session);
  }

  public sleep(): Promise<void> {
    return this.powerLifecycle.sleep();
  }

  public async readMeasurements(
    measurements: NonEmptyArray<MeasurementSpec>,
  ): Promise<MeasurementValue[]> {
    const session = this.runtime.requireSession();
    const values = await this.controllerFor(session).readMeasurements(measurements);
    this.runtime.requireSameSession(session);
    return values;
  }

  public async setMeasurements(measurements: MeasurementSpec[]): Promise<void> {
    const session = this.runtime.requireSession();
    await this.controllerFor(session).setMeasurements(measurements);
    this.runtime.requireSameSession(session);
  }

  public async executeRawScpi(command: string): Promise<string> {
    const session = this.runtime.requireSession();
    const response = await this.controllerFor(session).executeRawScpi(command);
    this.runtime.requireSameSession(session);
    return response;
  }

  public async captureDeep(): Promise<DeepCaptureInfo> {
    const session = this.runtime.requireSession();
    const capture = await session.deep.capture();
    this.runtime.requireSameSession(session);
    return capture;
  }

  public async requestViewport(request: DeepViewportRequest): Promise<Uint8Array> {
    const session = this.runtime.requireSession();
    const frame = session.deep.getViewport(request);
    this.runtime.requireSameSession(session);
    return frame;
  }

  public async pauseLiveWaveform(): Promise<void> {
    await this.runtime.getSession()?.live.pause();
  }

  public resumeLiveWaveform(): void {
    this.runtime.getSession()?.live.resume();
  }

  public close(): void {
    this.powerLifecycle.close();
  }

  private controllerFor(session: ScopeRuntimeSession): ScopeController {
    const existing = this.controllers.get(session);
    if (existing !== undefined) {
      return existing;
    }
    const controller = new ScopeController(session.driver, session.stateStore);
    this.controllers.set(session, controller);
    return controller;
  }

  private acceptConnection(connection: ScopeConnection): void {
    this.connection = connection;
    for (const listener of this.connectionListeners) {
      listener(connection);
    }
  }

  private acceptState(state: ScopeState): void {
    if (this.connection.kind === ScopeConnectionKind.Connected) {
      this.connection = { ...this.connection, state };
    }
    for (const listener of this.stateListeners) {
      listener(state);
    }
  }

  private publishWaveform(frame: Uint8Array): void {
    for (const listener of this.waveformListeners) {
      listener(frame);
    }
  }
}
