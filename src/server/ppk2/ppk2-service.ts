import {
  AcquisitionOperationState,
  type AcquisitionInitiator,
  type AcquisitionOperation,
} from "../../shared/acquisition-types.js";
import {
  PPK2_SAMPLE_INTERVAL_US,
  PPK2_SAMPLE_RATE_HZ,
  Ppk2ConnectionKind,
  type Ppk2CaptureStats,
  type Ppk2Connection,
  type Ppk2DisplayBucket,
  type Ppk2Viewport,
} from "../../shared/ppk2-types.js";
import type { AcquisitionApplicationService } from "../acquisition/acquisition-service.js";
import { BoundedAcquisitionChunkStore, type AcquisitionChunk } from "../acquisition/bounded-chunk-store.js";
import { Ppk2Runtime, type Ppk2RuntimeOptions } from "./ppk2-runtime.js";
import type { Ppk2DecodedBatch, SequencedPpk2Sample } from "./ppk2-stream-decoder.js";

export const PPK2_RETAINED_BYTES = 64 * 1024 * 1024;
const STORED_SAMPLE_BYTES = 8;
const STORE_CHUNK_SAMPLES = 1_024;
const LIVE_BUCKET_SAMPLES = 100;
const LIVE_PUBLISH_BUCKETS = 20;
const STATS_PUBLISH_SAMPLES = 10_000;
const MAX_VIEWPORT_BUCKETS = 2_000;

export interface Ppk2StoredChunk {
  currentsUa: Float32Array;
  rawWords: Uint32Array;
}

export type Ppk2ConnectionListener = (connection: Ppk2Connection) => void;
export type Ppk2StatsListener = (stats: Ppk2CaptureStats) => void;
export type Ppk2LiveListener = (buckets: readonly Ppk2DisplayBucket[]) => void;

export interface Ppk2ApplicationService {
  readonly runtime: Ppk2Runtime;
  getConnection(): Ppk2Connection;
  getStats(): Ppk2CaptureStats;
  subscribeConnection(listener: Ppk2ConnectionListener): () => void;
  subscribeStats(listener: Ppk2StatsListener): () => void;
  subscribeLive(listener: Ppk2LiveListener): () => void;
  startCapture(initiator: AcquisitionInitiator): Promise<AcquisitionOperation>;
  stopCapture(operationId: number): Promise<AcquisitionOperation>;
  readViewport(
    operationId: number,
    firstSequence: number,
    endSequenceExclusive: number,
    maxBuckets: number,
  ): Ppk2Viewport;
  close(): Promise<void>;
}

export interface Ppk2ServiceOptions {
  host: string;
  port: number;
}

interface PendingStoredChunk {
  firstSequence: number;
  currentsUa: number[];
  rawWords: number[];
}

interface BucketAccumulator {
  firstSequence: number;
  lastSequence: number;
  sampleCount: number;
  minCurrentUa: number;
  maxCurrentUa: number;
  sumCurrentUa: number;
  logicOr: number;
  logicAnd: number;
}

export class Ppk2Service implements Ppk2ApplicationService {
  public readonly runtime: Ppk2Runtime;

  private connection: Ppk2Connection = {
    kind: Ppk2ConnectionKind.Disconnected,
    reason: "PPK2 runtime inactive",
  };
  private readonly store = new BoundedAcquisitionChunkStore<Ppk2StoredChunk>(PPK2_RETAINED_BYTES);
  private readonly connectionListeners = new Set<Ppk2ConnectionListener>();
  private readonly statsListeners = new Set<Ppk2StatsListener>();
  private readonly liveListeners = new Set<Ppk2LiveListener>();
  private activeOperationId: number | null = null;
  private retainedOperationId: number | null = null;
  private pendingChunk: PendingStoredChunk | null = null;
  private liveBucket: BucketAccumulator | null = null;
  private pendingLiveBuckets: Ppk2DisplayBucket[] = [];
  private receivedSamples = 0;
  private lostSamples = 0;
  private latestSequence: number | null = null;
  private latestCurrentUa: number | null = null;
  private minCurrentUa: number | null = null;
  private maxCurrentUa: number | null = null;
  private sumCurrentUa = 0;
  private sumSquaresUa = 0;
  private chargeMicroampHours = 0;
  private nextStatsPublishAt = STATS_PUBLISH_SAMPLES;
  private mutationTail: Promise<void> = Promise.resolve();
  private closed = false;

