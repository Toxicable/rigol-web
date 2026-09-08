export interface AcquisitionChunk<T> {
  firstSequence: number;
  itemCount: number;
  byteLength: number;
  payload: T;
}

export interface AcquisitionStoreStats {
  maxBytes: number;
  storedBytes: number;
  storedItems: number;
  evictedBytes: number;
  evictedItems: number;
  sourceLostItems: number;
  firstStoredSequence: number | null;
  lastStoredSequenceExclusive: number | null;
  nextExpectedSequence: number | null;
}

/**
 * Byte-bounded storage for source-specific acquisition chunks.
 *
 * The store deliberately knows nothing about the payload/sample representation.
 * Callers provide monotonic unwrapped item sequence numbers and payload byte cost.
 * Sequence gaps count as source loss; retention eviction is tracked separately.
 */
export class BoundedAcquisitionChunkStore<T> {
  private readonly chunks: AcquisitionChunk<T>[] = [];
  private storedBytes = 0;
  private storedItems = 0;
  private evictedBytes = 0;
  private evictedItems = 0;
  private sourceLostItems = 0;
  private nextExpectedSequence: number | null = null;

  public constructor(private readonly maxBytes: number) {
    requirePositiveSafeInteger(maxBytes, "maxBytes");
  }

  public append(chunk: AcquisitionChunk<T>): void {
    requireNonNegativeSafeInteger(chunk.firstSequence, "firstSequence");
    requirePositiveSafeInteger(chunk.itemCount, "itemCount");
    requirePositiveSafeInteger(chunk.byteLength, "byteLength");
    if (chunk.byteLength > this.maxBytes) {
      throw new Error("Acquisition chunk exceeds store byte capacity");
    }

    const endSequence = chunk.firstSequence + chunk.itemCount;
    if (!Number.isSafeInteger(endSequence)) {
      throw new Error("Acquisition chunk sequence range exceeds safe integer range");
    }

    const expected = this.nextExpectedSequence;
    if (expected !== null) {
      if (chunk.firstSequence < expected) {
        throw new Error(
          `Acquisition chunk overlaps or moves backwards: expected ${expected}, got ${chunk.firstSequence}`,
        );
      }
      this.sourceLostItems += chunk.firstSequence - expected;
    }
    this.nextExpectedSequence = endSequence;

    this.chunks.push({ ...chunk });
    this.storedBytes += chunk.byteLength;
    this.storedItems += chunk.itemCount;
    this.evictToCapacity();
  }

  public readRange(
    firstSequence: number,
    endSequenceExclusive: number,
  ): readonly AcquisitionChunk<T>[] {
    requireNonNegativeSafeInteger(firstSequence, "firstSequence");
    requireNonNegativeSafeInteger(endSequenceExclusive, "endSequenceExclusive");
    if (endSequenceExclusive <= firstSequence) {
      throw new Error("Acquisition range end must be greater than its start");
    }

    return this.chunks
      .filter((chunk) => {
        const chunkEnd = chunk.firstSequence + chunk.itemCount;
        return chunk.firstSequence < endSequenceExclusive && chunkEnd > firstSequence;
      })
      .map((chunk) => ({ ...chunk }));
  }

  public exportChunks(): readonly AcquisitionChunk<T>[] {
    return this.chunks.map((chunk) => ({ ...chunk }));
  }

  public getStats(): AcquisitionStoreStats {
    const first = this.chunks[0];
    const last = this.chunks.at(-1);
    return {
      maxBytes: this.maxBytes,
      storedBytes: this.storedBytes,
      storedItems: this.storedItems,
      evictedBytes: this.evictedBytes,
      evictedItems: this.evictedItems,
      sourceLostItems: this.sourceLostItems,
      firstStoredSequence: first?.firstSequence ?? null,
      lastStoredSequenceExclusive: last === undefined
        ? null
        : last.firstSequence + last.itemCount,
      nextExpectedSequence: this.nextExpectedSequence,
    };
  }

  public clear(): void {
    this.chunks.length = 0;
    this.storedBytes = 0;
    this.storedItems = 0;
    this.evictedBytes = 0;
    this.evictedItems = 0;
    this.sourceLostItems = 0;
    this.nextExpectedSequence = null;
  }

  private evictToCapacity(): void {
    while (this.storedBytes > this.maxBytes) {
      const evicted = this.chunks.shift();
      if (evicted === undefined) {
        throw new Error("Acquisition store accounting became inconsistent");
      }
      this.storedBytes -= evicted.byteLength;
      this.storedItems -= evicted.itemCount;
      this.evictedBytes += evicted.byteLength;
      this.evictedItems += evicted.itemCount;
    }
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
