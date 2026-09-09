import { describe, expect, it, vi } from "vitest";

import {
  AcquisitionInitiatorKind,
  AcquisitionOperationState,
  type AcquisitionOperation,
} from "../../shared/acquisition-types.js";
import { SupportedInstrument } from "../../shared/instrument-types.js";
import {
  Ppk2ConnectionKind,
  type Ppk2CaptureStats,
  type Ppk2Connection,
  type Ppk2DisplayBucket,
} from "../../shared/ppk2-types.js";
import { MessageType, PROTOCOL_VERSION } from "../../shared/websocket-protocol.js";
import type { Ppk2ApplicationService } from "../ppk2/ppk2-service.js";
import { Ppk2WebSocketAdapter } from "./ppk2-websocket-adapter.js";
import type { WebSocketAdapterHost, WebSocketSession } from "./websocket-adapter.js";

const operation: AcquisitionOperation = {
  id: 4,
  label: "PPK2 capture",
  initiator: { kind: AcquisitionInitiatorKind.Browser, sessionId: 7 },
  startedAtUnixMs: 1_000,
  state: AcquisitionOperationState.Running,
  progress: { receivedItems: 20, sourceLostItems: 1, lastSequence: 20 },
};

const connection: Ppk2Connection = {
  kind: Ppk2ConnectionKind.Connected,
  info: {
    sourceSessionId: 123,
    hardwareRevision: "2.0.1",
    calibrated: "yes",
    vddMv: 3300,
    sampleIntervalUs: 10,
  },
};

const stats: Ppk2CaptureStats = {
  operation,
  receivedSamples: 20,
  lostSamples: 1,
  retainedSamples: 20,
  retainedSeconds: 0.0002,
  latestSequence: 20,
  latestCurrentUa: 120,
  minCurrentUa: 100,
  maxCurrentUa: 140,
  meanCurrentUa: 118,
  rmsCurrentUa: 119,
  chargeMicroampHours: 0.001,
};

function createHarness() {
  let connectionListener: ((value: Ppk2Connection) => void) | undefined;
  let statsListener: ((value: Ppk2CaptureStats) => void) | undefined;
  let liveListener: ((value: readonly Ppk2DisplayBucket[]) => void) | undefined;
  const subscriber: WebSocketSession = { id: 88 };
  const startCapture = vi.fn(async () => operation);
  const stopCapture = vi.fn(async () => ({
    ...operation,
    state: AcquisitionOperationState.Stopped as const,
    stoppedAtUnixMs: 2_000,
  }));
  const readViewport = vi.fn(() => ({
    operationId: operation.id,
    requestedFirstSequence: 0,
    requestedEndSequenceExclusive: 21,
    firstAvailableSequence: 0,
    endAvailableSequenceExclusive: 21,
    buckets: [],
  }));
  const service = {
    getConnection: () => connection,
    getStats: () => stats,
    subscribeConnection: (listener: (value: Ppk2Connection) => void) => {
      connectionListener = listener;
      return () => { connectionListener = undefined; };
    },
    subscribeStats: (listener: (value: Ppk2CaptureStats) => void) => {
      statsListener = listener;
      return () => { statsListener = undefined; };
    },
    subscribeLive: (listener: (value: readonly Ppk2DisplayBucket[]) => void) => {
      liveListener = listener;
      return () => { liveListener = undefined; };
    },
    startCapture,
    stopCapture,
    readViewport,
  } as unknown as Ppk2ApplicationService;
  const isBackpressured = vi.fn(() => false);
  const sendJson = vi.fn();
  const forEachSubscribed = vi.fn(
    (_instrument: SupportedInstrument, callback: (session: WebSocketSession) => void) => {
      callback(subscriber);
    },
  );
  const host = {
    requireSubscribed: vi.fn(),
    sendJson,
    isOpen: vi.fn(() => true),
    isBackpressured,
    sendBinary: vi.fn(),
    sendCompleted: vi.fn(),
    sendFailure: vi.fn(),
    broadcastJson: vi.fn(),
    forEachSubscribed,
  } as unknown as WebSocketAdapterHost;
  const adapter = new Ppk2WebSocketAdapter(service);
  adapter.attach(host);
  return {
    adapter,
    host,
    subscriber,
    startCapture,
    stopCapture,
    readViewport,
    isBackpressured,
    sendJson,
    publishConnection: (value: Ppk2Connection) => connectionListener?.(value),
    publishStats: (value: Ppk2CaptureStats) => statsListener?.(value),
    publishLive: (value: readonly Ppk2DisplayBucket[]) => liveListener?.(value),
  };
}