  public constructor(
    options: Ppk2ServiceOptions,
    private readonly acquisitions: AcquisitionApplicationService,
  ) {
    const runtimeOptions: Ppk2RuntimeOptions = {
      ...options,
      publishConnection: (connection) => this.acceptConnection(connection),
      publishBatch: (batch) => this.acceptBatch(batch),
    };
    this.runtime = new Ppk2Runtime(runtimeOptions);
  }

  public getConnection(): Ppk2Connection {
    return copyConnection(this.connection);
  }

  public getStats(): Ppk2CaptureStats {
    const operation = this.retainedOperationId === null
      ? null
      : this.tryGetOperation(this.retainedOperationId);
    const retainedSamples = this.store.getStats().storedItems + (this.pendingChunk?.currentsUa.length ?? 0);
    return {
      operation,
      receivedSamples: this.receivedSamples,
      lostSamples: this.lostSamples,
      retainedSamples,
      retainedSeconds: retainedSamples / PPK2_SAMPLE_RATE_HZ,
      latestSequence: this.latestSequence,
      latestCurrentUa: this.latestCurrentUa,
      minCurrentUa: this.minCurrentUa,
      maxCurrentUa: this.maxCurrentUa,
      meanCurrentUa: this.receivedSamples === 0 ? null : this.sumCurrentUa / this.receivedSamples,
      rmsCurrentUa: this.receivedSamples === 0
        ? null
        : Math.sqrt(this.sumSquaresUa / this.receivedSamples),
      chargeMicroampHours: this.chargeMicroampHours,
    };
  }

  public subscribeConnection(listener: Ppk2ConnectionListener): () => void {
    this.connectionListeners.add(listener);
    return () => this.connectionListeners.delete(listener);
  }

  public subscribeStats(listener: Ppk2StatsListener): () => void {
    this.statsListeners.add(listener);
    return () => this.statsListeners.delete(listener);
  }

  public subscribeLive(listener: Ppk2LiveListener): () => void {
    this.liveListeners.add(listener);
    return () => this.liveListeners.delete(listener);
  }

  public startCapture(initiator: AcquisitionInitiator): Promise<AcquisitionOperation> {
    return this.serializeMutation(async () => {
      this.requireOpen();
      if (this.activeOperationId !== null) {
        throw new Error(`PPK2 acquisition ${this.activeOperationId} is already running`);
      }
      const session = this.runtime.requireSession();
      this.resetCaptureState();
      const operation = this.acquisitions.start("PPK2 capture", initiator);
      this.activeOperationId = operation.id;
      this.retainedOperationId = operation.id;
      try {
        await session.startMeasurement();
      } catch (error) {
        this.activeOperationId = null;
        this.acquisitions.fail(operation.id, error);
        this.publishStats();
        throw error;
      }
      this.publishStats();
      return this.acquisitions.get(operation.id);
    });
  }

  public stopCapture(operationId: number): Promise<AcquisitionOperation> {
    return this.serializeMutation(async () => {
      this.requireOpen();
      this.requireActiveOperation(operationId);
      const session = this.runtime.requireSession();
      try {
        await session.stopMeasurement();
        this.flushPendingChunk();
        this.flushLiveBucket();
        this.flushLivePublications();
        this.activeOperationId = null;
        const operation = this.acquisitions.stop(operationId);
        this.publishStats();
        return operation;
      } catch (error) {
        this.failActiveCapture(error);
        throw error;
      }
    });
  }

