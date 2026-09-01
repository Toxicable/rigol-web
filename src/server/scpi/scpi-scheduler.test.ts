import { describe, expect, it } from "vitest";

import type { ScpiTransport } from "./scpi-transport.js";
import {
  ScpiOperationKind,
  ScpiPriority,
  ScpiScheduler,
} from "./scpi-scheduler.js";

function fakeTransport(isUsable: () => boolean = () => true): ScpiTransport {
  return { isUsable } as ScpiTransport;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => {};
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("ScpiScheduler", () => {
  it("selects highest priority pending work and FIFO within a priority", async () => {
    const scheduler = new ScpiScheduler(fakeTransport());
    const gate = deferred();
    const order: number[] = [];
    const running = scheduler.schedule({
      priority: ScpiPriority.Normal,
      kind: ScpiOperationKind.Write,
      execute: async () => gate.promise,
    });
    await new Promise((resolve) => setImmediate(resolve));
    const p4 = scheduler.schedule({ priority: ScpiPriority.Background, kind: ScpiOperationKind.StateRead, execute: async () => { order.push(4); } });
    const p1a = scheduler.schedule({ priority: ScpiPriority.Interactive, kind: ScpiOperationKind.Write, execute: async () => { order.push(11); } });
    const p1b = scheduler.schedule({ priority: ScpiPriority.Interactive, kind: ScpiOperationKind.Write, execute: async () => { order.push(12); } });
    const p0 = scheduler.schedule({ priority: ScpiPriority.Immediate, kind: ScpiOperationKind.Action, execute: async () => { order.push(0); } });
    gate.resolve();
    await Promise.all([running, p4, p1a, p1b, p0]);
    expect(order).toEqual([0, 11, 12, 4]);
  });

  it("services a pending waveform between consecutive interactive writes", async () => {
    const scheduler = new ScpiScheduler(fakeTransport());
    const gate = deferred();
    const order: string[] = [];
    const running = scheduler.schedule({
      priority: ScpiPriority.Normal,
      kind: ScpiOperationKind.Write,
      execute: async () => gate.promise,
    });
    await new Promise((resolve) => setImmediate(resolve));
    const interactiveA = scheduler.schedule({
      priority: ScpiPriority.Interactive,
      kind: ScpiOperationKind.Write,
      execute: async () => { order.push("interactive-a"); },
    });
    const interactiveB = scheduler.schedule({
      priority: ScpiPriority.Interactive,
      kind: ScpiOperationKind.Write,
      execute: async () => { order.push("interactive-b"); },
    });
    const waveform = scheduler.schedule({
      priority: ScpiPriority.Waveform,
      kind: ScpiOperationKind.BinaryTransfer,
      execute: async () => { order.push("waveform"); },
    });
    const immediate = scheduler.schedule({
      priority: ScpiPriority.Immediate,
      kind: ScpiOperationKind.Action,
      execute: async () => { order.push("immediate"); },
    });
    gate.resolve();
    await Promise.all([running, interactiveA, interactiveB, waveform, immediate]);
    expect(order).toEqual(["immediate", "interactive-a", "waveform", "interactive-b"]);
  });

  it("coalesces interactive work by opaque caller-owned key", async () => {
    const scheduler = new ScpiScheduler(fakeTransport());
    const gate = deferred();
    const values: number[] = [];
    const running = scheduler.schedule({ priority: ScpiPriority.Normal, kind: ScpiOperationKind.Write, execute: async () => gate.promise });
    await new Promise((resolve) => setImmediate(resolve));
    const key = Symbol("caller-control");
    const a = scheduler.scheduleInteractive(ScpiOperationKind.Write, key, async () => { values.push(1); });
    const b = scheduler.scheduleInteractive(ScpiOperationKind.Write, key, async () => { values.push(2); });
    const c = scheduler.scheduleInteractive(ScpiOperationKind.Write, key, async () => { values.push(3); });
    gate.resolve();
    await Promise.all([running, a, b, c]);
    expect(values).toEqual([3]);
    expect(scheduler.getCounters().coalescedInteractiveCount).toBe(2);
  });

  it("does not collide distinct opaque keys", async () => {
    const scheduler = new ScpiScheduler(fakeTransport());
    const gate = deferred();
    const order: string[] = [];
    const running = scheduler.schedule({ priority: ScpiPriority.Normal, kind: ScpiOperationKind.Write, execute: async () => gate.promise });
    await new Promise((resolve) => setImmediate(resolve));
    const firstKey = Symbol("same-description");
    const secondKey = Symbol("same-description");
    const first = scheduler.scheduleInteractive(ScpiOperationKind.Write, firstKey, async () => { order.push("first"); });
    const second = scheduler.scheduleInteractive(ScpiOperationKind.Write, secondKey, async () => { order.push("second"); });
    gate.resolve();
    await Promise.all([running, first, second]);
    expect(order).toEqual(["first", "second"]);
    expect(scheduler.getCounters().coalescedInteractiveCount).toBe(0);
  });

  it("drops stale pending P1 work when a P0 commit for the same control arrives", async () => {
    const scheduler = new ScpiScheduler(fakeTransport());
    const gate = deferred();
    const order: string[] = [];
    const running = scheduler.schedule({ priority: ScpiPriority.Normal, kind: ScpiOperationKind.Write, execute: async () => gate.promise });
    await new Promise((resolve) => setImmediate(resolve));
    const key = Symbol("caller-control");
    const stale = scheduler.scheduleInteractive(ScpiOperationKind.Write, key, async () => { order.push("stale"); });
    const commit = scheduler.scheduleImmediate(ScpiOperationKind.Write, key, async () => { order.push("commit"); });
    gate.resolve();
    await Promise.all([running, stale, commit]);
    expect(order).toEqual(["commit"]);
  });

  it("retains at most one pending latest operation for the same key", async () => {
    const scheduler = new ScpiScheduler(fakeTransport());
    const gate = deferred();
    const order: number[] = [];
    const key = Symbol("latest-stream");
    const running = scheduler.scheduleLatest(
      ScpiPriority.Waveform,
      key,
      ScpiOperationKind.BinaryTransfer,
      async () => gate.promise,
    );
    await new Promise((resolve) => setImmediate(resolve));
    const a = scheduler.scheduleLatest(ScpiPriority.Waveform, key, ScpiOperationKind.BinaryTransfer, async () => { order.push(1); });
    const b = scheduler.scheduleLatest(ScpiPriority.Waveform, key, ScpiOperationKind.BinaryTransfer, async () => { order.push(2); });
    gate.resolve();
    await Promise.all([running, a, b]);
    expect(order).toEqual([2]);
    expect(scheduler.getCounters().supersededLatestCount).toBe(1);
  });

  it("does not supersede latest work with a different key", async () => {
    const scheduler = new ScpiScheduler(fakeTransport());
    const gate = deferred();
    const order: string[] = [];
    const running = scheduler.schedule({
      priority: ScpiPriority.Normal,
      kind: ScpiOperationKind.Write,
      execute: async () => gate.promise,
    });
    await new Promise((resolve) => setImmediate(resolve));
    const first = scheduler.scheduleLatest(
      ScpiPriority.Waveform,
      Symbol("stream-a"),
      ScpiOperationKind.BinaryTransfer,
      async () => { order.push("a"); },
    );
    const second = scheduler.scheduleLatest(
      ScpiPriority.Waveform,
      Symbol("stream-b"),
      ScpiOperationKind.BinaryTransfer,
      async () => { order.push("b"); },
    );
    gate.resolve();
    await Promise.all([running, first, second]);
    expect(order).toEqual(["a", "b"]);
    expect(scheduler.getCounters().supersededLatestCount).toBe(0);
  });

  it("does not interleave higher priority work inside an in-flight exclusive transaction", async () => {
    const scheduler = new ScpiScheduler(fakeTransport());
    const gate = deferred();
    const order: string[] = [];
    const raw = scheduler.schedule({
      priority: ScpiPriority.Normal,
      kind: ScpiOperationKind.BinaryTransfer,
      execute: async () => {
        order.push("raw-start");
        await gate.promise;
        order.push("raw-end");
      },
    });
    await new Promise((resolve) => setImmediate(resolve));
    const immediate = scheduler.schedule({
      priority: ScpiPriority.Immediate,
      kind: ScpiOperationKind.Action,
      execute: async () => { order.push("p0"); },
    });
    gate.resolve();
    await Promise.all([raw, immediate]);
    expect(order).toEqual(["raw-start", "raw-end", "p0"]);
  });

  it("lets P0 and P1 work run between separate P4 state queries", async () => {
    const scheduler = new ScpiScheduler(fakeTransport());
    const gate = deferred();
    const order: string[] = [];
    const firstBackground = scheduler.schedule({
      priority: ScpiPriority.Background,
      kind: ScpiOperationKind.StateRead,
      execute: async () => {
        order.push("p4-first");
        await gate.promise;
      },
    });
    await new Promise((resolve) => setImmediate(resolve));
    const secondBackground = scheduler.schedule({
      priority: ScpiPriority.Background,
      kind: ScpiOperationKind.StateRead,
      execute: async () => { order.push("p4-second"); },
    });
    const interactive = scheduler.schedule({
      priority: ScpiPriority.Interactive,
      kind: ScpiOperationKind.Write,
      execute: async () => { order.push("p1"); },
    });
    const immediate = scheduler.schedule({
      priority: ScpiPriority.Immediate,
      kind: ScpiOperationKind.Action,
      execute: async () => { order.push("p0"); },
    });
    gate.resolve();
    await Promise.all([firstBackground, secondBackground, interactive, immediate]);
    expect(order).toEqual(["p4-first", "p0", "p1", "p4-second"]);
  });

  it("rejects pending work when the transport becomes unusable", async () => {
    let usable = true;
    const scheduler = new ScpiScheduler(fakeTransport(() => usable));
    const failure = new Error("transport failed");
    let pendingRan = false;

    const running = scheduler.schedule({
      priority: ScpiPriority.Normal,
      kind: ScpiOperationKind.StateRead,
      execute: async () => {
        usable = false;
        throw failure;
      },
    });
    const pending = scheduler.schedule({
      priority: ScpiPriority.Background,
      kind: ScpiOperationKind.StateRead,
      execute: async () => { pendingRan = true; },
    });

    await expect(running).rejects.toBe(failure);
    await expect(pending).rejects.toBe(failure);
    expect(pendingRan).toBe(false);
  });

  it("rejects pending and future work after stop", async () => {
    const scheduler = new ScpiScheduler(fakeTransport());
    const gate = deferred();
    const reason = new Error("stopped for test");
    const running = scheduler.schedule({
      priority: ScpiPriority.Normal,
      kind: ScpiOperationKind.StateRead,
      execute: async () => gate.promise,
    });
    await new Promise((resolve) => setImmediate(resolve));
    const pending = scheduler.schedule({
      priority: ScpiPriority.Background,
      kind: ScpiOperationKind.StateRead,
      execute: async () => undefined,
    });

    scheduler.stop(reason);
    await expect(pending).rejects.toBe(reason);
    await expect(scheduler.schedule({
      priority: ScpiPriority.Normal,
      kind: ScpiOperationKind.StateRead,
      execute: async () => undefined,
    })).rejects.toThrow("SCPI scheduler is stopped");

    gate.resolve();
    await running;
  });
});
