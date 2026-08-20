import { beforeEach, describe, expect, it } from "vitest";

import { Channel, MeasurementKind } from "../shared/scope-types.js";
import {
  ControlKind,
  MessageType,
  type ClientMessage,
} from "../shared/websocket-protocol.js";
import { BrowserConnectionKind, useScopeStore } from "./scope-store.js";
import {
  ScopeWebSocketClient,
  type WebSocketLike,
} from "./websocket-client.js";
import { WaveformController } from "./waveform/waveform-controller.js";

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

describe("WebSocket client", () => {
  let socket: FakeSocket;
  let client: ScopeWebSocketClient;

  beforeEach(() => {
    socket = new FakeSocket();
    const controller = new WaveformController(() => 0);
    client = new ScopeWebSocketClient(controller, () => socket, () => "ws://test/ws");
    useScopeStore.setState({
      connection: { kind: BrowserConnectionKind.Connecting },
      measurementSpecs: [],
      measurementValues: [],
      lastError: null,
    });
    client.connect();
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
      values: [{ channel: Channel.Ch1, kind: MeasurementKind.Vpp, value: 2.5 }],
    });
    await Promise.all([first, second]);
    expect(useScopeStore.getState().measurementValues[0]?.value).toBe(2.5);
  });
});
