import { beforeEach, describe, expect, it } from "vitest";

import {
  AcquisitionType,
  Channel,
  ChannelCoupling,
  ChannelUnit,
  EdgeSlope,
  MeasurementKind,
  ScopeRunState,
  TimebaseMode,
  TriggerCoupling,
  TriggerSweep,
  TriggerType,
  type ScopeState,
} from "../shared/scope-types.js";
import {
  AcquisitionAction,
  ControlKind,
  MessageType,
  PROTOCOL_VERSION,
  type ClientMessage,
} from "../shared/websocket-protocol.js";
import {
  BrowserConnectionKind,
  DeepCaptureKind,
  useScopeStore,
} from "./scope-store.js";
import {
  ScopeWebSocketClient,
  type WebSocketLike,
} from "./websocket-client.js";
import {
  WaveformController,
  WaveformDisplayMode,
} from "./waveform/waveform-controller.js";

class FakeSocket implements WebSocketLike {
  public binaryType: BinaryType = "blob";
  public readyState = 1;
  public onopen: (() => void) | null = null;
  public onmessage: ((event: { data: string | ArrayBuffer }) => void) | null = null;
  public onclose: ((event: { reason: string }) => void) | null = null;
  public onerror: (() => void) | null = null;
  public readonly sent: ClientMessage[] = [];

  public send(data: string): void {
    this.sent.push(JSON.parse(data) as ClientMessage);
  }

  public close(): void {
    this.readyState = 3;
  }

