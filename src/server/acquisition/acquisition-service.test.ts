import { describe, expect, it, vi } from "vitest";

import {
  AcquisitionInitiatorKind,
  AcquisitionOperationState,
} from "../../shared/acquisition-types.js";
import { AcquisitionService } from "./acquisition-service.js";

describe("AcquisitionService", () => {
  it("owns a running operation independently of browser route state", () => {
    let now = 1_000;
    const service = new AcquisitionService({ now: () => now });

    const started = service.start("bench capture", {
      kind: AcquisitionInitiatorKind.Browser,
      sessionId: 7,
    });

    expect(started).toEqual({
      id: 1,
      label: "bench capture",
      initiator: { kind: AcquisitionInitiatorKind.Browser, sessionId: 7 },
      startedAtUnixMs: 1_000,
      state: AcquisitionOperationState.Running,
      progress: { receivedItems: 0, sourceLostItems: 0, lastSequence: null },
    });

    now = 2_000;
    expect(service.get(1).state).toBe(AcquisitionOperationState.Running);
    const stopped = service.stop(1);
    expect(stopped.state).toBe(AcquisitionOperationState.Stopped);
    if (stopped.state !== AcquisitionOperationState.Stopped) {
      throw new Error("expected stopped operation");
    }
    expect(stopped.stoppedAtUnixMs).toBe(2_000);
  });

  it("tracks monotonic producer progress including source loss", () => {
    const service = new AcquisitionService({ now: () => 1 });
    const operation = service.start("stream", { kind: AcquisitionInitiatorKind.Server });

    service.updateProgress(operation.id, {
      receivedItems: 10_000,
      sourceLostItems: 12,
      lastSequence: 10_011,
    });
    const updated = service.updateProgress(operation.id, {
      receivedItems: 20_000,
      sourceLostItems: 15,
      lastSequence: 20_014,
    });

    expect(updated.progress).toEqual({
      receivedItems: 20_000,
      sourceLostItems: 15,
      lastSequence: 20_014,
    });
    expect(() => service.updateProgress(operation.id, {
      receivedItems: 19_999,
      sourceLostItems: 15,
      lastSequence: 20_014,
    })).toThrow("received item count must not decrease");
  });

  it("retains running operations while bounding terminal metadata", () => {
    let now = 0;
    const service = new AcquisitionService({
      maxRetainedTerminalOperations: 2,
      now: () => ++now,
    });

    const running = service.start("running", { kind: AcquisitionInitiatorKind.Server });
    for (const label of ["one", "two", "three"]) {
      const operation = service.start(label, { kind: AcquisitionInitiatorKind.Server });
      service.stop(operation.id);
    }

    expect(service.list().map((operation) => operation.id)).toEqual([
      running.id,
      3,
      4,
    ]);
    expect(service.get(running.id).state).toBe(AcquisitionOperationState.Running);
  });

  it("publishes lifecycle/progress changes without tying lifetime to a subscriber", () => {
    const service = new AcquisitionService({ now: () => 1 });
    const listener = vi.fn();
    const unsubscribe = service.subscribe(listener);
    const operation = service.start("capture", { kind: AcquisitionInitiatorKind.Server });

    unsubscribe();
    service.updateProgress(operation.id, {
      receivedItems: 5,
      sourceLostItems: 1,
      lastSequence: 5,
    });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(service.get(operation.id).state).toBe(AcquisitionOperationState.Running);
  });

  it("marks running operations stopped on service shutdown", () => {
    let now = 1;
    const service = new AcquisitionService({ now: () => now });
    const operation = service.start("capture", { kind: AcquisitionInitiatorKind.Server });
    now = 2;

    service.close();

    const stopped = service.get(operation.id);
    expect(stopped.state).toBe(AcquisitionOperationState.Stopped);
    expect(() => service.start("late", { kind: AcquisitionInitiatorKind.Server }))
      .toThrow("service is closed");
  });
});
