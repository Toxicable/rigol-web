from pathlib import Path
import re

ROOT = Path('.')


def write(path: str, content: str) -> None:
    target = ROOT / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding='utf-8')


def replace_once(path: str, old: str, new: str) -> None:
    target = ROOT / path
    text = target.read_text(encoding='utf-8')
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f'{path}: expected exactly one replacement, found {count}: {old[:120]!r}')
    target.write_text(text.replace(old, new), encoding='utf-8')


def regex_once(path: str, pattern: str, replacement: str, flags: int = 0) -> None:
    target = ROOT / path
    text = target.read_text(encoding='utf-8')
    updated, count = re.subn(pattern, replacement, text, count=1, flags=flags)
    if count != 1:
        raise RuntimeError(f'{path}: regex did not match exactly once: {pattern[:120]!r}')
    target.write_text(updated, encoding='utf-8')


write('src/server/instruments/instrument-connection.ts', r'''import type { DmmInfo, DmmState } from "../../shared/dmm-types.js";
import type { ScopeInfo, ScopeState } from "../../shared/scope-types.js";

export enum ScopeConnectionKind {
  Disconnected = 1,
  Connected = 2,
}

export type ScopeConnection =
  | {
      kind: ScopeConnectionKind.Disconnected;
      reason: string;
    }
  | {
      kind: ScopeConnectionKind.Connected;
      info: ScopeInfo;
      state: ScopeState;
    };

export enum DmmConnectionKind {
  Disconnected = 1,
  Connected = 2,
}

export type DmmConnection =
  | {
      kind: DmmConnectionKind.Disconnected;
      reason: string;
    }
  | {
      kind: DmmConnectionKind.Connected;
      info: DmmInfo;
      state: DmmState;
    };
''')

write('src/server/scope-runtime.ts', r'''import type { ScopeInfo, ScopeState } from "../shared/scope-types.js";
import {
  ScopeConnectionKind,
  type ScopeConnection,
} from "./instruments/instrument-connection.js";
import { ScpiPriority, ScpiScheduler } from "./scpi/scpi-scheduler.js";
import { ScpiTransport } from "./scpi/scpi-transport.js";
import { Dho804Driver } from "./scope/dho804-driver.js";
import { ScopeStateStore } from "./scope/scope-state-store.js";
import { DeepCaptureService } from "./waveform/deep-capture-service.js";
import { LiveWaveformService } from "./waveform/live-waveform-service.js";

const DEFAULT_RECONNECT_DELAY_MS = 2_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 3_000;

interface FailureSignal {
  promise: Promise<Error>;
  fail(error: unknown): void;
}

export interface ScopeRuntimeSession {
  readonly info: ScopeInfo;
  readonly driver: Dho804Driver;
  readonly stateStore: ScopeStateStore;
  readonly live: LiveWaveformService;
  readonly deep: DeepCaptureService;
}

interface OwnedScopeSession extends ScopeRuntimeSession {
  transport: ScpiTransport;
  scheduler: ScpiScheduler;
  unsubscribeState: () => void;
  failure: FailureSignal;
}

export interface ScopeRuntimeOptions {
  host: string;
  port: number;
  publishConnection: (connection: ScopeConnection) => void;
  publishState: (state: ScopeState) => void;
  publishWaveform: (frame: Uint8Array) => void;
  reconnectDelayMs?: number;
  connectTimeoutMs?: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function createFailureSignal(): FailureSignal {
  let resolve!: (error: Error) => void;
  let failed = false;
  const promise = new Promise<Error>((resolver) => {
    resolve = resolver;
  });

  return {
    promise,
    fail: (error) => {
      if (failed) {
        return;
      }
      failed = true;
      resolve(asError(error));
    },
  };
}

export class ScopeRuntime {
  private readonly host: string;
  private readonly port: number;
  private readonly reconnectDelayMs: number;
  private readonly connectTimeoutMs: number;
  private readonly publishConnection: ScopeRuntimeOptions["publishConnection"];
  private readonly publishState: ScopeRuntimeOptions["publishState"];
  private readonly publishWaveform: ScopeRuntimeOptions["publishWaveform"];
  private running = false;
  private loopPromise: Promise<void> | null = null;
  private session: OwnedScopeSession | null = null;
  private initializingTransport: ScpiTransport | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryResolve: (() => void) | null = null;
  private disconnectedReason = "Scope runtime inactive";

  public constructor(options: ScopeRuntimeOptions) {
    if (options.host.trim().length === 0) {
      throw new Error("RIGOL_SCOPE_HOST must be a non-empty string");
    }
    if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65_535) {
      throw new Error("RIGOL_SCOPE_PORT must be an integer from 1 through 65535");
    }
    const reconnectDelayMs = options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;
    if (!Number.isFinite(reconnectDelayMs) || reconnectDelayMs < 0) {
      throw new Error("reconnectDelayMs must be a non-negative finite number");
    }
    const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    if (!Number.isFinite(connectTimeoutMs) || connectTimeoutMs <= 0) {
      throw new Error("connectTimeoutMs must be a positive finite number");
    }

    this.host = options.host;
    this.port = options.port;
    this.reconnectDelayMs = reconnectDelayMs;
    this.connectTimeoutMs = connectTimeoutMs;
    this.publishConnection = options.publishConnection;
    this.publishState = options.publishState;
    this.publishWaveform = options.publishWaveform;
  }

  public start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.disconnectedReason = "Scope connection pending";
    this.publishConnection({
      kind: ScopeConnectionKind.Disconnected,
      reason: this.disconnectedReason,
    });
    this.loopPromise = this.runLoop();
  }

  public async stop(): Promise<void> {
    if (!this.running && this.loopPromise === null) {
      return;
    }

    this.running = false;
    this.disconnectedReason = "Scope runtime inactive";
    this.publishConnection({
      kind: ScopeConnectionKind.Disconnected,
      reason: this.disconnectedReason,
    });
    this.wakeRetryDelay();
    this.initializingTransport?.disconnect();
    this.session?.failure.fail(new Error("Scope runtime stopped"));

    const loop = this.loopPromise;
    if (loop !== null) {
      await loop;
    }
    this.loopPromise = null;
  }

  public getSession(): ScopeRuntimeSession | null {
    return this.session;
  }

  public requireSession(): ScopeRuntimeSession {
    const session = this.session;
    if (session === null) {
      throw new Error(`Scope disconnected: ${this.disconnectedReason}`);
    }
    return session;
  }

  public requireSameSession(session: ScopeRuntimeSession): void {
    if (this.session !== session) {
      throw new Error("Scope session changed while request was in flight");
    }
  }

  private async runLoop(): Promise<void> {
    while (this.running) {
      let session: OwnedScopeSession | null = null;
      try {
        session = await this.createSession();
        if (!this.running) {
          await this.disposeSession(session, new Error("Scope runtime stopped"));
          break;
        }

        this.session = session;
        this.publishConnection({
          kind: ScopeConnectionKind.Connected,
          info: session.info,
          state: session.stateStore.getState(),
        });
        session.live.start();

        const failure = await session.failure.promise;
        if (this.session === session) {
          this.session = null;
        }
        if (this.running) {
          this.publishDisconnected(failure);
        }
        await this.disposeSession(session, failure);

        if (!this.running) {
          break;
        }
      } catch (error) {
        if (session !== null) {
          if (this.session === session) {
            this.session = null;
          }
          if (this.running) {
            this.publishDisconnected(error);
          }
          await this.disposeSession(session, asError(error));
        } else if (this.running) {
          this.publishDisconnected(error);
        }

        if (!this.running) {
          break;
        }
      }

      if (this.running) {
        await this.waitRetryDelay();
      }
    }
  }

  private async createSession(): Promise<OwnedScopeSession> {
    const transport = new ScpiTransport();
    let scheduler: ScpiScheduler | null = null;
    this.initializingTransport = transport;

    try {
      await this.connectTransport(transport);
      scheduler = new ScpiScheduler(transport);
      const driver = new Dho804Driver(scheduler);
      const info = await driver.identify();
      const initialState = await driver.readScopeState(ScpiPriority.Normal);
      const stateStore = new ScopeStateStore(initialState);
      const failure = createFailureSignal();
      const live = new LiveWaveformService({
        driver,
        getScopeState: () => stateStore.getState(),
        publishFrame: this.publishWaveform,
        reportError: (error) => {
          if (!transport.isUsable()) {
            failure.fail(error);
            return;
          }
          console.error("Live waveform acquisition failed", error);
        },
      });
      const deep = new DeepCaptureService(driver);
      const unsubscribeState = stateStore.subscribe((state) => {
        const session = this.session;
        if (session === null || session.stateStore !== stateStore) {
          return;
        }
        live.requestFresh();
        this.publishState(state);
      });

      return {
        info,
        transport,
        scheduler,
        driver,
        stateStore,
        live,
        deep,
        unsubscribeState,
        failure,
      };
    } catch (error) {
      scheduler?.stop(asError(error));
      transport.disconnect();
      throw error;
    } finally {
      if (this.initializingTransport === transport) {
        this.initializingTransport = null;
      }
    }
  }

  private async connectTransport(transport: ScpiTransport): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`SCPI connection timed out after ${this.connectTimeoutMs} ms`));
        transport.disconnect();
      }, this.connectTimeoutMs);
    });

    try {
      await Promise.race([
        transport.connect(this.host, this.port),
        timeout,
      ]);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }

  private async disposeSession(session: OwnedScopeSession, reason: Error): Promise<void> {
    session.unsubscribeState();
    session.live.stop();
    session.scheduler.stop(reason);
    session.transport.disconnect();
    await session.live.waitForIdle();
  }

  private publishDisconnected(error: unknown): void {
    this.disconnectedReason = errorMessage(error);
    this.publishConnection({
      kind: ScopeConnectionKind.Disconnected,
      reason: this.disconnectedReason,
    });
  }

  private waitRetryDelay(): Promise<void> {
    if (this.reconnectDelayMs === 0) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.retryResolve = resolve;
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        this.retryResolve = null;
        resolve();
      }, this.reconnectDelayMs);
    });
  }

  private wakeRetryDelay(): void {
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    const resolve = this.retryResolve;
    this.retryResolve = null;
    resolve?.();
  }
}
''')