describe("Ppk2WebSocketAdapter", () => {
  it("replays lifecycle and stats to a new subscriber", () => {
    const harness = createHarness();
    const session: WebSocketSession = { id: 7 };

    harness.adapter.sendInitialPublications(session);

    expect(harness.host.sendJson).toHaveBeenNthCalledWith(1, session, {
      type: MessageType.Ppk2Connected,
      protocolVersion: PROTOCOL_VERSION,
      info: connection.info,
    });
    expect(harness.host.sendJson).toHaveBeenNthCalledWith(2, session, {
      type: MessageType.Ppk2Stats,
      stats,
    });
  });

  it("starts a capture with browser-session initiator metadata", async () => {
    const harness = createHarness();
    const session: WebSocketSession = { id: 19 };

    await harness.adapter.tryDispatch(session, {
      type: MessageType.Ppk2CaptureStart,
      requestId: 3,
    });

    expect(harness.host.requireSubscribed).toHaveBeenCalledWith(
      session,
      SupportedInstrument.Ppk2,
    );
    expect(harness.startCapture).toHaveBeenCalledWith({
      kind: AcquisitionInitiatorKind.Browser,
      sessionId: 19,
    });
    expect(harness.host.sendJson).toHaveBeenCalledWith(session, {
      type: MessageType.AcquisitionOperationResult,
      requestId: 3,
      operation,
    });
  });

  it("does not stop a capture when the browser unsubscribes", () => {
    const harness = createHarness();
    harness.adapter.sessionUnsubscribed({ id: 7 });
    expect(harness.stopCapture).not.toHaveBeenCalled();
  });

  it("tags live decimated publication with its acquisition ID", () => {
    const harness = createHarness();
    const bucket: Ppk2DisplayBucket = {
      firstSequence: 10,
      lastSequence: 19,
      sampleCount: 10,
      minCurrentUa: 1,
      maxCurrentUa: 3,
      meanCurrentUa: 2,
      logicOr: 1,
      logicAnd: 0,
    };

    harness.publishLive([bucket]);

    expect(harness.isBackpressured).toHaveBeenCalledWith(harness.subscriber);
    expect(harness.sendJson).toHaveBeenCalledWith(
      harness.subscriber,
      {
        type: MessageType.Ppk2Live,
        update: { operationId: operation.id, buckets: [bucket] },
      },
    );
  });

  it("drops only decimated live display updates for a backpressured browser", () => {
    const harness = createHarness();
    harness.isBackpressured.mockReturnValue(true);
    const bucket: Ppk2DisplayBucket = {
      firstSequence: 1,
      lastSequence: 1,
      sampleCount: 1,
      minCurrentUa: 2,
      maxCurrentUa: 2,
      meanCurrentUa: 2,
      logicOr: 0,
      logicAnd: 0,
    };

    harness.publishLive([bucket]);

    expect(harness.sendJson).not.toHaveBeenCalled();
    expect(harness.stopCapture).not.toHaveBeenCalled();
  });

  it("validates and returns retained viewport requests", async () => {
    const harness = createHarness();
    const session: WebSocketSession = { id: 8 };

    await harness.adapter.tryDispatch(session, {
      type: MessageType.Ppk2ViewportRequest,
      requestId: 9,
      operationId: 4,
      firstSequence: 0,
      endSequenceExclusive: 21,
      maxBuckets: 100,
    });

    expect(harness.readViewport).toHaveBeenCalledWith(4, 0, 21, 100);
    expect(harness.host.sendJson).toHaveBeenCalledWith(session, {
      type: MessageType.Ppk2ViewportResult,
      requestId: 9,
      viewport: expect.objectContaining({ operationId: 4 }),
    });
  });
});
