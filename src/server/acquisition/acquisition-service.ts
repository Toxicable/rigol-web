import {
  AcquisitionInitiatorKind,
  AcquisitionOperationState,
  type AcquisitionInitiator,
  type AcquisitionOperation,
  type AcquisitionProgress,
  type RunningAcquisitionOperation,
} from "../../shared/acquisition-types.js";

export const DEFAULT_MAX_RETAINED_TERMINAL_OPERATIONS = 64;
const MAX_LABEL_LENGTH = 120;

export type AcquisitionOperationListener = (operation: AcquisitionOperation) => void;

export interface AcquisitionProgressUpdate {
  receivedItems: number;
  sourceLostItems: number;
  lastSequence: number | null;
}

export interface AcquisitionApplicationService {
  start(label: string, initiator: AcquisitionInitiator): AcquisitionOperation;
  stop(id: number): AcquisitionOperation;
  fail(id: number, error: unknown): AcquisitionOperation;
  updateProgress(id: number, progress: AcquisitionProgressUpdate): AcquisitionOperation;
  get(id: number): AcquisitionOperation;
  list(): readonly AcquisitionOperation[];
  subscribe(listener: AcquisitionOperationListener): () => void;
  close(): void;
}

export interface AcquisitionServiceOptions {
  maxRetainedTerminalOperations?: number;
  now?: () => number;
}

/**
 * Server-owned lifecycle envelope for long-running acquisitions/recordings.
 *
 * It intentionally owns metadata/lifetime/progress only. Source-specific sample
 * representation and statistics stay with the concrete producer (PPK2 in
 * Stream H) and can use BoundedAcquisitionChunkStore without forcing DHO/DMM
 * into the same sample model.
 */
export class AcquisitionService implements AcquisitionApplicationService {
  private readonly operations = new Map<number, AcquisitionOperation>();
  private readonly listeners = new Set<AcquisitionOperationListener>();
  private readonly maxRetainedTerminalOperations: number;
  private readonly now: () => number;
  private nextId = 1;
  private closed = false;

  public constructor(options: AcquisitionServiceOptions = {}) {
    const maxRetainedTerminalOperations =
      options.maxRetainedTerminalOperations ?? DEFAULT_MAX_RETAINED_TERMINAL_OPERATIONS;
    requireNonNegativeSafeInteger(
      maxRetainedTerminalOperations,
      "maxRetainedTerminalOperations",
    );
    this.maxRetainedTerminalOperations = maxRetainedTerminalOperations;
    this.now = options.now ?? Date.now;
  }

  public start(label: string, initiator: AcquisitionInitiator): AcquisitionOperation {
    this.requireOpen();
    const normalizedLabel = requireLabel(label);
    validateInitiator(initiator);
    const startedAtUnixMs = this.readNow();
    const operation: RunningAcquisitionOperation = {
      id: this.nextId,
      label: normalizedLabel,
      initiator: copyInitiator(initiator),
      startedAtUnixMs,
      state: AcquisitionOperationState.Running,
      progress: emptyProgress(),
    };
    this.nextId += 1;
    this.operations.set(operation.id, operation);
    this.publish(operation);
    return copyOperation(operation);
  }

  public stop(id: number): AcquisitionOperation {
    const current = this.requireRunning(id);
    const operation: AcquisitionOperation = {
      ...current,
      state: AcquisitionOperationState.Stopped,
      stoppedAtUnixMs: this.readNow(),
    };
    this.operations.set(id, operation);
    this.pruneTerminalOperations();
    this.publish(operation);
    return copyOperation(operation);
  }

  public fail(id: number, error: unknown): AcquisitionOperation {
    const current = this.requireRunning(id);
    const failure = error instanceof Error ? error.message : String(error);
    if (failure.length === 0) {
      throw new Error("Acquisition failure must not be empty");
    }
    const operation: AcquisitionOperation = {
      ...current,
      state: AcquisitionOperationState.Failed,
      stoppedAtUnixMs: this.readNow(),
      failure,
    };
    this.operations.set(id, operation);
    this.pruneTerminalOperations();
    this.publish(operation);
    return copyOperation(operation);
  }

  public updateProgress(
    id: number,
    progress: AcquisitionProgressUpdate,
  ): AcquisitionOperation {
    const current = this.requireRunning(id);
    validateProgress(progress);
    const previous = current.progress;
    if (progress.receivedItems < previous.receivedItems) {
      throw new Error("Acquisition received item count must not decrease");
    }
    if (progress.sourceLostItems < previous.sourceLostItems) {
      throw new Error("Acquisition source loss count must not decrease");
    }
    if (previous.lastSequence !== null && progress.lastSequence === null) {
      throw new Error("Acquisition last sequence must not become unknown");
    }
    if (
      previous.lastSequence !== null &&
      progress.lastSequence !== null &&
      progress.lastSequence < previous.lastSequence
    ) {
      throw new Error("Acquisition last sequence must not move backwards");
    }

    const operation: RunningAcquisitionOperation = {
      ...current,
      progress: { ...progress },
    };
    this.operations.set(id, operation);
    this.publish(operation);
    return copyOperation(operation);
  }

