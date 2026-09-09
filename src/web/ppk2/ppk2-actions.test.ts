import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  AcquisitionInitiatorKind,
  AcquisitionOperationState,
  type AcquisitionOperation,
} from "../../shared/acquisition-types.js";
import type { Ppk2Viewport } from "../../shared/ppk2-types.js";
import { Ppk2Actions, type Ppk2ActionBinding } from "./ppk2-actions.js";
import { Ppk2BrowserConnectionKind, usePpk2Store } from "./ppk2-store.js";

const running: AcquisitionOperation = {
  id: 12,
  label: "PPK2 capture",
  initiator: { kind: AcquisitionInitiatorKind.Browser, sessionId: 3 },
  startedAtUnixMs: 100,
  state: AcquisitionOperationState.Running,
  progress: { receivedItems: 0, sourceLostItems: 0, lastSequence: null },
};

const stopped: AcquisitionOperation = {
  ...running,
  state: AcquisitionOperationState.Stopped,
  stoppedAtUnixMs: 200,
};

function binding(overrides: Partial<Ppk2ActionBinding> = {}): Ppk2ActionBinding {
  return {
    startCapture: vi.fn(async () => running),
    stopCapture: vi.fn(async () => stopped),
    requestViewport: vi.fn(async (): Promise<Ppk2Viewport> => ({
      operationId: 12,
      requestedFirstSequence: 0,
      requestedEndSequenceExclusive: 101,
      firstAvailableSequence: 0,
      endAvailableSequenceExclusive: 101,
      buckets: [],
    })),
    ...overrides,
  };
}

beforeEach(() => {
  usePpk2Store.setState({
    connection: { kind: Ppk2BrowserConnectionKind.AwaitingInstrument },
    stats: {
      operation: null,
      receivedSamples: 0,
      lostSamples: 0,
      retainedSamples: 0,
      retainedSeconds: 0,
      latestSequence: null,
      latestCurrentUa: null,
      minCurrentUa: null,
      maxCurrentUa: null,
      meanCurrentUa: null,
      rmsCurrentUa: null,
      chargeMicroampHours: 0,
    },
    liveBuckets: [],
    viewport: null,
    pendingRequest: null,
    requestError: null,
  });
});

describe("Ppk2Actions", () => {
  it("starts capture and reconciles the returned operation", async () => {
    const transport = binding();
    const actions = new Ppk2Actions(transport);

    await actions.startCapture();

    expect(transport.startCapture).toHaveBeenCalledOnce();
    expect(usePpk2Store.getState().stats.operation).toEqual(running);
    expect(usePpk2Store.getState().pendingRequest).toBeNull();
  });

  it("does not issue a duplicate start while an acquisition is running", async () => {
    usePpk2Store.getState().replaceOperation(running);
    const transport = binding();
    const actions = new Ppk2Actions(transport);

    await actions.startCapture();

    expect(transport.startCapture).not.toHaveBeenCalled();
  });

  it("stops the current running acquisition by operation ID", async () => {
    usePpk2Store.getState().replaceOperation(running);
    const transport = binding();
    const actions = new Ppk2Actions(transport);

    await actions.stopCapture();

    expect(transport.stopCapture).toHaveBeenCalledWith(12);
    expect(usePpk2Store.getState().stats.operation).toEqual(stopped);
  });

  it("loads retained history over the known sequence range", async () => {
    usePpk2Store.getState().replaceOperation(stopped);
    usePpk2Store.setState((current) => ({
      stats: { ...current.stats, latestSequence: 100 },
    }));
    const transport = binding();
    const actions = new Ppk2Actions(transport);

    await actions.loadRetainedHistory();

    expect(transport.requestViewport).toHaveBeenCalledWith(12, 0, 101, 1_200);
    expect(usePpk2Store.getState().viewport?.operationId).toBe(12);
  });

  it("owns request failure presentation outside React", async () => {
    const transport = binding({
      startCapture: vi.fn(async () => { throw new Error("bridge offline"); }),
    });
    const actions = new Ppk2Actions(transport);

    await actions.startCapture();

    expect(usePpk2Store.getState().pendingRequest).toBeNull();
    expect(usePpk2Store.getState().requestError).toBe("bridge offline");
  });
});
