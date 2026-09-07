import {
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
