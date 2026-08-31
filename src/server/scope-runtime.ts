import type { ScopeInfo } from "../shared/scope-types.js";
import {
  MessageType,
  type DeepCaptureReadyMessage,
  type WaveformViewportRequestMessage,
} from "../shared/websocket-protocol.js";
import { ScpiPriority, ScpiScheduler } from "./scpi/scpi-scheduler.js";
import { ScpiTransport } from "./scpi/scpi-transport.js";
import { Dho804Driver } from "./scope/dho804-driver.js";
import { ScopeController } from "./scope/scope-controller.js";
import { ScopePoller } from "./scope/scope-poller.js";
import { ScopeStateStore } from "./scope/scope-state-store.js";
import { DeepCaptureService } from "./waveform/deep-capture-service.js";
import { LiveWaveformService } from "./waveform/live-waveform-service.js";
import {
  ServerScopeConnectionKind,
  type ServerScopeConnection,
} from "./websocket/websocket-gateway.js";

const DEFAULT_RECONNECT_DELAY_MS = 2_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 3_000;

interface FailureSignal {
  promise: Promise<Error>;
  fail(error: unknown): void;
}

interface ScopeSession {
  info: ScopeInfo;
  transport: ScpiTransport;
  scheduler: ScpiScheduler;
  stateStore: ScopeStateStore;
  controller: ScopeController;
  poller: ScopePoller;
  live: LiveWaveformService;
  deep: DeepCaptureService;
  unsubscribeState: () => void;
  failure: FailureSignal;
}

export interface ScopeRuntimeOptions {
  host: string;
  port: number;
  publishConnection: (connection: ServerScopeConnection) => void;
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
  private readonly publishWaveform: ScopeRuntimeOptions["publishWaveform"];
  private running = false;
  private loopPromise: Promise<void> | null = null;
  private session: ScopeSession | null = null;
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
    this.publishWaveform = options.publishWaveform;
  }

  public start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.disconnectedReason = "Scope connection pending";
    this.publishConnection({
      kind: ServerScopeConnectionKind.Disconnected,
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
      kind: ServerScopeConnectionKind.Disconnected,
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

  public async requestDeepCapture(requestId: number): Promise<DeepCaptureReadyMessage> {
    const session = this.requireSession();
    const capture = await session.deep.capture();
    this.requireSameSession(session);
    return {
      type: MessageType.DeepCaptureReady,
      requestId,
      captureId: capture.captureId,
      channels: capture.channels,
    };
  }

  public pauseLiveWaveform(): void {
    this.session?.live.pause();
  }

  public resumeLiveWaveform(): void {
    this.session?.live.resume();
  }

  public async requestViewport(request: WaveformViewportRequestMessage): Promise<Uint8Array> {
    const session = this.requireSession();
    const frame = session.deep.getViewport({
      captureId: request.captureId,
      channel: request.channel,
      startSample: request.startSample,
      endSample: request.endSample,
      pixelWidth: request.pixelWidth,
    });
    this.requireSameSession(session);
    return frame;
  }

  private async runLoop(): Promise<void> {
    while (this.running) {
      let session: ScopeSession | null = null;
      try {
        session = await this.createSession();
        if (!this.running) {
          await this.disposeSession(session, new Error("Scope runtime stopped"));
          break;
        }

        this.session = session;
        this.publishConnection({
          kind: ServerScopeConnectionKind.Connected,
          info: session.info,
          stateStore: session.stateStore,
          controller: session.controller,
        });
        session.poller.start();
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

  private async createSession(): Promise<ScopeSession> {
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
      const controller = new ScopeController(driver, stateStore);
      const failure = createFailureSignal();
      const poller = new ScopePoller(driver, controller, (error) => failure.fail(error));
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
      const unsubscribeState = stateStore.subscribe(() => {
        live.requestFresh();
      });

      return {
        info,
        transport,
        scheduler,
        stateStore,
        controller,
        poller,
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

  private async disposeSession(session: ScopeSession, reason: Error): Promise<void> {
    session.unsubscribeState();
    session.poller.stop();
    session.live.stop();
    session.scheduler.stop(reason);
    session.transport.disconnect();
    await session.live.waitForIdle();
  }

  private requireSession(): ScopeSession {
    const session = this.session;
    if (session === null) {
      throw new Error(`Scope disconnected: ${this.disconnectedReason}`);
    }
    return session;
  }

  private requireSameSession(session: ScopeSession): void {
    if (this.session !== session) {
      throw new Error("Scope session changed while request was in flight");
    }
  }

  private publishDisconnected(error: unknown): void {
    this.disconnectedReason = errorMessage(error);
    this.publishConnection({
      kind: ServerScopeConnectionKind.Disconnected,
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
