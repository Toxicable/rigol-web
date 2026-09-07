import type {
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