write('src/server/scope/scope-service.ts', r'''import type {
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
import { ScopeController } from "./scope-controller.js";

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
>;

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

  public constructor(options: ScopeServiceOptions) {
    this.runtime = new ScopeRuntime({
      ...options,
      publishConnection: (connection) => this.acceptConnection(connection),
      publishState: (state) => this.acceptState(state),
      publishWaveform: (frame) => this.publishWaveform(frame),
    });
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
''')

write('src/server/dmm/dmm-runtime.ts', r'''import type {
  DmmInfo,
  DmmReadingSnapshot,
  DmmState,
} from "../../shared/dmm-types.js";
import {
  DmmConnectionKind,
  type DmmConnection,
} from "../instruments/instrument-connection.js";
import { ScpiScheduler } from "../scpi/scpi-scheduler.js";
import { ScpiTransport } from "../scpi/scpi-transport.js";
import { Dm858eDriver } from "./dm858e-driver.js";
import { DmmPoller } from "./dmm-poller.js";
import { DmmStateStore } from "./dmm-state-store.js";

const DEFAULT_RECONNECT_DELAY_MS = 2_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 3_000;

interface FailureSignal {
  promise: Promise<Error>;
  fail(error: unknown): void;
}

export interface DmmRuntimeSession {
  readonly info: DmmInfo;
  readonly driver: Dm858eDriver;
  readonly stateStore: DmmStateStore;
}

interface OwnedDmmSession extends DmmRuntimeSession {
  transport: ScpiTransport;
  scheduler: ScpiScheduler;
  poller: DmmPoller;
  unsubscribeState: () => void;
  failure: FailureSignal;
}

export interface DmmRuntimeOptions {
  host: string;
  port: number;
  publishConnection: (connection: DmmConnection) => void;
  publishState: (state: DmmState) => void;
  publishSnapshot: (snapshot: DmmReadingSnapshot) => void;
  reconnectDelayMs?: number;
  connectTimeoutMs?: number;
}

export class DmmRuntime {
  private readonly host: string;
  private readonly port: number;
  private readonly reconnectDelayMs: number;
  private readonly connectTimeoutMs: number;
  private readonly publishConnection: DmmRuntimeOptions["publishConnection"];
  private readonly publishState: DmmRuntimeOptions["publishState"];
  private readonly publishSnapshot: DmmRuntimeOptions["publishSnapshot"];
  private running = false;
  private loopPromise: Promise<void> | null = null;
  private session: OwnedDmmSession | null = null;
  private initializingTransport: ScpiTransport | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryResolve: (() => void) | null = null;
  private disconnectedReason = "DMM runtime inactive";

  public constructor(options: DmmRuntimeOptions) {
    if (options.host.trim().length === 0) {
      throw new Error("RIGOL_DMM_HOST must be a non-empty string");
    }
    if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65_535) {
      throw new Error("RIGOL_DMM_PORT must be an integer from 1 through 65535");
    }

    const reconnectDelayMs = options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;
    if (!Number.isFinite(reconnectDelayMs) || reconnectDelayMs < 0) {
      throw new Error("reconnectDelayMs must be a non-negative finite number");
    }
    const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    if (!Number.isFinite(connectTimeoutMs) || connectTimeoutMs <= 0) {
      throw new Error("connectTimeoutMs must be a positive finite number");
    }

    this.host = options.host;
    this.port = options.port;
    this.reconnectDelayMs = reconnectDelayMs;
    this.connectTimeoutMs = connectTimeoutMs;
    this.publishConnection = options.publishConnection;
    this.publishState = options.publishState;
    this.publishSnapshot = options.publishSnapshot;
  }

  public start(): void {
    if (this.running) {
      return;
    }

    this.running = true;
    this.disconnectedReason = "DMM connection pending";
    this.publishConnection({
      kind: DmmConnectionKind.Disconnected,
      reason: this.disconnectedReason,
    });
    this.loopPromise = this.runLoop();
  }

  public async stop(): Promise<void> {
    if (!this.running && this.loopPromise === null) {
      return;
    }

    this.running = false;
    const session = this.session;
    this.session = null;
    this.disconnectedReason = "DMM runtime inactive";
    this.publishConnection({
      kind: DmmConnectionKind.Disconnected,
      reason: this.disconnectedReason,
    });
    this.wakeRetryDelay();
    this.initializingTransport?.disconnect();
    session?.failure.fail(new Error("DMM runtime stopped"));

    const loop = this.loopPromise;
    if (loop !== null) {
      await loop;
    }
    this.loopPromise = null;
  }

  public requireSession(): DmmRuntimeSession {
    const session = this.session;
    if (session === null) {
      throw new Error(`DMM disconnected: ${this.disconnectedReason}`);
    }
    return session;
  }

  public requireSameSession(session: DmmRuntimeSession): void {
    if (this.session !== session) {
      throw new Error("DMM session changed while request was in flight");
    }
  }

  public failSessionIfTransportLost(session: DmmRuntimeSession, error: unknown): void {
    const owned = session as OwnedDmmSession;
    if (!owned.transport.isUsable()) {
      owned.failure.fail(error);
    }
  }

  private async runLoop(): Promise<void> {
    while (this.running) {
      let session: OwnedDmmSession | null = null;
      try {
        session = await this.createSession();
        if (!this.running) {
          await this.disposeSession(session, new Error("DMM runtime stopped"));
          break;
        }

        this.session = session;
        this.publishConnection({
          kind: DmmConnectionKind.Connected,
          info: session.info,
          state: session.stateStore.getState(),
        });
        session.poller.start();

        const failure = await session.failure.promise;
        if (this.session === session) {
          this.session = null;
        }
        if (this.running) {
          this.publishDisconnected(failure);
        }
        await this.disposeSession(session, failure);

        if (!this.running) {
          break;
        }
      } catch (error) {
        if (session !== null) {
          if (this.session === session) {
            this.session = null;
          }
          if (this.running) {
            this.publishDisconnected(error);
          }
          await this.disposeSession(session, asError(error));
        } else if (this.running) {
          this.publishDisconnected(error);
        }

        if (!this.running) {
          break;
        }
      }

      if (this.running) {
        await this.waitRetryDelay();
      }
    }
  }

  private async createSession(): Promise<OwnedDmmSession> {
    const transport = new ScpiTransport();
    let scheduler: ScpiScheduler | null = null;
    this.initializingTransport = transport;

    try {
      await this.connectTransport(transport);
      scheduler = new ScpiScheduler(transport);
      const driver = new Dm858eDriver(scheduler);
      const info = await driver.identify();
      const initialState = await driver.readDmmState();
      const stateStore = new DmmStateStore(initialState);
      const failure = createFailureSignal();
      const poller = new DmmPoller({
        driver,
        stateStore,
        publishSnapshot: (snapshot) => {
          const session = this.session;
          if (
            session === null ||
            session.stateStore !== stateStore ||
            snapshot.function !== stateStore.getState().function
          ) {
            return;
          }
          this.publishSnapshot(snapshot);
        },
        reportError: (error) => failure.fail(error),
      });
      const unsubscribeState = stateStore.subscribe((state) => {
        const session = this.session;
        if (session === null || session.stateStore !== stateStore) {
          return;
        }
        this.publishState(state);
      });

      return {
        info,
        transport,
        scheduler,
        driver,
        stateStore,
        poller,
        unsubscribeState,
        failure,
      };
    } catch (error) {
      scheduler?.stop(asError(error));
      transport.disconnect();
      throw error;
    } finally {
      if (this.initializingTransport === transport) {
        this.initializingTransport = null;
      }
    }
  }

  private async connectTransport(transport: ScpiTransport): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`SCPI connection timed out after ${this.connectTimeoutMs} ms`));
        transport.disconnect();
      }, this.connectTimeoutMs);
    });

    try {
      await Promise.race([
        transport.connect(this.host, this.port),
        timeout,
      ]);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }

  private async disposeSession(session: OwnedDmmSession, reason: Error): Promise<void> {
    session.unsubscribeState();
    session.poller.stop();
    session.scheduler.stop(reason);
    session.transport.disconnect();
    await session.poller.waitForIdle();
  }

  private publishDisconnected(error: unknown): void {
    this.disconnectedReason = errorMessage(error);
    this.publishConnection({
      kind: DmmConnectionKind.Disconnected,
      reason: this.disconnectedReason,
    });
  }

  private waitRetryDelay(): Promise<void> {
    if (this.reconnectDelayMs === 0) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      this.retryResolve = resolve;
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        this.retryResolve = null;
        resolve();
      }, this.reconnectDelayMs);
    });
  }

  private wakeRetryDelay(): void {
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    const resolve = this.retryResolve;
    this.retryResolve = null;
    resolve?.();
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function createFailureSignal(): FailureSignal {
  let resolve!: (error: Error) => void;
  let failed = false;
  const promise = new Promise<Error>((resolver) => {
    resolve = resolver;
  });

  return {
    promise,
    fail: (error) => {
      if (failed) {
        return;
      }
      failed = true;
      resolve(asError(error));
    },
  };
}
''')

