import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  AcquisitionInitiatorKind,
  AcquisitionOperationState,
  type AcquisitionOperation,
} from "../../shared/acquisition-types.js";
import { SupportedInstrument } from "../../shared/instrument-types.js";
import type { Ppk2CaptureStats } from "../../shared/ppk2-types.js";
import {
  MessageType,
  PROTOCOL_VERSION,
  type RequestMessage,
  type ServerJsonMessage,
} from "../../shared/websocket-protocol.js";
import type { AppConnection } from "../app-connection.js";
import { Ppk2Binding } from "./ppk2-binding.js";
import { Ppk2BrowserConnectionKind, usePpk2Store } from "./ppk2-store.js";

const operation: AcquisitionOperation = {
  id: 5,
  label: "PPK2 capture",
  initiator: { kind: AcquisitionInitiatorKind.Browser, sessionId: 2 },
  startedAtUnixMs: 10,
  state: AcquisitionOperationState.Running,
  progress: { receivedItems: 1, sourceLostItems: 0, lastSequence: 0 },
};

const stats: Ppk2CaptureStats = {
  operation,
  receivedSamples: 1,
  lostSamples: 0,
  retainedSamples: 1,
  retainedSeconds: 0.00001,
  latestSequence: 0,
  latestCurrentUa: 42,
  minCurrentUa: 42,
  maxCurrentUa: 42,
  meanCurrentUa: 42,
  rmsCurrentUa: 42,
  chargeMicroampHours: 0.0000001167,
};

function harness() {
  let listener: ((message: ServerJsonMessage) => void) | undefined;
  const subscribeInstrument = vi.fn();
  const unsubscribeInstrument = vi.fn();
  const request = vi.fn(async (builder: (requestId: number) => RequestMessage) => {
    const message = builder(17);
    switch (message.type) {
      case MessageType.Ppk2CaptureStart:
        return {
          type: MessageType.AcquisitionOperationResult,
          requestId: 17,
          operation,
        } as const;
      case MessageType.Ppk2CaptureStop:
        return {
          type: MessageType.AcquisitionOperationResult,
          requestId: 17,
          operation: {
            ...operation,
            state: AcquisitionOperationState.Stopped as const,
            stoppedAtUnixMs: 20,
          },
        } as const;
      case MessageType.Ppk2ViewportRequest:
        return {
          type: MessageType.Ppk2ViewportResult,
          requestId: 17,
          viewport: {
            operationId: operation.id,
            requestedFirstSequence: message.firstSequence,
            requestedEndSequenceExclusive: message.endSequenceExclusive,
            firstAvailableSequence: 0,
            endAvailableSequenceExclusive: 1,
            buckets: [],
          },
        } as const;
      default:
        throw new Error(`Unexpected request type ${message.type}`);
    }
  });
  const connection = {
    onJsonMessage: (next: (message: ServerJsonMessage) => void) => {
      listener = next;
      return () => { listener = undefined; };
    },
    subscribeInstrument,
    unsubscribeInstrument,
    request,
  } as unknown as AppConnection;
  return {
    binding: new Ppk2Binding(connection),
    subscribeInstrument,
    unsubscribeInstrument,
    request,
    publish(message: ServerJsonMessage) { listener?.(message); },
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

describe("Ppk2Binding", () => {
  it("maps route activation to PPK2 publication subscription only", () => {
    const client = harness();

    client.binding.activate();
    client.binding.deactivate();

    expect(client.subscribeInstrument).toHaveBeenCalledWith(SupportedInstrument.Ppk2);
    expect(client.unsubscribeInstrument).toHaveBeenCalledWith(SupportedInstrument.Ppk2);
  });

  it("projects PPK2 lifecycle, stats and live publications into the domain store", () => {
    const client = harness();
    client.binding.activate();
    client.publish({
      type: MessageType.Ppk2Connected,
      protocolVersion: PROTOCOL_VERSION,
      info: {
        sourceSessionId: 9,
        hardwareRevision: null,
        calibrated: null,
        vddMv: 3300,
        sampleIntervalUs: 10,
      },
    });
    client.publish({ type: MessageType.Ppk2Stats, stats });
    client.publish({
      type: MessageType.Ppk2Live,
      update: {
        operationId: operation.id,
        buckets: [{
          firstSequence: 0,
          lastSequence: 0,
          sampleCount: 1,
          minCurrentUa: 42,
          maxCurrentUa: 42,
          meanCurrentUa: 42,
          logicOr: 0,
          logicAnd: 0,
        }],
      },
    });

    expect(usePpk2Store.getState().connection.kind).toBe(Ppk2BrowserConnectionKind.Connected);
    expect(usePpk2Store.getState().stats).toEqual(stats);
    expect(usePpk2Store.getState().liveBuckets).toHaveLength(1);
  });

  it("uses application request correlation for capture and viewport operations", async () => {
    const client = harness();
    const started = await client.binding.startCapture();
    const stopped = await client.binding.stopCapture(operation.id);
    const viewport = await client.binding.requestViewport(operation.id, 0, 1, 100);

    expect(started).toEqual(operation);
    expect(stopped.state).toBe(AcquisitionOperationState.Stopped);
    expect(viewport.operationId).toBe(operation.id);
    expect(client.request).toHaveBeenCalledTimes(3);
  });
});