  public get(id: number): AcquisitionOperation {
    requirePositiveSafeInteger(id, "operationId");
    const operation = this.operations.get(id);
    if (operation === undefined) {
      throw new Error(`Unknown acquisition operation ${id}`);
    }
    return copyOperation(operation);
  }

  public list(): readonly AcquisitionOperation[] {
    return [...this.operations.values()]
      .sort((left, right) => left.id - right.id)
      .map(copyOperation);
  }

  public subscribe(listener: AcquisitionOperationListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const operation of [...this.operations.values()]) {
      if (operation.state !== AcquisitionOperationState.Running) {
        continue;
      }
      const stopped: AcquisitionOperation = {
        ...operation,
        state: AcquisitionOperationState.Stopped,
        stoppedAtUnixMs: this.readNow(),
      };
      this.operations.set(stopped.id, stopped);
      this.publish(stopped);
    }
    this.pruneTerminalOperations();
  }

  private requireRunning(id: number): RunningAcquisitionOperation {
    this.requireOpen();
    const operation = this.get(id);
    if (operation.state !== AcquisitionOperationState.Running) {
      throw new Error(`Acquisition operation ${id} is not running`);
    }
    return operation;
  }

  private requireOpen(): void {
    if (this.closed) {
      throw new Error("Acquisition service is closed");
    }
  }

  private readNow(): number {
    const value = this.now();
    requireNonNegativeSafeInteger(value, "timestamp");
    return value;
  }

  private pruneTerminalOperations(): void {
    const terminal = [...this.operations.values()]
      .filter((operation) => operation.state !== AcquisitionOperationState.Running)
      .sort((left, right) => left.id - right.id);
    const removeCount = terminal.length - this.maxRetainedTerminalOperations;
    for (let index = 0; index < removeCount; index += 1) {
      const operation = terminal[index];
      if (operation !== undefined) {
        this.operations.delete(operation.id);
      }
    }
  }

  private publish(operation: AcquisitionOperation): void {
    for (const listener of this.listeners) {
      listener(copyOperation(operation));
    }
  }
}

function emptyProgress(): AcquisitionProgress {
  return {
    receivedItems: 0,
    sourceLostItems: 0,
    lastSequence: null,
  };
}

function copyInitiator(initiator: AcquisitionInitiator): AcquisitionInitiator {
  return initiator.kind === AcquisitionInitiatorKind.Server
    ? { kind: AcquisitionInitiatorKind.Server }
    : { kind: AcquisitionInitiatorKind.Browser, sessionId: initiator.sessionId };
}

function copyOperation(operation: AcquisitionOperation): AcquisitionOperation {
  const common = {
    id: operation.id,
    label: operation.label,
    initiator: copyInitiator(operation.initiator),
    startedAtUnixMs: operation.startedAtUnixMs,
    progress: { ...operation.progress },
  };
  switch (operation.state) {
    case AcquisitionOperationState.Running:
      return { ...common, state: AcquisitionOperationState.Running };
    case AcquisitionOperationState.Stopped:
      return {
        ...common,
        state: AcquisitionOperationState.Stopped,
        stoppedAtUnixMs: operation.stoppedAtUnixMs,
      };
    case AcquisitionOperationState.Failed:
      return {
        ...common,
        state: AcquisitionOperationState.Failed,
        stoppedAtUnixMs: operation.stoppedAtUnixMs,
        failure: operation.failure,
      };
  }
}

function requireLabel(label: string): string {
  const normalized = label.trim();
  if (normalized.length === 0) {
    throw new Error("Acquisition label must not be empty");
  }
  if (normalized.length > MAX_LABEL_LENGTH) {
    throw new Error(`Acquisition label must be at most ${MAX_LABEL_LENGTH} characters`);
  }
  return normalized;
}

function validateInitiator(initiator: AcquisitionInitiator): void {
  switch (initiator.kind) {
    case AcquisitionInitiatorKind.Server:
      return;
    case AcquisitionInitiatorKind.Browser:
      requirePositiveSafeInteger(initiator.sessionId, "browser session ID");
      return;
  }
}

function validateProgress(progress: AcquisitionProgressUpdate): void {
  requireNonNegativeSafeInteger(progress.receivedItems, "receivedItems");
  requireNonNegativeSafeInteger(progress.sourceLostItems, "sourceLostItems");
  if (progress.lastSequence !== null) {
    requireNonNegativeSafeInteger(progress.lastSequence, "lastSequence");
  }
}

function requireNonNegativeSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
}

function requirePositiveSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
}