  public readViewport(
    operationId: number,
    firstSequence: number,
    endSequenceExclusive: number,
    maxBuckets: number,
  ): Ppk2Viewport {
    requireNonNegativeSafeInteger(firstSequence, "firstSequence");
    requireNonNegativeSafeInteger(endSequenceExclusive, "endSequenceExclusive");
    if (endSequenceExclusive <= firstSequence) {
      throw new Error("PPK2 viewport end must be greater than its start");
    }
    if (!Number.isInteger(maxBuckets) || maxBuckets < 1 || maxBuckets > MAX_VIEWPORT_BUCKETS) {
      throw new Error(`PPK2 viewport maxBuckets must be 1 through ${MAX_VIEWPORT_BUCKETS}`);
    }
    if (this.retainedOperationId !== operationId) {
      throw new Error(`PPK2 acquisition ${operationId} is not retained in memory`);
    }

    const chunks = [...this.store.readRange(firstSequence, endSequenceExclusive)];
    const pending = this.pendingChunkAsAcquisitionChunk();
    if (pending !== null && rangesIntersect(
      pending.firstSequence,
      pending.firstSequence + pending.itemCount,
      firstSequence,
      endSequenceExclusive,
    )) {
      chunks.push(pending);
    }

    const stats = this.store.getStats();
    const firstAvailableSequence = stats.firstStoredSequence ?? pending?.firstSequence ?? null;
    const pendingEnd = pending === null ? null : pending.firstSequence + pending.itemCount;
    const endAvailableSequenceExclusive = pendingEnd ?? stats.lastStoredSequenceExclusive;
    const bucketWidth = Math.max(1, Math.ceil(
      (endSequenceExclusive - firstSequence) / maxBuckets,
    ));
    const accumulators = new Map<number, BucketAccumulator>();

    for (const chunk of chunks) {
      for (let index = 0; index < chunk.itemCount; index += 1) {
        const sequence = chunk.firstSequence + index;
        if (sequence < firstSequence || sequence >= endSequenceExclusive) continue;
        const currentUa = chunk.payload.currentsUa[index];
        const rawWord = chunk.payload.rawWords[index];
        if (currentUa === undefined || rawWord === undefined) {
          throw new Error("PPK2 retained chunk arrays are inconsistent");
        }
        const bucketIndex = Math.floor((sequence - firstSequence) / bucketWidth);
        const existing = accumulators.get(bucketIndex);
        const logic = (rawWord >>> 24) & 0xff;
        if (existing === undefined) {
          accumulators.set(bucketIndex, createBucket(sequence, currentUa, logic));
        } else {
          addToBucket(existing, sequence, currentUa, logic);
        }
      }
    }

    return {
      operationId,
      requestedFirstSequence: firstSequence,
      requestedEndSequenceExclusive: endSequenceExclusive,
      firstAvailableSequence,
      endAvailableSequenceExclusive,
      buckets: [...accumulators.entries()]
        .sort(([left], [right]) => left - right)
        .map(([, bucket]) => finishBucket(bucket)),
    };
  }

