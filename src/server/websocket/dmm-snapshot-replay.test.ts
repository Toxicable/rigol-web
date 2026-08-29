import { once } from "node:events";
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";

import { describe, expect, it, vi } from "vitest";
import { WebSocket, type RawData } from "ws";

import {
  DmmAcquisitionRate,
  DmmMeasurementFunction,
  DmmRangeMode,
  DmmReadingKind,
  DmmUnit,
  type DmmInfo,
  type DmmReadingSnapshot,
  type DmmState,
} from "../../shared/dmm-types.js";
import { SupportedInstrument } from "../../shared/instrument-types.js";
import {
  MessageType,
  PROTOCOL_VERSION,
  type ServerJsonMessage,
} from "../../shared/websocket-protocol.js";
import { InstrumentRegistry } from "../instruments/instrument-registry.js";
import {
  ServerDmmConnectionKind,
  ServerScopeConnectionKind,
  WebSocketGateway,
} from "./websocket-gateway.js";

const dmmInfo: DmmInfo = {
  manufacturer: "RIGOL TECHNOLOGIES",
  model: "DM858E",
  serialNumber: "TEST-DMM",
  firmwareVersion: "00.01.00",
};

const dmmState: DmmState = {
  function: DmmMeasurementFunction.DcVoltage,
  range: { mode: DmmRangeMode.Auto },
  acquisitionRate: DmmAcquisitionRate.Slow,
};

const snapshot: DmmReadingSnapshot = {
  kind: DmmReadingKind.Value,
  function: DmmMeasurementFunction.DcVoltage,
  value: 1.234,
  unit: DmmUnit.Volts,
};

function waitForJson(
  socket: WebSocket,
  predicate: (message: ServerJsonMessage) => boolean,
): Promise<ServerJsonMessage> {
  return new Promise((resolve) => {
    const listener = (data: RawData, isBinary: boolean): void => {
      if (isBinary) return;
      const message = JSON.parse(data.toString()) as ServerJsonMessage;
      if (!predicate(message)) return;
      socket.off("message", listener);
      resolve(message);
    };
    socket.on("message", listener);
  });
}

async function listen(server: HttpServer): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return (server.address() as AddressInfo).port;
}

async function connect(port: number): Promise<WebSocket> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const hello = waitForJson(socket, (message) => message.type === MessageType.ProtocolHello);
  await once(socket, "open");
  expect(await hello).toEqual({
    type: MessageType.ProtocolHello,
    protocolVersion: PROTOCOL_VERSION,
  });
  socket.send(JSON.stringify({
    type: MessageType.ProtocolHelloAck,
    protocolVersion: PROTOCOL_VERSION,
  }));
  return socket;
}

class ReplayDmmRuntime {
  public readonly start = vi.fn(async () => {
    this.gateway().setDmmConnection({
      kind: ServerDmmConnectionKind.Connected,
      info: dmmInfo,
      state: dmmState,
    });
  });

  public readonly stop = vi.fn(async () => {
    this.currentSnapshot = null;
    this.gateway().setDmmConnection({
      kind: ServerDmmConnectionKind.Disconnected,
      reason: "DMM inactive",
    });
  });

  public readonly subscriberAdded = vi.fn(async () => {
    if (this.currentSnapshot !== null) {
      this.gateway().broadcastDmmSnapshot(this.currentSnapshot);
    }
  });

  private currentSnapshot: DmmReadingSnapshot | null = null;

  public constructor(private readonly gateway: () => WebSocketGateway) {}

  public publishSnapshot(value: DmmReadingSnapshot): void {
    this.currentSnapshot = value;
    this.gateway().broadcastDmmSnapshot(value);
  }
}

