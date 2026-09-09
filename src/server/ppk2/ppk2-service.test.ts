import { describe, expect, it, vi } from "vitest";

import {
  AcquisitionInitiatorKind,
  AcquisitionOperationState,
} from "../../shared/acquisition-types.js";
import { Ppk2ConnectionKind } from "../../shared/ppk2-types.js";
import { AcquisitionService } from "../acquisition/acquisition-service.js";
import { Ppk2Service } from "./ppk2-service.js";
import type { Ppk2DecodedBatch, SequencedPpk2Sample } from "./ppk2-stream-decoder.js";
import type { Ppk2RuntimeSession } from "./ppk2-runtime.js";

interface Ppk2ServiceInternals {
  acceptBatch(batch: Ppk2DecodedBatch): void;
  acceptConnection(connection: {
    kind: Ppk2ConnectionKind.Disconnected;
    reason: string;
  }): void;
}

function sequenced(
  sequence: number,
  currentUa: number,
  logic = 0,
): SequencedPpk2Sample {
  return {
    sequence,
    rawWord: ((logic & 0xff) << 24) >>> 0,
    range: 0,
    counter: sequence % 64,
    logic,
    currentUa,
  };
}

function createHarness() {
  let now = 1_000;
  const acquisitions = new AcquisitionService({ now: () => now });
  const service = new Ppk2Service({ host: "ppk2.test", port: 5557 }, acquisitions);
  const startMeasurement = vi.fn(async () => undefined);
  const stopMeasurement = vi.fn(async () => undefined);
  const session: Ppk2RuntimeSession = {
    sourceSessionId: 123,
    info: {
      sourceSessionId: 123,
      hardwareRevision: null,
      calibrated: null,
      vddMv: 3300,
      sampleIntervalUs: 10,
    },
    metadata: {
      vddMv: 3300,
      mode: 1,
      hardwareRevision: null,
      calibrated: null,
      r: [1, 1, 1, 1, 1],
      gs: [0, 0, 0, 0, 0],
      gi: [1, 1, 1, 1, 1],
      o: [0, 0, 0, 0, 0],
      s: [0, 0, 0, 0, 0],
      i: [0, 0, 0, 0, 0],
      ug: [1, 1, 1, 1, 1],
    },
    startMeasurement,
    stopMeasurement,
  };
  vi.spyOn(service.runtime, "requireSession").mockReturnValue(session);
  return {
    service,
    acquisitions,
    startMeasurement,
    stopMeasurement,
    setNow(value: number) { now = value; },
    internals: service as unknown as Ppk2ServiceInternals,
  };
}

describe("Ppk2Service", () => {
  it("owns capture lifecycle, statistics, charge and retained viewport data", async () => {
    const harness = createHarness();
    const operation = await harness.service.startCapture({
      kind: AcquisitionInitiatorKind.Browser,
      sessionId: 8,
    });

    expect(operation.state).toBe(AcquisitionOperationState.Running);
    expect(harness.startMeasurement).toHaveBeenCalledOnce();

    harness.internals.acceptBatch({
      lostSamples: 0,
      samples: [sequenced(0, 100, 0x01), sequenced(1, 300, 0x02)],
    });

    const stats = harness.service.getStats();
    expect(stats).toMatchObject({
      receivedSamples: 2,
      lostSamples: 0,
      retainedSamples: 2,
      latestSequence: 1,
      latestCurrentUa: 300,
      minCurrentUa: 100,
      maxCurrentUa: 300,
      meanCurrentUa: 200,
    });
    expect(stats.rmsCurrentUa).toBeCloseTo(Math.sqrt(50_000));
    expect(stats.chargeMicroampHours).toBeCloseTo(400 * 10 / 3_600_000_000);
    expect(harness.acquisitions.get(operation.id).progress).toEqual({
      receivedItems: 2,
      sourceLostItems: 0,
      lastSequence: 1,
    });

    const viewport = harness.service.readViewport(operation.id, 0, 2, 2);
    expect(viewport.buckets).toHaveLength(2);
    expect(viewport.buckets[0]).toMatchObject({
      firstSequence: 0,
      lastSequence: 0,
      meanCurrentUa: 100,
      logicOr: 0x01,
      logicAnd: 0x01,
    });

    harness.setNow(2_000);
    const stopped = await harness.service.stopCapture(operation.id);
    expect(stopped.state).toBe(AcquisitionOperationState.Stopped);
    expect(harness.stopMeasurement).toHaveBeenCalledOnce();
  });

  it("carries decoder loss into the shared acquisition operation", async () => {
    const harness = createHarness();
    const operation = await harness.service.startCapture({ kind: AcquisitionInitiatorKind.Server });

    harness.internals.acceptBatch({
      lostSamples: 4,
      samples: [sequenced(4, 50)],
    });

    expect(harness.service.getStats().lostSamples).toBe(4);
    expect(harness.acquisitions.get(operation.id).progress).toEqual({
      receivedItems: 1,
      sourceLostItems: 4,
      lastSequence: 4,
    });
  });

  it("fails an active capture when the physical PPK2 session disconnects", async () => {
    const harness = createHarness();
    const operation = await harness.service.startCapture({ kind: AcquisitionInitiatorKind.Server });

    harness.internals.acceptConnection({
      kind: Ppk2ConnectionKind.Disconnected,
      reason: "bridge connection lost",
    });

    expect(harness.acquisitions.get(operation.id).state).toBe(AcquisitionOperationState.Failed);
    expect(harness.service.getStats().operation?.state).toBe(AcquisitionOperationState.Failed);
  });
});
