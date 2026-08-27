import { describe, expect, it, vi } from "vitest";

import { SupportedInstrument } from "../shared/instrument-types.js";
import { MessageType, type ClientMessage } from "../shared/websocket-protocol.js";
import { ScopeWebSocketClient, type WebSocketLike } from "./websocket-client.js";
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

function createClient(socket: FakeSocket): ScopeWebSocketClient {
  const waveforms = new WaveformController(() => 0);
  const client = new ScopeWebSocketClient(waveforms, () => socket, () => "ws://test/ws");
  client.connect();
  return client;
}

describe("browser instrument subscriptions", () => {
  it("subscribes and unsubscribes each route idempotently", () => {
    const socket = new FakeSocket();
    const client = createClient(socket);

    client.subscribeInstrument(SupportedInstrument.Dho804);
    client.subscribeInstrument(SupportedInstrument.Dho804);
    client.unsubscribeInstrument(SupportedInstrument.Dho804);
    client.unsubscribeInstrument(SupportedInstrument.Dho804);

    expect(socket.sent).toEqual([
      { type: MessageType.InstrumentSubscribe, instrument: SupportedInstrument.Dho804 },
      { type: MessageType.InstrumentUnsubscribe, instrument: SupportedInstrument.Dho804 },
    ]);
  });

  it("sends desired subscriptions when the WebSocket opens", () => {
    const socket = new FakeSocket();
    socket.readyState = 0;
    const client = createClient(socket);

    client.subscribeInstrument(SupportedInstrument.Dm858e);
    expect(socket.sent).toEqual([]);

    socket.readyState = 1;
    socket.onopen?.();
    expect(socket.sent).toEqual([
      { type: MessageType.InstrumentSubscribe, instrument: SupportedInstrument.Dm858e },
    ]);
  });

  it("targets raw SCPI at the selected instrument", async () => {
    const socket = new FakeSocket();
    const client = createClient(socket);

    const result = client.executeScpi("*IDN?", SupportedInstrument.Dm858e);
    expect(socket.sent[0]).toEqual({
      type: MessageType.ScpiExecute,
      requestId: 0,
      instrument: SupportedInstrument.Dm858e,
      command: "*IDN?",
    });
    socket.receive({ type: MessageType.ScpiResult, requestId: 0, response: "RIGOL,DM858E" });
    await expect(result).resolves.toBe("RIGOL,DM858E");
  });

  it("delivers DMM lifecycle messages through the shared client boundary", () => {
    const socket = new FakeSocket();
    const client = createClient(socket);
    const listener = vi.fn();
    client.onDmmMessage(listener);

    socket.receive({ type: MessageType.DmmDisconnected, reason: "DMM inactive" });

    expect(listener).toHaveBeenCalledWith({
      type: MessageType.DmmDisconnected,
      reason: "DMM inactive",
    });
  });
});