  public async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const active = this.activeOperationId;
    if (active !== null) {
      try {
        const session = this.runtime.requireSession();
        await session.stopMeasurement();
      } catch {
        // Shutdown still records the operation failure below.
      }
      this.failActiveCapture(new Error("PPK2 service closed"));
    }
    await this.runtime.stop();
  }

  private acceptConnection(connection: Ppk2Connection): void {
    this.connection = copyConnection(connection);
    for (const listener of this.connectionListeners) {
      listener(copyConnection(connection));
    }
    if (connection.kind === Ppk2ConnectionKind.Disconnected && this.activeOperationId !== null) {
      this.failActiveCapture(new Error(connection.reason));
    }
  }

  private acceptBatch(batch: Ppk2DecodedBatch): void {
    const operationId = this.activeOperationId;
    if (operationId === null) return;
    try {
      this.lostSamples += batch.lostSamples;
      for (const sample of batch.samples) {
        this.acceptSample(sample);
      }
      this.acquisitions.updateProgress(operationId, {
        receivedItems: this.receivedSamples,
        sourceLostItems: this.lostSamples,
        lastSequence: this.latestSequence,
      });
      if (this.receivedSamples >= this.nextStatsPublishAt) {
        while (this.nextStatsPublishAt <= this.receivedSamples) {
          this.nextStatsPublishAt += STATS_PUBLISH_SAMPLES;
        }
        this.publishStats();
      }
    } catch (error) {
      this.failActiveCapture(error);
      void this.stopRuntimeMeasurementAfterFailure();
    }
  }

  private acceptSample(sample: SequencedPpk2Sample): void {
    if (this.latestSequence !== null && sample.sequence <= this.latestSequence) {
      throw new Error("PPK2 sample sequence did not increase");
    }
    if (this.latestSequence !== null && sample.sequence !== this.latestSequence + 1) {
      this.flushPendingChunk();
      this.flushLiveBucket();
    }

    this.receivedSamples += 1;
    this.latestSequence = sample.sequence;
    this.latestCurrentUa = sample.currentUa;
    this.minCurrentUa = this.minCurrentUa === null
      ? sample.currentUa
      : Math.min(this.minCurrentUa, sample.currentUa);
    this.maxCurrentUa = this.maxCurrentUa === null
      ? sample.currentUa
      : Math.max(this.maxCurrentUa, sample.currentUa);
    this.sumCurrentUa += sample.currentUa;
    this.sumSquaresUa += sample.currentUa * sample.currentUa;
    this.chargeMicroampHours += sample.currentUa * PPK2_SAMPLE_INTERVAL_US / 3_600_000_000;

    if (this.pendingChunk === null) {
      this.pendingChunk = {
        firstSequence: sample.sequence,
        currentsUa: [],
        rawWords: [],
      };
    }
    this.pendingChunk.currentsUa.push(sample.currentUa);
    this.pendingChunk.rawWords.push(sample.rawWord);
    if (this.pendingChunk.currentsUa.length >= STORE_CHUNK_SAMPLES) {
      this.flushPendingChunk();
    }

    const logic = sample.logic & 0xff;
    if (this.liveBucket === null) {
      this.liveBucket = createBucket(sample.sequence, sample.currentUa, logic);
    } else {
      addToBucket(this.liveBucket, sample.sequence, sample.currentUa, logic);
    }
    if (this.liveBucket.sampleCount >= LIVE_BUCKET_SAMPLES) {
      this.flushLiveBucket();
    }
  }

  private flushPendingChunk(): void {
    const pending = this.pendingChunk;
    if (pending === null || pending.currentsUa.length === 0) {
      this.pendingChunk = null;
      return;
    }
    const currentsUa = Float32Array.from(pending.currentsUa);
    const rawWords = Uint32Array.from(pending.rawWords);
    this.store.append({
      firstSequence: pending.firstSequence,
      itemCount: currentsUa.length,
      byteLength: currentsUa.byteLength + rawWords.byteLength,
      payload: { currentsUa, rawWords },
    });
    this.pendingChunk = null;
  }

  private flushLiveBucket(): void {
    if (this.liveBucket === null) return;
    this.pendingLiveBuckets.push(finishBucket(this.liveBucket));
    this.liveBucket = null;
    if (this.pendingLiveBuckets.length >= LIVE_PUBLISH_BUCKETS) {
      this.flushLivePublications();
    }
  }

  private flushLivePublications(): void {
    if (this.pendingLiveBuckets.length === 0) return;
    const buckets = this.pendingLiveBuckets.map((bucket) => ({ ...bucket }));
    this.pendingLiveBuckets = [];
    for (const listener of this.liveListeners) listener(buckets);
  }

  private resetCaptureState(): void {
    this.store.clear();
    this.pendingChunk = null;
    this.liveBucket = null;
    this.pendingLiveBuckets = [];
    this.receivedSamples = 0;
    this.lostSamples = 0;
    this.latestSequence = null;
    this.latestCurrentUa = null;
    this.minCurrentUa = null;
    this.maxCurrentUa = null;
    this.sumCurrentUa = 0;
    this.sumSquaresUa = 0;
    this.chargeMicroampHours = 0;
    this.nextStatsPublishAt = STATS_PUBLISH_SAMPLES;
  }

  private failActiveCapture(error: unknown): void {
    const operationId = this.activeOperationId;
    if (operationId === null) return;
    this.flushPendingChunk();
    this.flushLiveBucket();
    this.flushLivePublications();
    this.activeOperationId = null;
    const current = this.tryGetOperation(operationId);
    if (current?.state === AcquisitionOperationState.Running) {
      this.acquisitions.fail(operationId, error);
    }
    this.publishStats();
  }

  private async stopRuntimeMeasurementAfterFailure(): Promise<void> {
    try {
      await this.runtime.requireSession().stopMeasurement();
    } catch {
      // The operation is already failed; runtime teardown/reconnect owns transport recovery.
    }
  }

  private requireActiveOperation(operationId: number): void {
    if (!Number.isSafeInteger(operationId) || operationId <= 0) {
      throw new Error("PPK2 operationId must be a positive safe integer");
    }
    if (this.activeOperationId !== operationId) {
      throw new Error(`PPK2 acquisition ${operationId} is not the active capture`);
    }
  }

  private requireOpen(): void {
    if (this.closed) throw new Error("PPK2 service is closed");
  }

  private tryGetOperation(operationId: number): AcquisitionOperation | null {
    try {
      return this.acquisitions.get(operationId);
    } catch {
      return null;
    }
  }

  private publishStats(): void {
    const stats = this.getStats();
    for (const listener of this.statsListeners) listener(stats);
  }

  private pendingChunkAsAcquisitionChunk(): AcquisitionChunk<Ppk2StoredChunk> | null {
    const pending = this.pendingChunk;
    if (pending === null || pending.currentsUa.length === 0) return null;
    const currentsUa = Float32Array.from(pending.currentsUa);
    const rawWords = Uint32Array.from(pending.rawWords);
    return {
      firstSequence: pending.firstSequence,
      itemCount: currentsUa.length,
      byteLength: currentsUa.byteLength + rawWords.byteLength,
      payload: { currentsUa, rawWords },
    };
  }

  private serializeMutation<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationTail;
    let release!: () => void;
    this.mutationTail = new Promise<void>((resolve) => { release = resolve; });
    return (async () => {
      await previous;
      try {
        return await operation();
      } finally {
        release();
      }
    })();
  }
}