write('src/server/dmm/dmm-service.ts', r'''import {
  DmmControlKind,
  DmmReadingKind,
  DmmReadingUnavailableReason,
  dmmUnitForFunction,
  type DmmControlChange,
  type DmmMeasurementFunction,
  type DmmReadingSnapshot,
  type DmmState,
} from "../../shared/dmm-types.js";
import {
  DmmConnectionKind,
  type DmmConnection,
} from "../instruments/instrument-connection.js";
import { ScpiPriority } from "../scpi/scpi-scheduler.js";
import {
  DmmRuntime,
  type DmmRuntimeOptions,
  type DmmRuntimeSession,
} from "./dmm-runtime.js";

export type DmmConnectionListener = (connection: DmmConnection) => void;
export type DmmStateListener = (state: DmmState) => void;
export type DmmSnapshotListener = (snapshot: DmmReadingSnapshot) => void;

export interface DmmApplicationService {
  getConnection(): DmmConnection;
  getCurrentSnapshot(): DmmReadingSnapshot | null;
  subscribeConnection(listener: DmmConnectionListener): () => void;
  subscribeState(listener: DmmStateListener): () => void;
  subscribeSnapshot(listener: DmmSnapshotListener): () => void;
  setControl(control: DmmControlChange): Promise<void>;
  executeRawScpi(command: string): Promise<string>;
}

export type DmmServiceOptions = Omit<
  DmmRuntimeOptions,
  "publishConnection" | "publishState" | "publishSnapshot"
>;

export class DmmService implements DmmApplicationService {
  public readonly runtime: DmmRuntime;

  private connection: DmmConnection = {
    kind: DmmConnectionKind.Disconnected,
    reason: "DMM runtime inactive",
  };
  private currentSnapshot: DmmReadingSnapshot | null = null;
  private mutationTail: Promise<void> = Promise.resolve();
  private readonly connectionListeners = new Set<DmmConnectionListener>();
  private readonly stateListeners = new Set<DmmStateListener>();
  private readonly snapshotListeners = new Set<DmmSnapshotListener>();

  public constructor(options: DmmServiceOptions) {
    this.runtime = new DmmRuntime({
      ...options,
      publishConnection: (connection) => this.acceptConnection(connection),
      publishState: (state) => this.acceptState(state),
      publishSnapshot: (snapshot) => this.acceptSnapshot(snapshot),
    });
  }

  public getConnection(): DmmConnection {
    return this.connection;
  }

  public getCurrentSnapshot(): DmmReadingSnapshot | null {
    return this.currentSnapshot;
  }

  public subscribeConnection(listener: DmmConnectionListener): () => void {
    this.connectionListeners.add(listener);
    return () => this.connectionListeners.delete(listener);
  }

  public subscribeState(listener: DmmStateListener): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  public subscribeSnapshot(listener: DmmSnapshotListener): () => void {
    this.snapshotListeners.add(listener);
    return () => this.snapshotListeners.delete(listener);
  }

  public replayCurrentSnapshot(): void {
    if (this.currentSnapshot !== null) {
      this.publishSnapshot(this.currentSnapshot);
    }
  }

  public async setControl(control: DmmControlChange): Promise<void> {
    const session = this.runtime.requireSession();
    await this.serializeMutation(session, async () => {
      try {
        switch (control.kind) {
          case DmmControlKind.Function:
            await session.driver.setFunction(control.value);
            break;
          case DmmControlKind.Range: {
            const current = await session.driver.readDmmState(ScpiPriority.Immediate);
            this.runtime.requireSameSession(session);
            requireExpectedFunction(current.function, control.function);
            if (current.range === null) {
              throw new Error("Current DMM function does not expose a range control");
            }
            await session.driver.setRange(control.function, control.value);
            break;
          }
          case DmmControlKind.AcquisitionRate: {
            const current = await session.driver.readDmmState(ScpiPriority.Immediate);
            this.runtime.requireSameSession(session);
            requireExpectedFunction(current.function, control.function);
            if (current.acquisitionRate === null || current.range === null) {
              throw new Error("Current DMM function does not expose an acquisition-rate control");
            }
            await session.driver.setAcquisitionRate(control.function, control.value);
            break;
          }
        }

        this.runtime.requireSameSession(session);
        const state = await session.driver.readDmmState(ScpiPriority.Immediate);
        this.runtime.requireSameSession(session);
        session.stateStore.replaceState(state);
      } catch (error) {
        this.runtime.failSessionIfTransportLost(session, error);
        throw error;
      }
    });
  }

  public async executeRawScpi(command: string): Promise<string> {
    const session = this.runtime.requireSession();
    return this.serializeMutation(session, async () => {
      try {
        const response = await session.driver.executeRawScpi(command);
        this.runtime.requireSameSession(session);
        const state = await session.driver.readDmmState(ScpiPriority.Immediate);
        this.runtime.requireSameSession(session);
        session.stateStore.replaceState(state);
        return response;
      } catch (error) {
        this.runtime.failSessionIfTransportLost(session, error);
        throw error;
      }
    });
  }

  private async serializeMutation<T>(
    session: DmmRuntimeSession,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.mutationTail;
    let release!: () => void;
    this.mutationTail = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      this.runtime.requireSameSession(session);
      return await operation();
    } finally {
      release();
    }
  }

  private acceptConnection(connection: DmmConnection): void {
    this.connection = connection;
    if (connection.kind === DmmConnectionKind.Disconnected) {
      this.currentSnapshot = null;
    }
    for (const listener of this.connectionListeners) {
      listener(connection);
    }
  }

  private acceptState(state: DmmState): void {
    if (this.connection.kind === DmmConnectionKind.Connected) {
      this.connection = { ...this.connection, state };
    }

    let invalidatedSnapshot: DmmReadingSnapshot | null = null;
    if (this.currentSnapshot !== null) {
      invalidatedSnapshot = {
        kind: DmmReadingKind.Unavailable,
        function: state.function,
        unit: dmmUnitForFunction(state.function),
        reason: DmmReadingUnavailableReason.ConfigurationChanged,
      };
      this.currentSnapshot = invalidatedSnapshot;
    }

    for (const listener of this.stateListeners) {
      listener(state);
    }
    if (invalidatedSnapshot !== null) {
      this.publishSnapshot(invalidatedSnapshot);
    }
  }

  private acceptSnapshot(snapshot: DmmReadingSnapshot): void {
    if (
      this.connection.kind !== DmmConnectionKind.Connected ||
      snapshot.function !== this.connection.state.function ||
      sameSnapshot(snapshot, this.currentSnapshot)
    ) {
      return;
    }

    this.currentSnapshot = snapshot;
    this.publishSnapshot(snapshot);
  }

  private publishSnapshot(snapshot: DmmReadingSnapshot): void {
    for (const listener of this.snapshotListeners) {
      listener(snapshot);
    }
  }
}

function sameSnapshot(
  left: DmmReadingSnapshot,
  right: DmmReadingSnapshot | null,
): boolean {
  if (
    right === null ||
    left.kind !== right.kind ||
    left.function !== right.function ||
    left.unit !== right.unit
  ) {
    return false;
  }

  switch (left.kind) {
    case DmmReadingKind.Value:
      return (
        right.kind === DmmReadingKind.Value &&
        left.value === right.value &&
        left.resolution === right.resolution
      );
    case DmmReadingKind.Overload:
      return right.kind === DmmReadingKind.Overload;
    case DmmReadingKind.Unavailable:
      return right.kind === DmmReadingKind.Unavailable && left.reason === right.reason;
  }
}

function requireExpectedFunction(
  actual: DmmMeasurementFunction,
  expected: DmmMeasurementFunction,
): void {
  if (actual !== expected) {
    throw new Error("Stale DMM control: measurement function changed before the request was applied");
  }
}
''')