describe("DMM snapshot subscription replay", () => {
  it("replays an unchanged current snapshot to second and reconnecting subscribers", async () => {
    const httpServer = createServer();
    let gateway!: WebSocketGateway;
    const runtime = new ReplayDmmRuntime(() => gateway);
    const registry = new InstrumentRegistry({
      dho804: {
        endpoint: { host: "scope.test", port: 5555 },
        runtime: { start: vi.fn(), stop: vi.fn() },
      },
      dm858e: {
        endpoint: { host: "dmm.test", port: 5556 },
        runtime,
      },
    });

    gateway = new WebSocketGateway(
      httpServer,
      { kind: ServerScopeConnectionKind.Disconnected, reason: "scope unused" },
      {
        instruments: registry,
        initialDmmConnection: {
          kind: ServerDmmConnectionKind.Disconnected,
          reason: "DMM inactive",
        },
        waveformHandlers: {
          requestDeepCapture: async () => {
            throw new Error("unused");
          },
          requestViewport: async () => {
            throw new Error("unused");
          },
        },
        dmmHandlers: {
          setControl: async () => undefined,
          executeRawScpi: async () => "",
        },
      },
    );

    const port = await listen(httpServer);
    const clients: WebSocket[] = [];

    try {
      const first = await connect(port);
      clients.push(first);
      const firstDisconnected = waitForJson(
        first,
        (message) => message.type === MessageType.DmmDisconnected,
      );
      const firstConnected = waitForJson(
        first,
        (message) => message.type === MessageType.DmmConnected,
      );
      first.send(JSON.stringify({
        type: MessageType.InstrumentSubscribe,
        instrument: SupportedInstrument.Dm858e,
      }));
      await firstDisconnected;
      await firstConnected;
      expect(runtime.start).toHaveBeenCalledOnce();

      const firstSnapshot = waitForJson(
        first,
        (message) => message.type === MessageType.DmmSnapshot,
      );
      runtime.publishSnapshot(snapshot);
      expect(await firstSnapshot).toEqual({
        type: MessageType.DmmSnapshot,
        snapshot,
      });

      const second = await connect(port);
      clients.push(second);
      const secondSeen: MessageType[] = [];
      second.on("message", (data, isBinary) => {
        if (isBinary) return;
        const message = JSON.parse(data.toString()) as ServerJsonMessage;
        if (
          message.type === MessageType.DmmConnected ||
          message.type === MessageType.DmmSnapshot
        ) {
          secondSeen.push(message.type);
        }
      });
      const secondConnected = waitForJson(
        second,
        (message) => message.type === MessageType.DmmConnected,
      );
      const secondSnapshot = waitForJson(
        second,
        (message) => message.type === MessageType.DmmSnapshot,
      );
      second.send(JSON.stringify({
        type: MessageType.InstrumentSubscribe,
        instrument: SupportedInstrument.Dm858e,
      }));
      await secondConnected;
      expect(await secondSnapshot).toEqual({
        type: MessageType.DmmSnapshot,
        snapshot,
      });
      expect(secondSeen.slice(0, 2)).toEqual([
        MessageType.DmmConnected,
        MessageType.DmmSnapshot,
      ]);
      expect(runtime.start).toHaveBeenCalledOnce();

      const secondClosed = once(second, "close");
      second.close();
      await secondClosed;
      expect(runtime.stop).not.toHaveBeenCalled();

      const reconnect = await connect(port);
      clients.push(reconnect);
      const reconnectConnected = waitForJson(
        reconnect,
        (message) => message.type === MessageType.DmmConnected,
      );
      const reconnectSnapshot = waitForJson(
        reconnect,
        (message) => message.type === MessageType.DmmSnapshot,
      );
      reconnect.send(JSON.stringify({
        type: MessageType.InstrumentSubscribe,
        instrument: SupportedInstrument.Dm858e,
      }));
      await reconnectConnected;
      expect(await reconnectSnapshot).toEqual({
        type: MessageType.DmmSnapshot,
        snapshot,
      });
      expect(runtime.start).toHaveBeenCalledOnce();
    } finally {
      for (const client of clients) {
        if (client.readyState === WebSocket.OPEN) {
          client.close();
        }
      }
      await gateway.close();
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => error === undefined ? resolve() : reject(error));
      });
    }
  });
});
