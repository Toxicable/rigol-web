import type { ScpiTransport } from "./scpi-transport.js";

export enum ScpiPriority {
  Immediate = 0,
  Interactive = 1,
  Normal = 2,
  Waveform = 3,
  Background = 4,
}

export type ScpiCoalesceKey = symbol;

export enum ScpiOperationKind {
  Identity = 1,
  StateRead = 2,
  Write = 3,
  Action = 4,
  Measurement = 5,
  RawScpi = 6,
  BinaryTransfer = 7,
}

export interface ScpiOperationMetric {
  kind: ScpiOperationKind;
  priority: ScpiPriority;
  queueWaitMs: number;
  durationMs: number;
  binaryByteCount: number;
}

export interface ScpiSchedulerCounters {
  coalescedInteractiveCount: number;
  supersededLatestCount: number;
}

export interface ScpiOperationRecorder {
  addBinaryBytes(byteCount: number): void;
}

export interface ScpiOperation<T> {
  priority: ScpiPriority;
  kind: ScpiOperationKind;
  execute: (transport: ScpiTransport, recorder: ScpiOperationRecorder) => Promise<T>;
}

interface Waiter {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

interface QueuedOperation {
  operation: ScpiOperation<unknown>;
  queuedAt: number;
  waiters: Waiter[];
  coalesceKey: ScpiCoalesceKey | null;
  latest: boolean;
}

const priorityValues = [
  ScpiPriority.Immediate,
  ScpiPriority.Interactive,
  ScpiPriority.Normal,
  ScpiPriority.Waveform,
  ScpiPriority.Background,
] as const;

export class ScpiScheduler {
  private readonly queues = new Map<ScpiPriority, QueuedOperation[]>(
    priorityValues.map((priority) => [priority, []]),
  );
  private running = false;
  private stopped = false;
  private readonly metrics: ScpiOperationMetric[] = [];
  private coalescedInteractiveCount = 0;
  private supersededLatestCount = 0;

  public constructor(private readonly transport: ScpiTransport) {}

  public schedule<T>(operation: ScpiOperation<T>): Promise<T> {
    return this.enqueue(operation, null, false);
  }

  public scheduleInteractive<T>(
    kind: ScpiOperationKind,
    key: ScpiCoalesceKey,
    execute: ScpiOperation<T>["execute"],
  ): Promise<T> {
    return this.enqueue(
      { priority: ScpiPriority.Interactive, kind, execute },
      key,
      false,
    );
  }

  public scheduleImmediate<T>(
    kind: ScpiOperationKind,
    key: ScpiCoalesceKey | null,
    execute: ScpiOperation<T>["execute"],
  ): Promise<T> {
    const staleWaiters = key === null ? [] : this.removePendingInteractive(key);
    return this.enqueue(
      { priority: ScpiPriority.Immediate, kind, execute },
      null,
      false,
      staleWaiters,
    );
  }

  public scheduleLatest<T>(
    priority: ScpiPriority,
    kind: ScpiOperationKind,
    execute: ScpiOperation<T>["execute"],
  ): Promise<T> {
    return this.enqueue({ priority, kind, execute }, null, true);
  }

  public getMetrics(): readonly ScpiOperationMetric[] {
    return this.metrics;
  }

  public getCounters(): ScpiSchedulerCounters {
    return {
      coalescedInteractiveCount: this.coalescedInteractiveCount,
      supersededLatestCount: this.supersededLatestCount,
    };
  }

  public stop(reason: Error = new Error("SCPI scheduler stopped")): void {
    this.stopped = true;
    this.rejectPending(reason);
  }