write('src/server/instruments/instrument-registry.ts', r'''import { SupportedInstrument } from "../../shared/instrument-types.js";
import { isRigolScpiLoggingEnabled } from "../logging.js";

export interface InstrumentEndpoint {
  host: string;
  port: number;
}

export interface InstrumentRuntime {
  start(): void | Promise<void>;
  stop(): void | Promise<void>;
}

interface InstrumentEntry {
  endpoint: InstrumentEndpoint;
  runtime: InstrumentRuntime;
  subscriberAdded?: () => void | Promise<void>;
  subscribers: Set<object>;
  running: boolean;
  suspended: boolean;
  revision: number;
  transition: Promise<void>;
}

export interface InstrumentRegistration {
  endpoint: InstrumentEndpoint;
  runtime: InstrumentRuntime;
  subscriberAdded?: () => void | Promise<void>;
}

export interface InstrumentRegistrations {
  dho804: InstrumentRegistration;
  dm858e: InstrumentRegistration;
}

function validateEndpoint(name: string, endpoint: InstrumentEndpoint): void {
  if (endpoint.host.trim().length === 0) {
    throw new Error(`${name} host must be a non-empty string`);
  }
  if (!Number.isInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65_535) {
    throw new Error(`${name} port must be an integer from 1 through 65535`);
  }
}

function debugLifecycle(
  event: string,
  instrument: SupportedInstrument,
  entry: InstrumentEntry,
): void {
  if (!isRigolScpiLoggingEnabled()) {
    return;
  }
  console.debug(`[SCPI] instrument ${event}`, {
    instrument,
    subscribers: entry.subscribers.size,
    running: entry.running,
    suspended: entry.suspended,
    revision: entry.revision,
    host: entry.endpoint.host,
    port: entry.endpoint.port,
  });
}

export class InstrumentRegistry {
  private readonly entries: Map<SupportedInstrument, InstrumentEntry>;

  public constructor(registrations: InstrumentRegistrations) {
    validateEndpoint("DHO804", registrations.dho804.endpoint);
    validateEndpoint("DM858E", registrations.dm858e.endpoint);

    this.entries = new Map([
      [SupportedInstrument.Dho804, this.createEntry(registrations.dho804)],
      [SupportedInstrument.Dm858e, this.createEntry(registrations.dm858e)],
    ]);
  }

  public isSubscribed(session: object, instrument: SupportedInstrument): boolean {
    return this.entry(instrument).subscribers.has(session);
  }

  public endpoint(instrument: SupportedInstrument): InstrumentEndpoint {
    return this.entry(instrument).endpoint;
  }

  public async subscribe(session: object, instrument: SupportedInstrument): Promise<void> {
    const entry = this.entry(instrument);
    if (entry.subscribers.has(session)) {
      await entry.transition;
      return;
    }

    entry.subscribers.add(session);
    entry.revision += 1;
    debugLifecycle("subscribe", instrument, entry);

    try {
      await this.queueReconcile(instrument, entry);
      if (entry.subscribers.has(session)) {
        await entry.subscriberAdded?.();
      }
    } catch (error) {
      if (entry.subscribers.delete(session)) {
        entry.revision += 1;
        debugLifecycle("subscribe-rollback", instrument, entry);
        await this.queueReconcile(instrument, entry).catch(() => undefined);
      }
      throw error;
    }
  }

  public unsubscribe(session: object, instrument: SupportedInstrument): Promise<void> {
    const entry = this.entry(instrument);
    if (!entry.subscribers.delete(session)) {
      return entry.transition;
    }

    entry.revision += 1;
    debugLifecycle("unsubscribe", instrument, entry);
    return this.queueReconcile(instrument, entry);
  }

  public suspend(instrument: SupportedInstrument): Promise<void> {
    const entry = this.entry(instrument);
    if (entry.suspended) {
      return entry.transition;
    }

    entry.suspended = true;
    entry.revision += 1;
    debugLifecycle("suspend", instrument, entry);
    return this.queueReconcile(instrument, entry);
  }

  public resume(instrument: SupportedInstrument): Promise<void> {
    const entry = this.entry(instrument);
    if (!entry.suspended) {
      return entry.transition;
    }

    entry.suspended = false;
    entry.revision += 1;
    debugLifecycle("resume", instrument, entry);
    return this.queueReconcile(instrument, entry);
  }

  public async releaseSession(session: object): Promise<void> {
    const transitions: Promise<void>[] = [];
    for (const [instrument, entry] of this.entries) {
      if (!entry.subscribers.delete(session)) {
        continue;
      }
      entry.revision += 1;
      debugLifecycle("release-session", instrument, entry);
      transitions.push(this.queueReconcile(instrument, entry));
    }
    await Promise.all(transitions);
  }

  public async stopAll(): Promise<void> {
    const transitions: Promise<void>[] = [];
    for (const [instrument, entry] of this.entries) {
      entry.subscribers.clear();
      entry.revision += 1;
      debugLifecycle("stop-all", instrument, entry);
      transitions.push(this.queueReconcile(instrument, entry));
    }
    await Promise.all(transitions);
  }

  private createEntry(registration: InstrumentRegistration): InstrumentEntry {
    return {
      endpoint: registration.endpoint,
      runtime: registration.runtime,
      subscriberAdded: registration.subscriberAdded,
      subscribers: new Set(),
      running: false,
      suspended: false,
      revision: 0,
      transition: Promise.resolve(),
    };
  }

  private entry(instrument: SupportedInstrument): InstrumentEntry {
    const entry = this.entries.get(instrument);
    if (entry === undefined) {
      throw new Error(`Unsupported instrument ${instrument}`);
    }
    return entry;
  }

  private queueReconcile(
    instrument: SupportedInstrument,
    entry: InstrumentEntry,
  ): Promise<void> {
    const transition = entry.transition.then(
      () => this.reconcile(instrument, entry),
      () => this.reconcile(instrument, entry),
    );
    entry.transition = transition.catch(() => undefined);
    return transition;
  }

  private async reconcile(
    instrument: SupportedInstrument,
    entry: InstrumentEntry,
  ): Promise<void> {
    while (true) {
      const revision = entry.revision;
      const shouldRun = entry.subscribers.size > 0 && !entry.suspended;

      if (shouldRun && !entry.running) {
        debugLifecycle("runtime-start", instrument, entry);
        await entry.runtime.start();
        entry.running = true;
        debugLifecycle("runtime-started", instrument, entry);
      } else if (!shouldRun && entry.running) {
        entry.running = false;
        debugLifecycle("runtime-stop", instrument, entry);
        await entry.runtime.stop();
        debugLifecycle("runtime-stopped", instrument, entry);
      }

      if (revision === entry.revision) {
        return;
      }
    }
  }
}
''')

