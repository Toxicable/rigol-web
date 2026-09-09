import { Buffer } from "node:buffer";
import { connect, type Socket } from "node:net";

import {
  PPK2_SAMPLE_INTERVAL_US,
  Ppk2ConnectionKind,
  type Ppk2Connection,
  type Ppk2Info,
} from "../../shared/ppk2-types.js";
import {
  Ppk2BridgeFrameParser,
  Ppk2BridgeFrameType,
  type Ppk2BridgeFrame,
} from "./ppk2-bridge-protocol.js";
import {
  PPK2_AMPERE_MODE,
  Ppk2Command,
  Ppk2CurrentConverter,
  encodePpk2RegulatorCommand,
  encodePpk2UserGainCommand,
  parsePpk2Metadata,
  requireSafePpk2UserGains,
  type Ppk2CalibrationMetadata,
} from "./ppk2-protocol.js";
import {
  Ppk2StreamDecoder,
  type Ppk2DecodedBatch,
} from "./ppk2-stream-decoder.js";

const DEFAULT_RECONNECT_DELAY_MS = 2_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 3_000;
const DEFAULT_METADATA_TIMEOUT_MS = 2_000;
const STOP_DRAIN_MS = 40;

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
}

interface FailureSignal {
  promise: Promise<Error>;
  fail(error: unknown): void;
}

export interface Ppk2RuntimeSession {
  readonly info: Ppk2Info;
  readonly metadata: Ppk2CalibrationMetadata;
  readonly sourceSessionId: number;
  startMeasurement(): Promise<void>;
  stopMeasurement(): Promise<void>;
}

interface OwnedPpk2RuntimeSession extends Ppk2RuntimeSession {
  socket: Socket;
  failure: FailureSignal;
  parser: Ppk2BridgeFrameParser;
  decoder: Ppk2StreamDecoder;
  nextStreamOffset: number;
  measuring: boolean;
  phase: "awaiting-usb" | "draining" | "metadata" | "ready";
  metadataText: string;
  metadataDeferred: Deferred<string> | null;
  usbDeferred: Deferred<void>;
}

export interface Ppk2RuntimeOptions {
  host: string;
  port: number;
  publishConnection: (connection: Ppk2Connection) => void;
  publishBatch: (batch: Ppk2DecodedBatch) => void;
  reconnectDelayMs?: number;
  connectTimeoutMs?: number;
  metadataTimeoutMs?: number;
}

export class Ppk2Runtime {
  private readonly host: string;
  private readonly port: number;
  private readonly reconnectDelayMs: number;
  private readonly connectTimeoutMs: number;
  private readonly metadataTimeoutMs: number;
  private readonly publishConnection: Ppk2RuntimeOptions["publishConnection"];
  private readonly publishBatch: Ppk2RuntimeOptions["publishBatch"];
  private running = false;
  private loopPromise: Promise<void> | null = null;
  private session: OwnedPpk2RuntimeSession | null = null;
  private initializingSocket: Socket | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryResolve: (() => void) | null = null;
  private disconnectedReason = "PPK2 runtime inactive";

