import { describe, expect, it, vi } from "vitest";

import {
  DmmControlKind,
  DmmMeasurementFunction,
  type DmmReadingSnapshot,
  type DmmState,
} from "../../shared/dmm-types.js";
import { SupportedInstrument } from "../../shared/instrument-types.js";
import { MessageType } from "../../shared/websocket-protocol.js";
import type { DmmApplicationService } from "../dmm/dmm-service.js";
import {
  DmmConnectionKind,
  type DmmConnection,
} from "../instruments/instrument-connection.js";
import { DmmWebSocketAdapter } from "./dmm-websocket-adapter.js";
import type {
  BinarySendCallback,
  WebSocketAdapterHost,
  WebSocketSession,
} from "./websocket-adapter.js";

class FakeHost implements WebSocketAdapterHost {
  public readonly requireSubscribed = vi.fn();
  public readonly sendJson = vi.fn();
  public readonly sendCompleted = vi.fn();
  public readonly sendFailure = vi.fn();
  public readonly broadcastJson = vi.fn();

  public isOpen(_session: WebSocketSession): boolean { return true; }
  public isBackpressured(_session: WebSocketSession): boolean { return false; }
  public sendBinary(
    _session: WebSocketSession,
    _frame: Uint8Array,
    callback?: BinarySendCallback,
  ): void {
    callback?.(undefined);
  }
  public forEachSubscribed(
    _instrument: SupportedInstrument,
    _callback: (session: WebSocketSession) => void,
  ): void {}
}

interface Harness {
  adapter: DmmWebSocketAdapter;
  host: FakeHost;
  setControl: ReturnType<typeof vi.fn>;
  publishConnection(connection: DmmConnection): void;
  publishSnapshot(snapshot: DmmReadingSnapshot): void;
}

function createHarness(): Harness {
  const connection: DmmConnection = {
    kind: DmmConnectionKind.Disconnected,
    reason: "test inactive",
  };
  let connectionListener: ((connection: DmmConnection) => void) | undefined;
  let snapshotListener: ((snapshot: DmmReadingSnapshot) => void) | undefined;
  const setControl = vi.fn(async () => undefined);
  const service = {
    getConnection: () => connection,
    getCurrentSnapshot: () => null,
    subscribeConnection: (listener: (next: DmmConnection) => void) => {
      connectionListener = listener;
      return () => { connectionListener = undefined; };
    },
    subscribeState: (_listener: (state: DmmState) => void) => () => {},
    subscribeSnapshot: (listener: (snapshot: DmmReadingSnapshot) => void) => {
      snapshotListener = listener;
      return () => { snapshotListener = undefined; };
    },
    setControl,
    executeRawScpi: vi.fn(async (command: string) => `dmm:${command}`),
  } as DmmApplicationService;
  const adapter = new DmmWebSocketAdapter(service);
  const host = new FakeHost();
  adapter.attach(host);
  return {
    adapter,
    host,
    setControl,
    publishConnection: (next) => connectionListener?.(next),
    publishSnapshot: (snapshot) => snapshotListener?.(snapshot),
  };
}

describe("DmmWebSocketAdapter", () => {
  it("validates and dispatches DMM controls without a real socket", async () => {
    const harness = createHarness();
    const session = { id: 1 };

    expect(await harness.adapter.tryDispatch(session, {
      type: MessageType.DmmControlSet,
      requestId: 11,
      control: {
        kind: DmmControlKind.Function,
        value: DmmMeasurementFunction.DcVoltage,
      },
    })).toBe(true);

    expect(harness.host.requireSubscribed).toHaveBeenCalledWith(
      session,
      SupportedInstrument.Dm858e,
    );
    expect(harness.setControl).toHaveBeenCalledWith({
      kind: DmmControlKind.Function,
      value: DmmMeasurementFunction.DcVoltage,
    });
    expect(harness.host.sendCompleted).toHaveBeenCalledWith(session, 11);
    harness.adapter.detach();
  });

  it("rejects completion after the DMM connection changes in flight", async () => {
    const harness = createHarness();
    const session = { id: 2 };
    let release!: () => void;
    harness.setControl.mockImplementationOnce(
      () => new Promise<void>((resolve) => { release = resolve; }),
    );

    const request = harness.adapter.tryDispatch(session, {
      type: MessageType.DmmControlSet,
      requestId: 12,
      control: {
        kind: DmmControlKind.Function,
        value: DmmMeasurementFunction.DcVoltage,
      },
    });
    await vi.waitFor(() => expect(harness.setControl).toHaveBeenCalledOnce());
    harness.publishConnection({
      kind: DmmConnectionKind.Disconnected,
      reason: "replacement session",
    });
    release();

    await expect(request).rejects.toThrow(
      "DMM connection changed while request was in flight",
    );
    expect(harness.host.sendCompleted).not.toHaveBeenCalled();
    harness.adapter.detach();
  });

  it("projects DMM snapshots through the adapter host", () => {
    const harness = createHarness();
    const snapshot = {
      kind: 1,
      function: DmmMeasurementFunction.DcVoltage,
      unit: 1,
      value: 1.25,
      resolution: 0.001,
    } as DmmReadingSnapshot;

    harness.publishSnapshot(snapshot);

    expect(harness.host.broadcastJson).toHaveBeenCalledWith(
      SupportedInstrument.Dm858e,
      { type: MessageType.DmmSnapshot, snapshot },
    );
    harness.adapter.detach();
  });

  it("does not claim raw SCPI targeted at the scope", async () => {
    const harness = createHarness();

    expect(await harness.adapter.tryDispatch({ id: 3 }, {
      type: MessageType.ScpiExecute,
      requestId: 13,
      instrument: SupportedInstrument.Dho804,
      command: "*IDN?",
    })).toBe(false);
    expect(harness.host.requireSubscribed).not.toHaveBeenCalled();
    harness.adapter.detach();
  });
});
