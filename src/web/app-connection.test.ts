import { beforeEach, describe, expect, it, vi } from "vitest";

import { SupportedInstrument } from "../shared/instrument-types.js";
import { Channel } from "../shared/scope-types.js";
import {
  ControlKind,
  MessageType,
  PROTOCOL_VERSION,
  type ClientMessage,
} from "../shared/websocket-protocol.js";
import { AppConnection, type WebSocketLike } from "./app-connection.js";
import { AppTransportKind, useAppTransportStore } from "./app-transport-store.js";

class FakeSocket implements WebSocketLike {
  public binaryType: BinaryType = "blob";
  public readyState = 1;
  public onopen: (() => void) | null = null;
  public onmessage: ((event: { data: string | ArrayBuffer }) => void) | null = null;
  public onclose: ((event: { reason: string }) => void) | null = null;
  public onerror: (() => void) | null = null;
  public readonly sent: ClientMessage[] = [];
  public closeCode: number | undefined;
  public closeReason: string | undefined;

  public send(data: string): void {
    this.sent.push(JSON.parse(data) as ClientMessage);
  }

  public close(code?: number, reason?: string): void {
    this.closeCode = code;
    this.closeReason = reason;
    this.readyState = 3;
  }

  public receive(message: object): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  public serverClose(reason: string): void {
    this.readyState = 3;
    this.onclose?.({ reason });
  }
}

function hello(socket: FakeSocket): void {
  socket.receive({
    type: MessageType.ProtocolHello,
    protocolVersion: PROTOCOL_VERSION,
  });
}

beforeEach(() => {
  useAppTransportStore.setState({
    transport: { kind: AppTransportKind.Connecting },
  });
  vi.stubGlobal("window", {
    setTimeout: (callback: () => void) => {
      callback();
      return 1;
    },
  });
});

describe("AppConnection", () => {
  it("owns handshake, transport state, and subscription replay", () => {
    const socket = new FakeSocket();
    const connection = new AppConnection(() => socket, () => "ws://test/ws");

    connection.subscribeInstrument(SupportedInstrument.Dho804);
    connection.connect();

    expect(socket.binaryType).toBe("arraybuffer");
    expect(useAppTransportStore.getState().transport.kind).toBe(AppTransportKind.Connecting);
    expect(socket.sent).toEqual([]);

    hello(socket);

    expect(socket.sent).toEqual([
      {
        type: MessageType.ProtocolHelloAck,
        protocolVersion: PROTOCOL_VERSION,
      },
      {
        type: MessageType.InstrumentSubscribe,
        instrument: SupportedInstrument.Dho804,
      },
    ]);
    expect(useAppTransportStore.getState().transport.kind).toBe(AppTransportKind.Connected);

    connection.dispose();
  });

  it("correlates out-of-order request completions with app-wide request IDs", async () => {
    const socket = new FakeSocket();
    const connection = new AppConnection(() => socket, () => "ws://test/ws");
    connection.connect();
    hello(socket);
    socket.sent.length = 0;

    const first = connection.request((requestId) => ({
      type: MessageType.ControlSet,
      requestId,
      control: {
        kind: ControlKind.ChannelEnabled,
        channel: Channel.Ch1,
        value: true,
      },
    }));
    const second = connection.request((requestId) => ({
      type: MessageType.ControlSet,
      requestId,
      control: {
        kind: ControlKind.ChannelEnabled,
        channel: Channel.Ch2,
        value: true,
      },
    }));

    expect(socket.sent.map((message) => "requestId" in message ? message.requestId : null)).toEqual([0, 1]);

    socket.receive({ type: MessageType.CommandCompleted, requestId: 1 });
    socket.receive({ type: MessageType.CommandCompleted, requestId: 0 });

    await expect(first).resolves.toEqual({ type: MessageType.CommandCompleted, requestId: 0 });
    await expect(second).resolves.toEqual({ type: MessageType.CommandCompleted, requestId: 1 });

    connection.dispose();
  });

  it("reconnects and restores desired publication subscriptions", () => {
    const sockets: FakeSocket[] = [];
    const connection = new AppConnection(
      () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      () => "ws://test/ws",
    );

    connection.subscribeInstrument(SupportedInstrument.Dho804);
    connection.subscribeInstrument(SupportedInstrument.Dm858e);
    connection.connect();
    hello(sockets[0]!);

    sockets[0]!.serverClose("network lost");

    expect(sockets).toHaveLength(2);
    expect(useAppTransportStore.getState().transport.kind).toBe(AppTransportKind.Connecting);

    hello(sockets[1]!);
    expect(sockets[1]!.sent).toEqual([
      {
        type: MessageType.ProtocolHelloAck,
        protocolVersion: PROTOCOL_VERSION,
      },
      {
        type: MessageType.InstrumentSubscribe,
        instrument: SupportedInstrument.Dho804,
      },
      {
        type: MessageType.InstrumentSubscribe,
        instrument: SupportedInstrument.Dm858e,
      },
    ]);
    expect(useAppTransportStore.getState().transport.kind).toBe(AppTransportKind.Connected);

    connection.dispose();
  });

  it("rejects a mismatched protocol before publishing connected transport state", () => {
    const socket = new FakeSocket();
    const connection = new AppConnection(() => socket, () => "ws://test/ws");
    connection.connect();

    socket.receive({
      type: MessageType.ProtocolHello,
      protocolVersion: PROTOCOL_VERSION + 1,
    });

    expect(socket.closeCode).toBe(1002);
    expect(socket.closeReason).toContain("Protocol version mismatch");
    expect(useAppTransportStore.getState().transport).toEqual({
      kind: AppTransportKind.Disconnected,
      reason: `Protocol version mismatch: server ${PROTOCOL_VERSION + 1}, browser ${PROTOCOL_VERSION}`,
    });

    connection.dispose();
  });
});