  private enqueue<T>(
    operation: ScpiOperation<T>,
    coalesceKey: ScpiCoalesceKey | null,
    latest: boolean,
    inheritedWaiters: Waiter[] = [],
  ): Promise<T> {
    if (this.stopped) {
      return Promise.reject(new Error("SCPI scheduler is stopped"));
    }

    return new Promise<T>((resolve, reject) => {
      const waiter: Waiter = {
        resolve: (value) => resolve(value as T),
        reject,
      };

      const queue = this.queueFor(operation.priority);
      const queued: QueuedOperation = {
        operation: operation as ScpiOperation<unknown>,
        queuedAt: performance.now(),
        waiters: [...inheritedWaiters, waiter],
        coalesceKey,
        latest,
      };

      if (coalesceKey !== null) {
        const existingIndex = queue.findIndex((candidate) => candidate.coalesceKey === coalesceKey);
        if (existingIndex >= 0) {
          const existing = queue[existingIndex];
          if (existing === undefined) {
            throw new Error("Invalid SCPI scheduler queue state");
          }
          queued.waiters.unshift(...existing.waiters);
          queue.splice(existingIndex, 1, queued);
          this.coalescedInteractiveCount += 1;
          this.requestPump();
          return;
        }
      }

      if (latest) {
        const existingIndex = queue.findIndex((candidate) => candidate.latest);
        if (existingIndex >= 0) {
          const existing = queue[existingIndex];
          if (existing === undefined) {
            throw new Error("Invalid SCPI scheduler latest queue state");
          }
          queued.waiters.unshift(...existing.waiters);
          queue.splice(existingIndex, 1, queued);
          this.supersededLatestCount += 1;
          this.requestPump();
          return;
        }
      }

      queue.push(queued);
      this.requestPump();
    });
  }

  private requestPump(): void {
    queueMicrotask(() => void this.pump());
  }

  private async pump(): Promise<void> {
    if (this.running || this.stopped) {
      return;
    }

    const next = this.takeNext();
    if (next === null) {
      return;
    }

    this.running = true;
    const startedAt = performance.now();
    let binaryByteCount = 0;
    const recorder: ScpiOperationRecorder = {
      addBinaryBytes: (byteCount) => {
        if (!Number.isSafeInteger(byteCount) || byteCount < 0) {
          throw new Error("binary byte count must be a non-negative safe integer");
        }
        binaryByteCount += byteCount;
      },
    };

    try {
      const result = await next.operation.execute(this.transport, recorder);
      const finishedAt = performance.now();
      this.metrics.push({
        kind: next.operation.kind,
        priority: next.operation.priority,
        queueWaitMs: startedAt - next.queuedAt,
        durationMs: finishedAt - startedAt,
        binaryByteCount,
      });
      for (const waiter of next.waiters) {
        waiter.resolve(result);
      }
    } catch (error) {
      for (const waiter of next.waiters) {
        waiter.reject(error);
      }
      if (!this.transport.isUsable()) {
        this.rejectPending(error);
      }
    } finally {
      this.running = false;
      if (!this.stopped) {
        this.requestPump();
      }
    }
  }

  private takeNext(): QueuedOperation | null {
    for (const priority of priorityValues) {
      const queue = this.queueFor(priority);
      const next = queue.shift();
      if (next !== undefined) {
        return next;
      }
    }
    return null;
  }

  private queueFor(priority: ScpiPriority): QueuedOperation[] {
    const queue = this.queues.get(priority);
    if (queue === undefined) {
      throw new Error(`Unknown SCPI priority: ${priority}`);
    }
    return queue;
  }

  private removePendingInteractive(key: ScpiCoalesceKey): Waiter[] {
    const queue = this.queueFor(ScpiPriority.Interactive);
    const index = queue.findIndex((candidate) => candidate.coalesceKey === key);
    if (index < 0) {
      return [];
    }
    const [removed] = queue.splice(index, 1);
    if (removed === undefined) {
      return [];
    }
    this.coalescedInteractiveCount += 1;
    return removed.waiters;
  }

  private rejectPending(reason: unknown): void {
    for (const priority of priorityValues) {
      const queue = this.queueFor(priority);
      const pending = queue.splice(0, queue.length);
      for (const operation of pending) {
        for (const waiter of operation.waiters) {
          waiter.reject(reason);
        }
      }
    }
  }
}