write('src/server/server.ts', r'''import { createServer } from "node:http";

import { SupportedInstrument } from "../shared/instrument-types.js";
import { DmmService } from "./dmm/dmm-service.js";
import { createHttpRequestHandler } from "./http-handler.js";
import { InstrumentRegistry } from "./instruments/instrument-registry.js";
import { ScopeService } from "./scope/scope-service.js";
import { Dho804PowerControl } from "./scope/dho804-power-control.js";
import { waitForOfflineThenOnline } from "./scope/tcp-reachability-monitor.js";
import { WebSocketGateway } from "./websocket/websocket-gateway.js";

const HTTP_PORT_DEFAULT = 3_000;
const SCOPE_ADB_PORT_DEFAULT = 55_555;

function readHttpPort(): number {
  const value = Number(process.env.PORT ?? HTTP_PORT_DEFAULT);
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`Invalid PORT: ${process.env.PORT ?? ""}`);
  }
  return value;
}

function readInstrumentHost(name: "RIGOL_SCOPE_HOST" | "RIGOL_DMM_HOST"): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

function readInstrumentPort(name: "RIGOL_SCOPE_PORT" | "RIGOL_DMM_PORT"): number {
  const raw = process.env[name];
  const value = Number(raw);
  if (raw === undefined || raw.trim().length === 0 || !Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`${name} must be an integer from 1 through 65535`);
  }
  return value;
}

function readScopeAdbPort(): number {
  const raw = process.env.RIGOL_SCOPE_ADB_PORT?.trim();
  if (raw === undefined || raw.length === 0) {
    return SCOPE_ADB_PORT_DEFAULT;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error("RIGOL_SCOPE_ADB_PORT must be an integer from 1 through 65535");
  }
  return value;
}

const httpPort = readHttpPort();
const scopeEndpoint = {
  host: readInstrumentHost("RIGOL_SCOPE_HOST"),
  port: readInstrumentPort("RIGOL_SCOPE_PORT"),
};
const dmmEndpoint = {
  host: readInstrumentHost("RIGOL_DMM_HOST"),
  port: readInstrumentPort("RIGOL_DMM_PORT"),
};
const scopePower = new Dho804PowerControl(scopeEndpoint.host, readScopeAdbPort());

const scopeService = new ScopeService(scopeEndpoint);
const dmmService = new DmmService(dmmEndpoint);

const instruments = new InstrumentRegistry({
  dho804: {
    endpoint: scopeEndpoint,
    runtime: scopeService.runtime,
  },
  dm858e: {
    endpoint: dmmEndpoint,
    runtime: dmmService.runtime,
    subscriberAdded: () => dmmService.replayCurrentSnapshot(),
  },
});

let scopePhysicalWakeMonitor: AbortController | null = null;

function startScopePhysicalWakeMonitor(): void {
  scopePhysicalWakeMonitor?.abort();
  const controller = new AbortController();
  scopePhysicalWakeMonitor = controller;

  void waitForOfflineThenOnline(
    scopeEndpoint.host,
    scopeEndpoint.port,
    controller.signal,
  ).then(async (woke) => {
    if (!woke || controller.signal.aborted || scopePhysicalWakeMonitor !== controller) {
      return;
    }

    scopePhysicalWakeMonitor = null;
    console.log("[DHO804 sleep] SCPI endpoint reachable after physical wake; resuming runtime");
    try {
      await instruments.resume(SupportedInstrument.Dho804);
    } catch (error) {
      console.error("Failed to resume DHO804 SCPI runtime after physical wake", error);
    }
  }).catch((error) => {
    if (!controller.signal.aborted) {
      console.error("DHO804 physical-wake monitor failed", error);
    }
  });
}

const server = createServer(createHttpRequestHandler(undefined, {
  sleepScope: async () => {
    if (scopePhysicalWakeMonitor !== null) {
      throw new Error("DHO804 is already sleeping");
    }

    await instruments.suspend(SupportedInstrument.Dho804);
    try {
      await scopePower.sleep();
      startScopePhysicalWakeMonitor();
    } catch (error) {
      try {
        await instruments.resume(SupportedInstrument.Dho804);
      } catch (resumeError) {
        console.error("Failed to resume DHO804 SCPI runtime after Sleep failure", resumeError);
      }
      throw error;
    }
  },
}));

const gateway = new WebSocketGateway(server, {
  instruments,
  scopeService,
  dmmService,
});

let shuttingDown = false;

async function closeHttpServer(): Promise<void> {
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => {
      if (error !== undefined) {
        rejectClose(error);
        return;
      }
      resolveClose();
    });
  });
}

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  console.log(`Rigol Web shutting down on ${signal}`);
  scopePhysicalWakeMonitor?.abort();
  scopePhysicalWakeMonitor = null;

  try {
    await instruments.stopAll();
    await gateway.close();
    await closeHttpServer();
  } catch (error) {
    console.error("Rigol Web shutdown failed", error);
    process.exitCode = 1;
  }
}

process.once("SIGINT", () => {
  void shutdown("SIGINT");
});
process.once("SIGTERM", () => {
  void shutdown("SIGTERM");
});

server.once("error", (error) => {
  console.error("Rigol Web server failed", error);
  process.exitCode = 1;
});

server.listen(httpPort, () => {
  console.log(`Rigol Web server listening on http://localhost:${httpPort}`);
});
''')