  public constructor(options: Ppk2RuntimeOptions) {
    if (options.host.trim().length === 0) {
      throw new Error("PPK2_BRIDGE_HOST must be a non-empty string");
    }
    if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65_535) {
      throw new Error("PPK2_BRIDGE_PORT must be an integer from 1 through 65535");
    }
    this.host = options.host;
    this.port = options.port;
    this.reconnectDelayMs = readDelay(options.reconnectDelayMs, DEFAULT_RECONNECT_DELAY_MS, "reconnectDelayMs");
    this.connectTimeoutMs = readPositiveDelay(options.connectTimeoutMs, DEFAULT_CONNECT_TIMEOUT_MS, "connectTimeoutMs");
    this.metadataTimeoutMs = readPositiveDelay(options.metadataTimeoutMs, DEFAULT_METADATA_TIMEOUT_MS, "metadataTimeoutMs");
    this.publishConnection = options.publishConnection;
    this.publishBatch = options.publishBatch;
  }

  public start(): void {
    if (this.running) return;
    this.running = true;
    this.disconnectedReason = "PPK2 bridge connection pending";
    this.publishConnection({ kind: Ppk2ConnectionKind.Disconnected, reason: this.disconnectedReason });
    this.loopPromise = this.runLoop();
  }

  public async stop(): Promise<void> {
    if (!this.running && this.loopPromise === null) return;
    this.running = false;
    this.wakeRetryDelay();
    this.initializingSocket?.destroy();
    const session = this.session;
    this.session = null;
    if (session !== null) {
      session.failure.fail(new Error("PPK2 runtime stopped"));
      session.socket.destroy();
    }
    this.disconnectedReason = "PPK2 runtime inactive";
    this.publishConnection({ kind: Ppk2ConnectionKind.Disconnected, reason: this.disconnectedReason });
    if (this.loopPromise !== null) {
      await this.loopPromise;
      this.loopPromise = null;
    }
  }

  public requireSession(): Ppk2RuntimeSession {
    if (this.session === null) {
      throw new Error(`PPK2 disconnected: ${this.disconnectedReason}`);
    }
    return this.session;
  }

  private async runLoop(): Promise<void> {
    while (this.running) {
      let session: OwnedPpk2RuntimeSession | null = null;
      try {
        session = await this.createSession();
        if (!this.running) {
          session.socket.destroy();
          break;
        }
        this.session = session;
        this.publishConnection({ kind: Ppk2ConnectionKind.Connected, info: session.info });
        const failure = await session.failure.promise;
        if (this.session === session) this.session = null;
        if (this.running) this.publishDisconnected(failure);
        session.socket.destroy();
      } catch (error) {
        if (session !== null) session.socket.destroy();
        if (this.running) this.publishDisconnected(error);
      }
      if (this.running) await this.waitRetryDelay();
    }
  }

  private async createSession(): Promise<OwnedPpk2RuntimeSession> {
    const socket = connect({ host: this.host, port: this.port });
    this.initializingSocket = socket;
    try {
      await waitForSocketConnect(socket, this.connectTimeoutMs);
      socket.setNoDelay(true);
      const parser = new Ppk2BridgeFrameParser();
      const failure = createFailureSignal();
      const usbDeferred = createDeferred<void>();
      const placeholderMetadata: Ppk2CalibrationMetadata = {
        vddMv: 800,
        mode: PPK2_AMPERE_MODE,
        hardwareRevision: null,
        calibrated: null,
        r: [1, 1, 1, 1, 1],
        gs: [1, 1, 1, 1, 1],
        gi: [1, 1, 1, 1, 1],
        o: [0, 0, 0, 0, 0],
        s: [0, 0, 0, 0, 0],
        i: [0, 0, 0, 0, 0],
        ug: [1, 1, 1, 1, 1],
      };
      const session = {} as OwnedPpk2RuntimeSession;
      Object.assign(session, {
        socket,
        failure,
        parser,
        nextStreamOffset: 0,
        measuring: false,
        phase: "awaiting-usb" as const,
        metadataText: "",
        metadataDeferred: null,
        usbDeferred,
        sourceSessionId: 0,
        metadata: placeholderMetadata,
        info: {
          sourceSessionId: 0,
          hardwareRevision: null,
          calibrated: null,
          vddMv: 800,
          sampleIntervalUs: PPK2_SAMPLE_INTERVAL_US,
        } satisfies Ppk2Info,
      });

      socket.on("data", (data) => {
        try {
          for (const frame of parser.push(data)) {
            this.acceptFrame(session, frame);
          }
        } catch (error) {
          failure.fail(error);
        }
      });
      socket.once("error", (error) => failure.fail(error));
      socket.once("close", () => failure.fail(new Error("PPK2 bridge TCP connection closed")));

      await withTimeout(usbDeferred.promise, this.metadataTimeoutMs, "PPK2 USB enumeration status");
      session.phase = "draining";
      writeCommand(socket, Buffer.from([Ppk2Command.AverageStop]));
      await delay(STOP_DRAIN_MS);

      const metadataDeferred = createDeferred<string>();
      session.metadataDeferred = metadataDeferred;
      session.metadataText = "";
      session.phase = "metadata";
      writeCommand(socket, Buffer.from([Ppk2Command.GetMetadata]));
      const metadataText = await withTimeout(
        metadataDeferred.promise,
        this.metadataTimeoutMs,
        "PPK2 metadata",
      );
      const metadata = parsePpk2Metadata(metadataText);
      const userGains = requireSafePpk2UserGains(metadata);
      for (let range = 0; range < userGains.length; range += 1) {
        const safeGain = userGains[range];
        const originalGain = metadata.ug[range];
        if (safeGain !== undefined && originalGain !== undefined && safeGain !== originalGain) {
          writeCommand(socket, encodePpk2UserGainCommand(range, safeGain));
        }
      }
      writeCommand(socket, encodePpk2RegulatorCommand(metadata.vddMv));
      writeCommand(socket, Buffer.from([Ppk2Command.SetPowerMode, PPK2_AMPERE_MODE]));
      writeCommand(socket, Buffer.from([Ppk2Command.DeviceRunningSet, 1]));

      const converter = new Ppk2CurrentConverter(metadata, userGains);
      session.metadata = metadata;
      session.info = {
        sourceSessionId: session.sourceSessionId,
        hardwareRevision: metadata.hardwareRevision,
        calibrated: metadata.calibrated,
        vddMv: metadata.vddMv,
        sampleIntervalUs: PPK2_SAMPLE_INTERVAL_US,
      };
      session.decoder = new Ppk2StreamDecoder(converter);
      session.phase = "ready";
      session.metadataDeferred = null;
      session.startMeasurement = async () => {
        if (this.session !== session) {
          throw new Error("PPK2 session changed before measurement start");
        }
        if (session.measuring) {
          throw new Error("PPK2 measurement is already running");
        }
        session.decoder.start(session.sourceSessionId, session.nextStreamOffset);
        session.measuring = true;
        try {
          writeCommand(session.socket, Buffer.from([Ppk2Command.AverageStart]));
        } catch (error) {
          session.measuring = false;
          session.decoder.stop();
          throw error;
        }
      };
      session.stopMeasurement = async () => {
        if (this.session !== session) {
          throw new Error("PPK2 session changed before measurement stop");
        }
        if (!session.measuring) return;
        writeCommand(session.socket, Buffer.from([Ppk2Command.AverageStop]));
        session.measuring = false;
        session.decoder.stop();
        await delay(STOP_DRAIN_MS);
      };
      return session;
    } catch (error) {
      socket.destroy();
      throw error;
    } finally {
      if (this.initializingSocket === socket) this.initializingSocket = null;
    }
  }

  private acceptFrame(session: OwnedPpk2RuntimeSession, frame: Ppk2BridgeFrame): void {
    switch (frame.type) {
      case Ppk2BridgeFrameType.UsbConnected:
        if (session.phase === "awaiting-usb") {
          session.sourceSessionId = frame.sourceSessionId;
          session.nextStreamOffset = frame.streamOffset;
          session.usbDeferred.resolve();
          return;
        }
        if (frame.sourceSessionId !== session.sourceSessionId) {
          session.failure.fail(new Error("PPK2 USB source session changed"));
        }
        return;
      case Ppk2BridgeFrameType.UsbDisconnected:
        if (session.sourceSessionId === 0 || frame.sourceSessionId === session.sourceSessionId) {
          session.failure.fail(new Error("PPK2 USB device disconnected from bridge"));
        }
        return;
      case Ppk2BridgeFrameType.Data:
        break;
    }

    if (session.sourceSessionId === 0 || frame.sourceSessionId !== session.sourceSessionId) {
      session.failure.fail(new Error("PPK2 data frame belongs to an unexpected USB source session"));
      return;
    }
    if (frame.streamOffset < session.nextStreamOffset) {
      session.failure.fail(new Error("PPK2 bridge stream offset moved backwards"));
      return;
    }

    if (session.phase === "metadata" && frame.streamOffset !== session.nextStreamOffset) {
      session.failure.fail(new Error("PPK2 metadata bytes were lost before calibration could be established"));
      return;
    }

    if (session.measuring) {
      try {
        const batch = session.decoder.push(
          frame.sourceSessionId,
          frame.streamOffset,
          frame.payload,
        );
        if (batch.samples.length > 0 || batch.lostSamples > 0) {
          this.publishBatch(batch);
        }
      } catch (error) {
        session.failure.fail(error);
        return;
      }
    } else if (session.phase === "metadata") {
      session.metadataText += frame.payload.toString("utf8");
      if (session.metadataText.includes("END")) {
        session.metadataDeferred?.resolve(session.metadataText);
      }
    }

    session.nextStreamOffset = frame.streamOffset + frame.payload.length;
  }

  private publishDisconnected(error: unknown): void {
    this.disconnectedReason = errorMessage(error);
    this.publishConnection({ kind: Ppk2ConnectionKind.Disconnected, reason: this.disconnectedReason });
  }

  private waitRetryDelay(): Promise<void> {
    if (this.reconnectDelayMs === 0) return Promise.resolve();
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

function writeCommand(socket: Socket, command: Buffer): void {
  if (!socket.writable || socket.destroyed) {
    throw new Error("PPK2 bridge TCP connection is not writable");
  }
  socket.write(command);
}

async function waitForSocketConnect(socket: Socket, timeoutMs: number): Promise<void> {
  await withTimeout(new Promise<void>((resolve, reject) => {
    const connected = (): void => {
      cleanup();
      resolve();
    };
    const failed = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const cleanup = (): void => {
      socket.off("connect", connected);
      socket.off("error", failed);
    };
    socket.once("connect", connected);
    socket.once("error", failed);
  }), timeoutMs, "PPK2 bridge TCP connection");
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createFailureSignal(): FailureSignal {
  const deferred = createDeferred<Error>();
  let failed = false;
  return {
    promise: deferred.promise,
    fail(error) {
      if (failed) return;
      failed = true;
      deferred.resolve(asError(error));
    },
  };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, name: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${name} timed out after ${timeoutMs} ms`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readDelay(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isFinite(result) || result < 0) {
    throw new Error(`${name} must be a non-negative finite number`);
  }
  return result;
}

function readPositiveDelay(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isFinite(result) || result <= 0) {
    throw new Error(`${name} must be a positive finite number`);
  }
  return result;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