  public receive(message: object): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

function scope(runState: ScopeRunState): ScopeState {
  return {
    channels: [Channel.Ch1, Channel.Ch2, Channel.Ch3, Channel.Ch4].map((channel) => ({
      channel,
      enabled: true,
      coupling: ChannelCoupling.Dc,
      unit: ChannelUnit.Volts,
      scale: 1,
      offset: 0,
      probeRatio: 1,
    })) as ScopeState["channels"],
    horizontal: { mode: TimebaseMode.Main, scale: 0.001, position: 0 },
    acquisition: {
      type: AcquisitionType.Normal,
      averages: 1,
      memoryDepth: 1_000_000,
      sampleRate: 1e9,
    },
    runState,
    trigger: {
      type: TriggerType.Edge,
      sweep: TriggerSweep.Auto,
      source: Channel.Ch1,
      slope: EdgeSlope.Rising,
      level: 0,
      coupling: TriggerCoupling.Dc,
    },
  };
}

const DEEP_CHANNEL = {
  channel: Channel.Ch1,
  unit: ChannelUnit.Volts,
  sampleCount: 1000,
  xIncrement: 1e-6,
  xOrigin: 0,
  xReference: 0,
} as const;

describe("WebSocket client", () => {
  let socket: FakeSocket;
  let client: ScopeWebSocketClient;
  let controller: WaveformController;

  beforeEach(() => {
    socket = new FakeSocket();
    controller = new WaveformController(() => 0);
    client = new ScopeWebSocketClient(controller, () => socket, () => "ws://test/ws");
    useScopeStore.setState({
      connection: { kind: BrowserConnectionKind.Connecting },
      measurementSpecs: [],
      measurementValues: [],
      deepCapture: { kind: DeepCaptureKind.None },
      lastError: null,
    });
    client.connect();
    socket.receive({
      type: MessageType.ProtocolHello,
      protocolVersion: PROTOCOL_VERSION,
    });
    expect(socket.sent).toEqual([{
      type: MessageType.ProtocolHelloAck,
      protocolVersion: PROTOCOL_VERSION,
    }]);
    socket.sent.length = 0;
  });

  it("sets arraybuffer mode and associates monotonically increasing request IDs", async () => {
    expect(socket.binaryType).toBe("arraybuffer");
    const first = client.setControl({
      kind: ControlKind.ChannelEnabled,
      channel: Channel.Ch1,
      value: true,
    });
    const second = client.setControl({
      kind: ControlKind.ChannelEnabled,
      channel: Channel.Ch2,
      value: true,
    });
    expect(socket.sent.map((message) => "requestId" in message ? message.requestId : null)).toEqual([0, 1]);
    socket.receive({ type: MessageType.CommandCompleted, requestId: 1 });
    socket.receive({ type: MessageType.CommandCompleted, requestId: 0 });
    await Promise.all([first, second]);
  });

  it("sends interaction updates without request IDs and commits with one", async () => {
    client.interactionUpdate({
      kind: ControlKind.HorizontalPosition,
      value: 1,
    });
    const update = socket.sent[0];
    expect(update?.type).toBe(MessageType.InteractionUpdate);
    expect(update !== undefined && "requestId" in update).toBe(false);

    const commit = client.interactionCommit({
      kind: ControlKind.HorizontalPosition,
      value: 2,
    });
    const sentCommit = socket.sent[1];
    expect(sentCommit?.type).toBe(MessageType.InteractionCommit);
    expect(sentCommit !== undefined && "requestId" in sentCommit).toBe(true);
    socket.receive({ type: MessageType.CommandCompleted, requestId: 0 });
    await commit;
  });

  it("does not overlap measurement polls", async () => {
    const specs = [{ channel: Channel.Ch1, kind: MeasurementKind.Vpp }];
    const first = client.pollMeasurementsOnce(specs);
    const second = client.pollMeasurementsOnce(specs);
    expect(socket.sent).toHaveLength(1);
    socket.receive({
      type: MessageType.MeasurementResult,
      requestId: 0,
      values: [{
        channel: Channel.Ch1,
        kind: MeasurementKind.Vpp,
        statistics: {
          current: 2.5,
          minimum: 2.4,
          maximum: 2.6,
          average: 2.51,
          deviation: 0.02,
          count: 12,
        },
      }],
    });
    await Promise.all([first, second]);
    expect(useScopeStore.getState().measurementValues[0]?.statistics.current).toBe(2.5);
  });

  it("retires deep mode immediately when Single starts a new acquisition", async () => {
    controller.setDeepCapture(7);
    useScopeStore.getState().setDeepReady(7, [DEEP_CHANNEL]);

    const command = client.acquisition(AcquisitionAction.Single);
    expect(controller.getDisplayMode()).toBe(WaveformDisplayMode.Live);
    expect(useScopeStore.getState().deepCapture).toEqual({ kind: DeepCaptureKind.None });

    socket.receive({ type: MessageType.CommandCompleted, requestId: 0 });
    await command;
  });

  it("retires deep mode when authoritative scope state resumes", () => {
    socket.receive({
      type: MessageType.ScopeConnected,
      protocolVersion: PROTOCOL_VERSION,
      info: {
        manufacturer: "RIGOL",
        model: "DHO804",
        serialNumber: "test",
        softwareVersion: "1",
      },
      state: scope(ScopeRunState.Stopped),
    });
    controller.setDeepCapture(8);
    useScopeStore.getState().setDeepReady(8, [DEEP_CHANNEL]);

    socket.receive({
      type: MessageType.ScopeState,
      state: scope(ScopeRunState.Running),
    });

    expect(controller.getDisplayMode()).toBe(WaveformDisplayMode.Live);
    expect(useScopeStore.getState().deepCapture).toEqual({ kind: DeepCaptureKind.None });
  });

  it("resets deep session state on scope disconnect", () => {
    controller.setDeepCapture(9);
    useScopeStore.getState().setDeepReady(9, [DEEP_CHANNEL]);

    socket.receive({
      type: MessageType.ScopeDisconnected,
      reason: "scope rebooted",
    });

    expect(controller.getDisplayMode()).toBe(WaveformDisplayMode.Live);
    expect(useScopeStore.getState().deepCapture).toEqual({ kind: DeepCaptureKind.None });
    expect(useScopeStore.getState().connection.kind).toBe(BrowserConnectionKind.ScopeDisconnected);
  });
});
