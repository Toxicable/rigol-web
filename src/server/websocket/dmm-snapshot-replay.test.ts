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
  DmmReadingUnavailableReason,
  DmmUnit,
  dmmUnitForFunction,
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
  resolution: 1e-5,
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
      state: this.currentState,
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

  private currentState: DmmState = dmmState;
  private currentSnapshot: DmmReadingSnapshot | null = null;

  public constructor(private readonly gateway: () => WebSocketGateway) {}

  public publishSnapshot(value: DmmReadingSnapshot): void {
    this.currentSnapshot = value;
    this.gateway().broadcastDmmSnapshot(value);
  }

  public publishState(state: DmmState): void {
    this.currentState = state;
    let invalidated: DmmReadingSnapshot | null = null;
    if (this.currentSnapshot !== null) {
      invalidated = {
        kind: DmmReadingKind.Unavailable,
        function: state.function,
        unit: dmmUnitForFunction(state.function),
        reason: DmmReadingUnavailableReason.ConfigurationChanged,
      };
      this.currentSnapshot = invalidated;
    }

    this.gateway().publishDmmState(state);
    if (invalidated !== null) {
      this.gateway().broadcastDmmSnapshot(invalidated);
    }
  }
}

function createRegistry(runtime: ReplayDmmRuntime): InstrumentRegistry {
  return new InstrumentRegistry({
    dho804: {
      endpoint: { host: "scope.test", port: 5555 },
      runtime: { start: vi.fn(), stop: vi.fn() },
    },
    dm858e: {
      endpoint: { host: "dmm.test", port: 5556 },
      runtime,
    },
  });
}

function createGateway(server: HttpServer, registry: InstrumentRegistry): WebSocketGateway {
  return new WebSocketGateway(
    server,
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
}

async function closeHarness(
  clients: WebSocket[],
  gateway: WebSocketGateway,
  httpServer: HttpServer,
): Promise<void> {
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

describe("DMM snapshot subscription replay", () => {
  it("replays an unchanged current snapshot to second and reconnecting subscribers", async () => {
    const httpServer = createServer();
    let gateway!: WebSocketGateway;
    const runtime = new ReplayDmmRuntime(() => gateway);
    const registry = createRegistry(runtime);
    gateway = createGateway(httpServer, registry);

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
      await closeHarness(clients, gateway, httpServer);
    }
  });

  it("never replays a pre-change numeric snapshot after same-function state changes", async () => {
    const httpServer = createServer();
    let gateway!: WebSocketGateway;
    const runtime = new ReplayDmmRuntime(() => gateway);
    const registry = createRegistry(runtime);
    gateway = createGateway(httpServer, registry);

    const port = await listen(httpServer);
    const clients: WebSocket[] = [];

    try {
      const first = await connect(port);
      clients.push(first);
      const firstConnected = waitForJson(
        first,
        (message) => message.type === MessageType.DmmConnected,
      );
      first.send(JSON.stringify({
        type: MessageType.InstrumentSubscribe,
        instrument: SupportedInstrument.Dm858e,
      }));
      await firstConnected;

      const firstValue = waitForJson(
        first,
        (message) => message.type === MessageType.DmmSnapshot,
      );
      runtime.publishSnapshot(snapshot);
      expect(await firstValue).toEqual({
        type: MessageType.DmmSnapshot,
        snapshot,
      });

      const changedState: DmmState = {
        ...dmmState,
        range: { mode: DmmRangeMode.Fixed, value: 10 },
      };
      const invalidated: DmmReadingSnapshot = {
        kind: DmmReadingKind.Unavailable,
        function: DmmMeasurementFunction.DcVoltage,
        unit: DmmUnit.Volts,
        reason: DmmReadingUnavailableReason.ConfigurationChanged,
      };
      const firstState = waitForJson(
        first,
        (message) => message.type === MessageType.DmmState,
      );
      const firstInvalidated = waitForJson(
        first,
        (message) => message.type === MessageType.DmmSnapshot,
      );
      runtime.publishState(changedState);
      expect(await firstState).toEqual({ type: MessageType.DmmState, state: changedState });
      expect(await firstInvalidated).toEqual({
        type: MessageType.DmmSnapshot,
        snapshot: invalidated,
      });

      const second = await connect(port);
      clients.push(second);
      const firstReplay = waitForJson(
        first,
        (message) => message.type === MessageType.DmmSnapshot,
      );
      const secondConnected = waitForJson(
        second,
        (message) => message.type === MessageType.DmmConnected,
      );
      const secondReplay = waitForJson(
        second,
        (message) => message.type === MessageType.DmmSnapshot,
      );
      second.send(JSON.stringify({
        type: MessageType.InstrumentSubscribe,
        instrument: SupportedInstrument.Dm858e,
      }));

      expect(await secondConnected).toEqual({
        type: MessageType.DmmConnected,
        protocolVersion: PROTOCOL_VERSION,
        info: dmmInfo,
        state: changedState,
      });
      expect(await secondReplay).toEqual({
        type: MessageType.DmmSnapshot,
        snapshot: invalidated,
      });
      expect(await firstReplay).toEqual({
        type: MessageType.DmmSnapshot,
        snapshot: invalidated,
      });
    } finally {
      await closeHarness(clients, gateway, httpServer);
    }
  });
});