function createBucket(sequence: number, currentUa: number, logic: number): BucketAccumulator {
  return {
    firstSequence: sequence,
    lastSequence: sequence,
    sampleCount: 1,
    minCurrentUa: currentUa,
    maxCurrentUa: currentUa,
    sumCurrentUa: currentUa,
    logicOr: logic,
    logicAnd: logic,
  };
}

function addToBucket(
  bucket: BucketAccumulator,
  sequence: number,
  currentUa: number,
  logic: number,
): void {
  bucket.lastSequence = sequence;
  bucket.sampleCount += 1;
  bucket.minCurrentUa = Math.min(bucket.minCurrentUa, currentUa);
  bucket.maxCurrentUa = Math.max(bucket.maxCurrentUa, currentUa);
  bucket.sumCurrentUa += currentUa;
  bucket.logicOr |= logic;
  bucket.logicAnd &= logic;
}

function finishBucket(bucket: BucketAccumulator): Ppk2DisplayBucket {
  return {
    firstSequence: bucket.firstSequence,
    lastSequence: bucket.lastSequence,
    sampleCount: bucket.sampleCount,
    minCurrentUa: bucket.minCurrentUa,
    maxCurrentUa: bucket.maxCurrentUa,
    meanCurrentUa: bucket.sumCurrentUa / bucket.sampleCount,
    logicOr: bucket.logicOr,
    logicAnd: bucket.logicAnd,
  };
}

function copyConnection(connection: Ppk2Connection): Ppk2Connection {
  return connection.kind === Ppk2ConnectionKind.Disconnected
    ? { kind: Ppk2ConnectionKind.Disconnected, reason: connection.reason }
    : { kind: Ppk2ConnectionKind.Connected, info: { ...connection.info } };
}

function rangesIntersect(
  firstA: number,
  endA: number,
  firstB: number,
  endB: number,
): boolean {
  return firstA < endB && firstB < endA;
}

function requireNonNegativeSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
}