# WebSocket gateway: keep transport/protocol behavior intact, but route through explicit services.
path = 'src/server/websocket/websocket-gateway.ts'
text = (ROOT / path).read_text(encoding='utf-8')
text = text.replace('  type DmmInfo,\n', '')
text = text.replace('  type ScopeInfo,\n', '')
text = text.replace('  type DeepCaptureReadyMessage,\n', '')
text = text.replace('import { InstrumentRegistry } from "../instruments/instrument-registry.js";\nimport { ScopeController } from "../scope/scope-controller.js";\nimport { ScopeStateStore } from "../scope/scope-state-store.js";\n', '''import type { DmmApplicationService } from "../dmm/dmm-service.js";\nimport {\n  DmmConnectionKind,\n  ScopeConnectionKind,\n  type DmmConnection,\n  type ScopeConnection,\n} from "../instruments/instrument-connection.js";\nimport { InstrumentRegistry } from "../instruments/instrument-registry.js";\nimport type { ScopeApplicationService } from "../scope/scope-service.js";\n''')
text = re.sub(
    r'export enum ServerScopeConnectionKind \{.*?export interface WebSocketGatewayOptions \{\n  instruments: InstrumentRegistry;\n  initialDmmConnection: ServerDmmConnection;\n  waveformHandlers: WaveformRequestHandlers;\n  dmmHandlers: DmmRequestHandlers;\n\}',
    '''export interface WebSocketGatewayOptions {\n  instruments: InstrumentRegistry;\n  scopeService: ScopeApplicationService;\n  dmmService: DmmApplicationService;\n}''',
    text,
    count=1,
    flags=re.S,
)
if 'ServerScopeConnectionKind' in text[:text.index('interface ClientState')]:
    raise RuntimeError('gateway connection/handler declarations were not replaced')

