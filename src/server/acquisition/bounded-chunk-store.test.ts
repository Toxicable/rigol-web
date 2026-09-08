import { describe, expect, it } from "vitest";

import { BoundedAcquisitionChunkStore } from "./bounded-chunk-store.js";

describe("BoundedAcquisitionChunkStore", () => {
  it("evicts oldest complete chunks to enforce byte capacity", () => {
    const store = new BoundedAcquisitionChunkStore<string>(10);

    store.append({ firstSequence: 100, itemCount: 2, byteLength: 4, payload: "a" });
    store.append({ firstSequence: 102, itemCount: 3, byteLength: 5, payload: "b" });
    store.append({ firstSequence: 105, itemCount: 1, byteLength: 4, payload: "c" });

    expect(store.exportChunks().map((chunk) => chunk.payload)).toEqual(["b", "c"]);
    expect(store.getStats()).toEqual({
      maxBytes: 10,
      storedBytes: 9,
      storedItems: 4,
      evictedBytes: 4,
      evictedItems: 2,
      sourceLostItems: 0,
      firstStoredSequence: 102,
      lastStoredSequenceExclusive: 106,
      nextExpectedSequence: 106,
    });
  });

  it("tracks source sequence gaps separately from retention eviction", () => {
    const store = new BoundedAcquisitionChunkStore<Uint8Array>(8);

    store.append({
      firstSequence: 20,
      itemCount: 2,
      byteLength: 4,
      payload: new Uint8Array([1, 2, 3, 4]),
    });
    store.append({
      firstSequence: 25,
      itemCount: 2,
      byteLength: 4,
      payload: new Uint8Array([5, 6, 7, 8]),
    });
    store.append({
      firstSequence: 27,
      itemCount: 2,
      byteLength: 4,
      payload: new Uint8Array([9, 10, 11, 12]),
    });

    const stats = store.getStats();
    expect(stats.sourceLostItems).toBe(3);
    expect(stats.evictedItems).toBe(2);
    expect(stats.firstStoredSequence).toBe(25);
    expect(stats.nextExpectedSequence).toBe(29);
  });

  it("returns source-specific chunks intersecting a sequence range", () => {
    const store = new BoundedAcquisitionChunkStore<string>(100);
    store.append({ firstSequence: 0, itemCount: 10, byteLength: 10, payload: "first" });
    store.append({ firstSequence: 10, itemCount: 10, byteLength: 10, payload: "second" });
    store.append({ firstSequence: 20, itemCount: 10, byteLength: 10, payload: "third" });

    expect(store.readRange(9, 21).map((chunk) => chunk.payload)).toEqual([
      "first",
      "second",
      "third",
    ]);
    expect(store.readRange(10, 20).map((chunk) => chunk.payload)).toEqual(["second"]);
  });

  it("rejects overlaps/backwards sequence and chunks larger than capacity", () => {
    const store = new BoundedAcquisitionChunkStore<string>(10);
    store.append({ firstSequence: 5, itemCount: 3, byteLength: 3, payload: "ok" });

    expect(() => store.append({
      firstSequence: 7,
      itemCount: 1,
      byteLength: 1,
      payload: "overlap",
    })).toThrow("overlaps or moves backwards");

    expect(() => store.append({
      firstSequence: 8,
      itemCount: 1,
      byteLength: 11,
      payload: "too large",
    })).toThrow("exceeds store byte capacity");
  });
});
