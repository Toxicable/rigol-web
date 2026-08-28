import {
  DmmControlKind,
  type DmmControlChange,
  type DmmInfo,
  type DmmPrimaryReading,
} from "../../shared/dmm-types.js";
import { ScpiScheduler } from "../scpi/scpi-scheduler.js";
import { ScpiTransport } from "../scpi/scpi-transport.js";
import {
  ServerDmmConnectionKind,
  type ServerDmmConnection,
} from "../websocket/websocket-gateway.js";
import { Dm858eDriver } from "./dm858e-driver.js";
import { DmmPoller } from "./dmm-poller.js";
import { DmmStateStore } from "./dmm-state-store.js";

const DEFAULT_RECONNECT_DELAY_MS = 2_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 3_000;

interface FailureSignal {
  promise: Promise<Error>;
  fail(error: unknown): void;
}

interface DmmSession {
  info: DmmInfo;
  transport: ScpiTransport;
  scheduler: ScpiScheduler;
  driver: Dm858eDriver;
  stateStore: DmmStateStore;
  poller: DmmPoller;
  unsubscribeState: () => void;
  failure: FailureSignal;
}

export interface DmmRuntimeOptions {
  host: string;
  port: number;
  publishConnection: (connection: ServerDmmConnection) => void;
  publishState: (state: ReturnType<DmmStateStore["getState"]>) => void;
  publishReading: (reading: DmmPrimaryReading) => void;
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
  private readonly publishReading: DmmRuntimeOptions["publishReading"];
  private running = false;
  private loopPromise: Promise<void> | null = null;
  private session: DmmSession | null = null;
  private initializingTransport: ScpiTransport | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryResolve: (() => void) | null = null;
  private disconnectedReason = "DMM runtime inactive";
  private mutationTail: Promise<void> = Promise.resolve();

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
    this.publishReading = options.publishReading;
  }

  public start(): void {
    if (this.running) {
      return;
    }

    this.running = true;
    this.disconnectedReason = "DMM connection pending";
    this.publishConnection({
      kind: ServerDmmConnectionKind.Disconnected,
      reason: this.disconnectedReason,
    });
    this.loopPromise = this.runLoop();
  }

  public async stop(): Promise<void> {
    if (!this.running && this.loopPromise === null) {
      return;
    }

    this.running = false;
    this.disconnectedReason = "DMM runtime inactive";
    this.publishConnection({
      kind: ServerDmmConnectionKind.Disconnected,
      reason: this.disconnectedReason,
    });
    this.wakeRetryDelay();
    this.initializingTransport?.disconnect();
    this.session?.failure.fail(new Error("DMM runtime stopped"));

    const loop = this.loopPromise;
    if (loop !== null) {
      await loop;
    }
    this.loopPromise = null;
  }

  public async setControl(control: DmmControlChange): Promise<void> {
    await this.serializeMutation(async () => {
      const session = this.requireSession();
      const before = session.stateStore.getState();

      try {
        switch (control.kind) {
          case DmmControlKind.Function:
            await session.driver.setFunction(control.value);
            break;
          case DmmControlKind.Range:
            await session.driver.setRange(before.function, control.value);
            break;
          case DmmControlKind.AcquisitionRate:
            await session.driver.setAcquisitionRate(before.function, before.range, control.value);
            break;
        }

        this.requireSameSession(session);
        const state = await session.driver.readDmmState(before.acquisitionRate);
        this.requireSameSession(session);
        session.stateStore.replaceState(state);
      } catch (error) {
        this.failSessionIfTransportLost(session, error);
        throw error;
      }
    });
  }

  public async executeRawScpi(command: string): Promise<string> {
    return this.serializeMutation(async () => {
      const session = this.requireSession();
      try {
        const response = await session.driver.executeRawScpi(command);
        this.requireSameSession(session);
        const previousRate = session.stateStore.getState().acquisitionRate;
        const state = await session.driver.readDmmState(previousRate);
        this.requireSameSession(session);
        session.stateStore.replaceState(state);
        return response;
      } catch (error) {
        this.failSessionIfTransportLost(session, error);
        throw error;
      }
    });
  }

  private async serializeMutation<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationTail;
    let release!: () => void;
    this.mutationTail = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async runLoop(): Promise<void> {
    while (this.running) {
      let session: DmmSession | null = null;
      try {
        session = await this.createSession();
        if (!this.running) {
          await this.disposeSession(session, new Error("DMM runtime stopped"));
          break;
        }

        this.session = session;
        this.publishConnection({
          kind: ServerDmmConnectionKind.Connected,
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

  private async createSession(): Promise<DmmSession> {
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
        publishReading: this.publishReading,
        reportError: (error) => failure.fail(error),
      });
      const unsubscribeState = stateStore.subscribe(this.publishState);

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

  private async disposeSession(session: DmmSession, reason: Error): Promise<void> {
    session.unsubscribeState();
    session.poller.stop();
    session.scheduler.stop(reason);
    session.transport.disconnect();
    await session.poller.waitForIdle();
  }

  private requireSession(): DmmSession {
    const session = this.session;
    if (session === null) {
      throw new Error(`DMM disconnected: ${this.disconnectedReason}`);
    }
    return session;
  }

  private requireSameSession(session: DmmSession): void {
    if (this.session !== session) {
      throw new Error("DMM session changed while request was in flight");
    }
  }

  private failSessionIfTransportLost(session: DmmSession, error: unknown): void {
    if (!session.transport.isUsable()) {
      session.failure.fail(error);
    }
  }

  private publishDisconnected(error: unknown): void {
    this.disconnectedReason = errorMessage(error);
    this.publishConnection({
      kind: ServerDmmConnectionKind.Disconnected,
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