# Replace gateway fields + constructor + runtime publication setters up to close().
pattern = r'''export class WebSocketGateway \{\n  private readonly webSocketServer: WebSocketServer;.*?  public async close\(\): Promise<void> \{'''
replacement = r'''export class WebSocketGateway {
  private readonly webSocketServer: WebSocketServer;
  private readonly clients = new Map<WebSocket, ClientState>();
  private nextClientId = 1;
  private readonly instruments: InstrumentRegistry;
  private readonly scopeService: ScopeApplicationService;
  private readonly dmmService: DmmApplicationService;
  private scopeConnection: ScopeConnection;
  private scopeConnectionRevision = 0;
  private dmmConnection: DmmConnection;
  private dmmConnectionRevision = 0;
  private readonly unsubscribeServices: Array<() => void>;

  public constructor(
    server: HttpServer,
    options: WebSocketGatewayOptions,
  ) {
    this.instruments = options.instruments;
    this.scopeService = options.scopeService;
    this.dmmService = options.dmmService;
    this.scopeConnection = this.scopeService.getConnection();
    this.dmmConnection = this.dmmService.getConnection();
    this.unsubscribeServices = [
      this.scopeService.subscribeConnection((connection) => {
        this.scopeConnection = connection;
        this.scopeConnectionRevision += 1;
        this.broadcastJsonToInstrument(
          SupportedInstrument.Dho804,
          this.scopeLifecycleMessage(connection),
        );
      }),
      this.scopeService.subscribeState((state) => {
        if (this.scopeConnection.kind === ScopeConnectionKind.Connected) {
          this.scopeConnection = { ...this.scopeConnection, state };
        }
        this.broadcastJsonToInstrument(SupportedInstrument.Dho804, {
          type: MessageType.ScopeState,
          state,
        });
      }),
      this.scopeService.subscribeWaveform((frame) => this.broadcastWaveform(frame)),
      this.dmmService.subscribeConnection((connection) => {
        this.dmmConnection = connection;
        this.dmmConnectionRevision += 1;
        this.broadcastJsonToInstrument(
          SupportedInstrument.Dm858e,
          this.dmmLifecycleMessage(connection),
        );
      }),
      this.dmmService.subscribeState((state) => {
        if (this.dmmConnection.kind === DmmConnectionKind.Connected) {
          this.dmmConnection = { ...this.dmmConnection, state };
        }
        this.broadcastJsonToInstrument(SupportedInstrument.Dm858e, {
          type: MessageType.DmmState,
          state,
        });
      }),
      this.dmmService.subscribeSnapshot((snapshot) => {
        this.broadcastJsonToInstrument(SupportedInstrument.Dm858e, {
          type: MessageType.DmmSnapshot,
          snapshot,
        });
      }),
    ];

    this.webSocketServer = new WebSocketServer({
      server,
      path: "/ws",
      perMessageDeflate: false,
    });
    this.webSocketServer.on("connection", (socket) => {
      this.acceptClient(socket);
    });
  }

  private broadcastWaveform(frame: Uint8Array): void {
    const header = readWaveformHeader(frame);

    if (header.kind !== WaveformKind.Live || header.captureId !== 0) {
      throw new Error("broadcastWaveform only accepts live waveform frames");
    }

    for (const client of this.clients.values()) {
      if (client.protocolReady && client.subscriptions.has(SupportedInstrument.Dho804)) {
        this.queueLiveFrame(client, header.channel, frame);
      }
    }
  }

  public async close(): Promise<void> {'''
text, count = re.subn(pattern, replacement, text, count=1, flags=re.S)
if count != 1:
    raise RuntimeError('gateway class pre-close block replacement failed')

# Remove obsolete scope state-store unsubscribe lines and method.
text = text.replace('    this.unsubscribeScopeStateStore?.();\n    this.unsubscribeScopeStateStore = undefined;\n\n', '    for (const unsubscribe of this.unsubscribeServices) {\n      unsubscribe();\n    }\n\n', 1)
text = re.sub(
    r'''\n  private attachScopeStateSubscription\(connection: ServerScopeConnection\): void \{.*?\n  \}\n\n  private acceptClient''',
    '\n  private acceptClient',
    text,
    count=1,
    flags=re.S,
)

# Dispatch calls: controller/handler access -> service calls.
text = text.replace('const { controller, revision } = this.connectedScopeController();', 'const revision = this.connectedScopeRevision();')
text = text.replace('const { controller } = this.connectedScopeController();', 'this.connectedScopeRevision();')
text = text.replace('await controller.setControl(message.control);', 'await this.scopeService.setControl(message.control);')
text = text.replace('await controller.updateInteraction(message.control);', 'await this.scopeService.updateInteraction(message.control);')
text = text.replace('await controller.commitInteraction(message.control);', 'await this.scopeService.commitInteraction(message.control);')
text = text.replace('await controller.performAcquisitionAction(message.action);', 'await this.scopeService.performAcquisitionAction(message.action);')
text = text.replace('const values = await controller.readMeasurements(message.measurements);', 'const values = await this.scopeService.readMeasurements(message.measurements);')
text = text.replace('await controller.setMeasurements(message.measurements);', 'await this.scopeService.setMeasurements(message.measurements);')
text = text.replace('response = await controller.executeRawScpi(message.command);', 'response = await this.scopeService.executeRawScpi(message.command);')
text = text.replace('response = await this.dmmHandlers.executeRawScpi(message.command);', 'response = await this.dmmService.executeRawScpi(message.command);')
text = text.replace('await this.dmmHandlers.setControl(message.control);', 'await this.dmmService.setControl(message.control);')
text = text.replace('await this.waveformHandlers.pauseLiveWaveform?.();', 'await this.scopeService.pauseLiveWaveform();')
text = text.replace('this.waveformHandlers.resumeLiveWaveform?.();', 'this.scopeService.resumeLiveWaveform();')

# Deep capture now returns a domain result; gateway adds wire request/type fields.
text = re.sub(
    r'''const result = await this\.waveformHandlers\.requestDeepCapture\(message\.requestId\);\n          if \(\n            result\.type !== MessageType\.DeepCaptureReady \|\|\n            result\.requestId !== message\.requestId\n          \) \{\n            throw new Error\("Deep capture handler returned a mismatched result"\);\n          \}\n          this\.sendJson\(client, result\);''',
    '''const revision = this.connectedScopeRevision();\n          const result = await this.scopeService.captureDeep();\n          this.requireScopeConnectionRevision(revision);\n          this.sendJson(client, {\n            type: MessageType.DeepCaptureReady,\n            requestId: message.requestId,\n            captureId: result.captureId,\n            channels: result.channels,\n          });''',
    text,
    count=1,
)
text = text.replace(
    'const frame = await this.waveformHandlers.requestViewport(message);',
    '''const frame = await this.scopeService.requestViewport({\n      captureId: message.captureId,\n      channel: message.channel,\n      startSample: message.startSample,\n      endSample: message.endSample,\n      pixelWidth: message.pixelWidth,\n    });''',
)

# Replace controller helper and lifecycle connection types.
text = re.sub(
    r'''  private connectedScopeController\(\): \{ controller: ScopeController; revision: number \} \{.*?\n  \}\n\n  private requireScopeConnectionRevision''',
    '''  private connectedScopeRevision(): number {\n    if (this.scopeConnection.kind !== ScopeConnectionKind.Connected) {\n      throw new Error(`Scope disconnected: ${this.scopeConnection.reason}`);\n    }\n    return this.scopeConnectionRevision;\n  }\n\n  private requireScopeConnectionRevision''',
    text,
    count=1,
    flags=re.S,
)
text = text.replace('ServerScopeConnectionKind.Disconnected', 'ScopeConnectionKind.Disconnected')
text = text.replace('ServerDmmConnectionKind.Disconnected', 'DmmConnectionKind.Disconnected')
text = text.replace('ServerScopeConnection', 'ScopeConnection')
text = text.replace('ServerDmmConnection', 'DmmConnection')
text = text.replace('state: connection.stateStore.getState(),', 'state: connection.state,')
text = text.replace('this.waveformHandlers', 'this.scopeService')
text = text.replace('this.dmmHandlers', 'this.dmmService')

# No runtime/gateway wiring surface may remain.
for forbidden in [
    'ScopeController', 'ScopeStateStore', 'ServerScopeConnection', 'ServerDmmConnection',
    'WaveformRequestHandlers', 'DmmRequestHandlers', 'setScopeConnection(', 'setDmmConnection(',
    'publishDmmState(', 'broadcastDmmSnapshot(',
]:
    if forbidden in text:
        raise RuntimeError(f'gateway still contains obsolete boundary token: {forbidden}')
