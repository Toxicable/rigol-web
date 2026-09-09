import { Buffer } from "node:buffer";

import {
  PPK2_COUNTER_MODULUS,
  PPK2_SAMPLE_BYTES,
  Ppk2CurrentConverter,
  type Ppk2RawSample,
} from "./ppk2-protocol.js";

export interface SequencedPpk2Sample extends Ppk2RawSample {
  sequence: number;
}

export interface Ppk2DecodedBatch {
  samples: readonly SequencedPpk2Sample[];
  lostSamples: number;
}

/**
 * Parses the measurement byte stream while preserving two independent loss
 * signals:
 * - bridge byte-offset gaps (exact across network/buffer loss), and
 * - native PPK2 6-bit counter gaps while bridge bytes remain contiguous.
 *
 * A bridge gap is recoverable only when both sides of the gap preserve the
 * measurement's four-byte sample boundary. Otherwise sample identity becomes
 * ambiguous and the acquisition fails instead of guessing a resynchronization.
 */
export class Ppk2StreamDecoder {
  private sourceSessionId: number | null = null;
  private measurementBaseOffset = 0;
  private expectedStreamOffset = 0;
  private buffer = Buffer.alloc(0);
  private bufferStartOffset = 0;
  private expectedCounter: number | null = null;
  private nativeLostBefore = 0;

  public constructor(private readonly converter: Ppk2CurrentConverter) {}

  public start(sourceSessionId: number, nextStreamOffset: number): void {
    requirePositiveInteger(sourceSessionId, "sourceSessionId");
    requireNonNegativeSafeInteger(nextStreamOffset, "nextStreamOffset");
    this.sourceSessionId = sourceSessionId;
    this.measurementBaseOffset = nextStreamOffset;
    this.expectedStreamOffset = nextStreamOffset;
    this.buffer = Buffer.alloc(0);
    this.bufferStartOffset = nextStreamOffset;
    this.expectedCounter = null;
    this.nativeLostBefore = 0;
    this.converter.resetFilter();
  }

  public stop(): void {
    this.sourceSessionId = null;
    this.buffer = Buffer.alloc(0);
    this.expectedCounter = null;
  }

  public push(
    sourceSessionId: number,
    streamOffset: number,
    payload: Buffer,
  ): Ppk2DecodedBatch {
    if (this.sourceSessionId === null) {
      throw new Error("PPK2 measurement decoder is not running");
    }
    if (sourceSessionId !== this.sourceSessionId) {
      throw new Error("PPK2 source session changed during acquisition");
    }
    requireNonNegativeSafeInteger(streamOffset, "streamOffset");
    if (payload.length === 0) {
      return { samples: [], lostSamples: 0 };
    }
    if (streamOffset < this.expectedStreamOffset) {
      throw new Error("PPK2 bridge stream offset moved backwards or replayed data");
    }

    let lostSamples = 0;
    if (streamOffset > this.expectedStreamOffset) {
      const missingBytes = streamOffset - this.expectedStreamOffset;
      const expectedRelative = this.expectedStreamOffset - this.measurementBaseOffset;
      const resumedRelative = streamOffset - this.measurementBaseOffset;
      if (
        missingBytes % PPK2_SAMPLE_BYTES !== 0 ||
        expectedRelative % PPK2_SAMPLE_BYTES !== 0 ||
        resumedRelative % PPK2_SAMPLE_BYTES !== 0
      ) {
        throw new Error(
          "PPK2 bridge byte loss crossed an uncertain sample boundary",
        );
      }

      lostSamples += missingBytes / PPK2_SAMPLE_BYTES;
      this.buffer = Buffer.alloc(0);
      this.bufferStartOffset = streamOffset;
      this.expectedCounter = null;
    }

    this.expectedStreamOffset = streamOffset + payload.length;
    if (this.buffer.length === 0) {
      this.bufferStartOffset = streamOffset;
      this.buffer = Buffer.from(payload);
    } else {
      const expectedBufferAppendOffset = this.bufferStartOffset + this.buffer.length;
      if (streamOffset !== expectedBufferAppendOffset) {
        throw new Error("PPK2 decoder byte-buffer continuity invariant failed");
      }
      this.buffer = Buffer.concat([this.buffer, payload]);
    }

    const samples: SequencedPpk2Sample[] = [];
    let consumed = 0;
    while (this.buffer.length - consumed >= PPK2_SAMPLE_BYTES) {
      const sampleOffset = this.bufferStartOffset + consumed;
      const rawWord = this.buffer.readUInt32LE(consumed);
      const decoded = this.converter.decode(rawWord);
      let counterLoss = 0;
      if (this.expectedCounter !== null && decoded.counter !== this.expectedCounter) {
        counterLoss = (
          decoded.counter - this.expectedCounter + PPK2_COUNTER_MODULUS
        ) % PPK2_COUNTER_MODULUS;
        this.nativeLostBefore += counterLoss;
        lostSamples += counterLoss;
      }
      this.expectedCounter = (decoded.counter + 1) % PPK2_COUNTER_MODULUS;

      const wireSequence = Math.floor(
        (sampleOffset - this.measurementBaseOffset) / PPK2_SAMPLE_BYTES,
      );
      const sequence = wireSequence + this.nativeLostBefore;
      if (!Number.isSafeInteger(sequence) || sequence < 0) {
        throw new Error("PPK2 sample sequence exceeds JavaScript safe integer range");
      }
      samples.push({ ...decoded, sequence });
      consumed += PPK2_SAMPLE_BYTES;
    }

    if (consumed > 0) {
      this.bufferStartOffset += consumed;
      this.buffer = Buffer.from(this.buffer.subarray(consumed));
    }
    return { samples, lostSamples };
  }
}

function requirePositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
}

function requireNonNegativeSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
}
