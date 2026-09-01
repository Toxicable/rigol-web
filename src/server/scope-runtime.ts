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
import { ScopeStateStore } from "./scope/scope-state-store.js";
import { DeepCaptureService } from "./waveform/deep-capture-service.js";
import { LiveWaveformService } from "./waveform/live-waveform-service.js";
import {
  ServerScopeConnectionKind,
  type ServerScopeConnection,
} from "./websocket/websocket-gateway.js";

const DEFAULT_RECONNECT_DELAY_MS = 2_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 3_000;
const SCPI_PROBE_ROUNDS = 10;
const SCALE_QUERY_PROBE = ":TIMebase:MAIN:SCALe?";
const OFFSET_QUERY_PROBE = ":TIMebase:MAIN:OFFSet?";
const COMPOUND_QUERY_PROBE = `${SCALE_QUERY_PROBE};${OFFSET_QUERY_PROBE}`;
const WAVEFORM_SOURCE_PROBE = ":WAVeform:SOURce CHANnel1";
const WAVEFORM_OTHER_SOURCE_PROBE = ":WAVeform:SOURce CHANnel2";
const WAVEFORM_DATA_PROBE = ":WAVeform:DATA?";
const COMPOUND_WAVEFORM_PROBE = `${WAVEFORM_SOURCE_PROBE};${WAVEFORM_DATA_PROBE}`;
const WAVEFORM_PROBE_POINTS = 999;

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
  live: LiveWaveformService;
  deep: DeepCaptureService;
  unsubscribeState: () => void;
  failure: FailureSignal;
}

interface TimingSummary {
  count: number;
  medianMs: number;
  meanMs: number;
  minMs: number;
  maxMs: number;
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

function summarizeTimings(values: number[]): TimingSummary {
  if (values.length === 0) {
    throw new Error("SCPI timing summary requires at least one sample");
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const lower = sorted[middle - 1];
  const upper = sorted[middle];
  if (upper === undefined) {
    throw new Error("SCPI timing summary has no median sample");
  }
  const medianMs = sorted.length % 2 === 0
    ? ((lower ?? upper) + upper) / 2
    : upper;
  return {
    count: values.length,
    medianMs,
    meanMs: values.reduce((sum, value) => sum + value, 0) / values.length,
    minMs: sorted[0] ?? upper,
    maxMs: sorted[sorted.length - 1] ?? upper,
  };
}

async function timeOperation<T>(operation: () => Promise<T>): Promise<{ elapsedMs: number; value: T }> {
  const startedAt = performance.now();
  const value = await operation();
  return { elapsedMs: performance.now() - startedAt, value };
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
  private scpiPerformanceProbeComplete = false;

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
      await this.runScpiPerformanceProbeOnce(driver, transport);
      const initialState = await driver.readScopeState(ScpiPriority.Normal);
      const stateStore = new ScopeStateStore(initialState);
      const controller = new ScopeController(driver, stateStore);
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
      const unsubscribeState = stateStore.subscribe(() => {
        live.requestFresh();
      });

      return {
        info,
        transport,
        scheduler,
        stateStore,
        controller,
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

  private async runScpiPerformanceProbeOnce(
    driver: Dho804Driver,
    transport: ScpiTransport,
  ): Promise<void> {
    if (this.scpiPerformanceProbeComplete) {
      return;
    }
    this.scpiPerformanceProbeComplete = true;

    try {
      await this.runCompoundTextQueryProbe(driver);
      await this.runWaveformSourceQueryProbe(transport);
    } catch (error) {
      console.warn(`[SCPI] performance-probe:failed ${JSON.stringify({ error: errorMessage(error) })}`);
      throw error;
    }
  }

  private async runCompoundTextQueryProbe(driver: Dho804Driver): Promise<void> {
    const compoundMs: number[] = [];
    const separateMs: number[] = [];
    console.info(`[SCPI] compound-query-probe:start ${JSON.stringify({ rounds: SCPI_PROBE_ROUNDS })}`);

    const runCompound = async (): Promise<void> => {
      const measured = await timeOperation(() => driver.executeRawScpi(COMPOUND_QUERY_PROBE));
      const fields = measured.value.split(";");
      if (fields.length !== 2) {
        throw new Error(`Compound query response did not contain two fields: ${measured.value}`);
      }
      compoundMs.push(measured.elapsedMs);
    };

    const runSeparate = async (): Promise<void> => {
      const measured = await timeOperation(async () => {
        await driver.executeRawScpi(SCALE_QUERY_PROBE);
        await driver.executeRawScpi(OFFSET_QUERY_PROBE);
      });
      separateMs.push(measured.elapsedMs);
    };

    for (let round = 0; round < SCPI_PROBE_ROUNDS; round += 1) {
      if (round % 2 === 0) {
        await runSeparate();
        await runCompound();
      } else {
        await runCompound();
        await runSeparate();
      }
    }

    console.info(`[SCPI] compound-query-probe:summary ${JSON.stringify({
      rounds: SCPI_PROBE_ROUNDS,
      compound: summarizeTimings(compoundMs),
      separate: summarizeTimings(separateMs),
    })}`);
  }

  private async runWaveformSourceQueryProbe(transport: ScpiTransport): Promise<void> {
    await transport.command(":WAVeform:MODE NORM");
    await transport.command(":WAVeform:FORMat BYTE");
    await transport.command(`:WAVeform:POINts ${WAVEFORM_PROBE_POINTS}`);

    const compoundMs: number[] = [];
    const separateMs: number[] = [];
    console.info(`[SCPI] waveform-source-query-probe:start ${JSON.stringify({
      rounds: SCPI_PROBE_ROUNDS,
      points: WAVEFORM_PROBE_POINTS,
    })}`);

    const validatePayload = (payload: Uint8Array): void => {
      if (payload.byteLength !== WAVEFORM_PROBE_POINTS) {
        throw new Error(
          `Waveform source-query probe expected ${WAVEFORM_PROBE_POINTS} bytes, got ${payload.byteLength}`,
        );
      }
    };

    const runCompound = async (): Promise<void> => {
      await transport.command(WAVEFORM_OTHER_SOURCE_PROBE);
      const measured = await timeOperation(() => transport.queryBinary(COMPOUND_WAVEFORM_PROBE));
      validatePayload(measured.value);
      compoundMs.push(measured.elapsedMs);
    };

    const runSeparate = async (): Promise<void> => {
      await transport.command(WAVEFORM_OTHER_SOURCE_PROBE);
      const measured = await timeOperation(async () => {
        await transport.command(WAVEFORM_SOURCE_PROBE);
        return transport.queryBinary(WAVEFORM_DATA_PROBE);
      });
      validatePayload(measured.value);
      separateMs.push(measured.elapsedMs);
    };

    for (let round = 0; round < SCPI_PROBE_ROUNDS; round += 1) {
      if (round % 2 === 0) {
        await runSeparate();
        await runCompound();
      } else {
        await runCompound();
        await runSeparate();
      }
    }

    console.info(`[SCPI] waveform-source-query-probe:summary ${JSON.stringify({
      rounds: SCPI_PROBE_ROUNDS,
      points: WAVEFORM_PROBE_POINTS,
      compound: summarizeTimings(compoundMs),
      separate: summarizeTimings(separateMs),
    })}`);
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