(ROOT / path).write_text(text, encoding='utf-8')

# Mechanical test import hard-cuts for connection types. Further behavioral test updates are appended below.
for test_path in [
    'src/server/scope-runtime.test.ts',
    'src/server/dmm/dmm-runtime.test.ts',
    'src/server/websocket/websocket-gateway.test.ts',
    'src/server/websocket/dmm-snapshot-replay.test.ts',
    'src/web/instrument-lifecycle.integration.test.ts',
]:
    p = ROOT / test_path
    if not p.exists():
        continue
    t = p.read_text(encoding='utf-8')
    t = t.replace('ServerScopeConnectionKind', 'ScopeConnectionKind')
    t = t.replace('ServerDmmConnectionKind', 'DmmConnectionKind')
    t = t.replace('ServerScopeConnection', 'ScopeConnection')
    t = t.replace('ServerDmmConnection', 'DmmConnection')
    t = t.replace('from "./websocket/websocket-gateway.js";', 'from "./instruments/instrument-connection.js";') if test_path == 'src/server/scope-runtime.test.ts' else t
    t = t.replace('from "../websocket/websocket-gateway.js";', 'from "../instruments/instrument-connection.js";') if test_path == 'src/server/dmm/dmm-runtime.test.ts' else t
    p.write_text(t, encoding='utf-8')

# Registry subscriber callback is now registration-level, not runtime-level.
p = ROOT / 'src/server/instruments/instrument-registry-subscriber.test.ts'
if p.exists():
    t = p.read_text(encoding='utf-8')
    t = t.replace('runtime: { start, stop, subscriberAdded },', 'runtime: { start, stop },\n        subscriberAdded,')
    p.write_text(t, encoding='utf-8')

# Active architecture docs: describe implemented Stream A only; retain subscription-owned runtime lifetime for later Stream D.
server_arch = (ROOT / 'docs/server-architecture.md').read_text(encoding='utf-8')
server_arch = server_arch.replace('''WebSocketGateway\n      |\n      v\nInstrumentRegistry\n   /            \\\n  v              v\nScopeRuntime    DmmRuntime''', '''WebSocketGateway\n   /            \\\n  v              v\nScopeService    DmmService\n  |              |\n  v              v\nScopeRuntime    DmmRuntime\n   \\            /\n   InstrumentRegistry lifecycle''')
server_arch = server_arch.replace('''WebSocketGateway\n   |\nScopeController\n   |\nDho804Driver''', '''WebSocketGateway\n   |\nScopeService\n   |\nScopeController\n   |\nScopeRuntime session\n   |\nDho804Driver''')
server_arch = server_arch.replace('''WebSocketGateway\n   |\nDmmRuntime\n   |\nDm858eDriver''', '''WebSocketGateway\n   |\nDmmService\n   |\nDmmRuntime session\n   |\nDm858eDriver''')
server_arch = server_arch.replace('''`ScopeRuntime` composes the active DHO804 session and is started/stopped only by `InstrumentRegistry` subscription ownership.''', '''`ScopeService` is the application boundary for scope controls, acquisition actions, measurements, raw SCPI and waveform/deep-capture operations. It owns per-session `ScopeController` instances and exposes data-only connection/state/waveform publications.\n\n`ScopeRuntime` owns only active DHO804 physical-session composition and reconnection. It does not import WebSocket gateway or wire-result types. It remains started/stopped by `InstrumentRegistry` subscription ownership until the later runtime-lifetime stream.''')
server_arch = server_arch.replace('''`DmmRuntime` owns:\n\n- fresh-session connect/identify/start/stop/reconnect lifecycle\n- one logical mutation queue shared by browser controls and raw SCPI\n- authoritative state readback after mutations\n- stale function-dependent control rejection''', '''`DmmService` owns:\n\n- one logical mutation queue shared by browser controls and raw SCPI\n- authoritative state readback after mutations\n- stale function-dependent control rejection\n- current display snapshot deduplication, invalidation and replay\n\n`DmmRuntime` owns only fresh-session connect/identify/start/stop/reconnect composition plus DMM polling for its active physical session''')
server_arch = server_arch.replace('- `DmmRuntime` owns DMM logical mutation serialization and state reconciliation.', '- `DmmService` owns DMM logical mutation serialization and state reconciliation; `DmmRuntime` owns physical session composition/recovery.')
(ROOT / 'docs/server-architecture.md').write_text(server_arch, encoding='utf-8')

arch = (ROOT / 'docs/architecture.md').read_text(encoding='utf-8')
arch = arch.replace('''WebSocketGateway\n   |\n   v\nScopeController''', '''WebSocketGateway\n   |\n   v\nScopeService\n   |\n   v\nScopeController''')
arch = arch.replace('''WebSocketGateway\n   |\n   v\nDmm runtime/controller boundary''', '''WebSocketGateway\n   |\n   v\nDmmService\n   |\n   v\nDmmRuntime''')
(ROOT / 'docs/architecture.md').write_text(arch, encoding='utf-8')

write('docs/changes/2026-09-07-stream-a-server-application-service-boundary.md', r'''# Stream A — server application-service boundary

Implemented 2026-09-07.

## Result

The server now has explicit `ScopeService` and `DmmService` application boundaries between WebSocket request routing and physical instrument runtimes.

- `ScopeService` owns scope application semantics and per-session `ScopeController` access, including controls, acquisition actions, measurements, raw SCPI, and deep/live waveform operations.
- `DmmService` owns DMM mutation serialization, stale function-bound request validation, authoritative post-mutation readback, and current display-snapshot invalidation/deduplication/replay.
- `ScopeRuntime` and `DmmRuntime` now mean physical connection/session composition and recovery. They do not import `websocket-gateway.ts` or wire-result types.
- Scope/DMM connection status is represented by data-only `ScopeConnection` / `DmmConnection` values in `src/server/instruments/instrument-connection.ts`.
- `WebSocketGateway` depends on the two explicit application-service surfaces and projects their domain results to the existing wire protocol.
- `server.ts` is a composition root for services, runtimes, registry, HTTP and WebSocket delivery; runtime publication no longer requires a forward `let gateway!` reference.
- Browser subscription still owns runtime activation in this stream. Changing that lifetime belongs to Stream D.
- DHO804 sleep/wake orchestration remains in its existing HTTP/composition path. Moving it belongs to Stream B.

No compatibility shim, feature flag, generic instrument service, DI framework or event bus was added.
''')

# Acceptance-boundary sanity checks before TypeScript compilation.
for runtime_path in ['src/server/scope-runtime.ts', 'src/server/dmm/dmm-runtime.ts']:
    body = (ROOT / runtime_path).read_text(encoding='utf-8')
    if 'websocket-gateway' in body or 'websocket-protocol' in body:
        raise RuntimeError(f'{runtime_path} still imports WebSocket-layer types')

print('Stream A source transformation applied')
