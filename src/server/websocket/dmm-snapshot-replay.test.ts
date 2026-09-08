import { once } from "node:events";
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";

import { describe, expect, it } from "vitest";
import { WebSocket, type RawData } from "ws";

import {
  DmmAcquisitionRate,
  DmmMeasurementFunction,
  DmmRangeMode,
  DmmReadingKind,
  DmmReadingUnavailableReason,
  DmmUnit,
  type DmmInfo,
  type DmmReadingSnapshot,
  type DmmState,
} from "../../shared/dmm-types.js";
import { SupportedInstrument } from "../../shared/instrument-types.js";
import { MessageType, PROTOCOL_VERSION, type ServerJsonMessage } from "../../shared/websocket-protocol.js";
import { DmmService } from "../dmm/dmm-service.js";
import {
  DmmConnectionKind,
  ScopeConnectionKind,
  type DmmConnection,
} from "../instruments/instrument-connection.js";
import type { ScopeApplicationService } from "../scope/scope-service.js";
import { DmmWebSocketAdapter } from "./dmm-websocket-adapter.js";
import { ScopeWebSocketAdapter } from "./scope-websocket-adapter.js";
import { WebSocketGateway } from "./websocket-gateway.js";

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

interface DmmServiceInternals {
  acceptConnection(connection: DmmConnection): void;
  acceptState(state: DmmState): void;
  acceptSnapshot(snapshot: DmmReadingSnapshot): void;
}

class UnusedScopeService implements ScopeApplicationService {
  public getConnection() { return { kind: ScopeConnectionKind.Disconnected, reason: "scope unused" } as const; }
  public subscribeConnection(): () => void { return () => {}; }
  public subscribeState(): () => void { return () => {}; }
  public subscribeWaveform(): () => void { return () => {}; }
  public async setControl(): Promise<void> { throw new Error("unused"); }
  public async updateInteraction(): Promise<void> { throw new Error("unused"); }
  public async commitInteraction(): Promise<void> { throw new Error("unused"); }
  public async performAcquisitionAction(): Promise<void> { throw new Error("unused"); }
  public async sleep(): Promise<void> { throw new Error("unused"); }
  public async readMeasurements(): Promise<never[]> { throw new Error("unused"); }
  public async setMeasurements(): Promise<void> { throw new Error("unused"); }
  public async executeRawScpi(): Promise<string> { throw new Error("unused"); }
  public async captureDeep(): Promise<never> { throw new Error("unused"); }
  public async requestViewport(): Promise<Uint8Array> { throw new Error("unused"); }
  public async pauseLiveWaveform(): Promise<void> {}
  public resumeLiveWaveform(): void {}
}

function waitForJson(socket: WebSocket, predicate: (message: ServerJsonMessage) => boolean): Promise<ServerJsonMessage> {
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
  expect(await hello).toEqual({ type: MessageType.ProtocolHello, protocolVersion: PROTOCOL_VERSION });
  socket.send(JSON.stringify({ type: MessageType.ProtocolHelloAck, protocolVersion: PROTOCOL_VERSION }));
  return socket;
}

async function closeHarness(clients: WebSocket[], gateway: WebSocketGateway, server: HttpServer): Promise<void> {
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) client.close();
  }
  await gateway.close();
  await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
}

function createHarness(server: HttpServer) {
  const service = new DmmService({ host: "dmm.test", port: 5556 });
  const internals = service as unknown as DmmServiceInternals;
  internals.acceptConnection({ kind: DmmConnectionKind.Connected, info: dmmInfo, state: dmmState });
  const gateway = new WebSocketGateway(server, {
    scopeAdapter: new ScopeWebSocketAdapter(new UnusedScopeService()),
    dmmAdapter: new DmmWebSocketAdapter(service),
  });
  return { service, internals, gateway };
}

describe("DMM snapshot publication replay", () => {
  it("replays the current snapshot only to each newly subscribing session", async () => {
    const httpServer = createServer();
    const { internals, gateway } = createHarness(httpServer);
    const port = await listen(httpServer);
    const clients: WebSocket[] = [];

    try {
      const first = await connect(port);
      clients.push(first);
      const firstConnected = waitForJson(first, (message) => message.type === MessageType.DmmConnected);
      first.send(JSON.stringify({ type: MessageType.InstrumentSubscribe, instrument: SupportedInstrument.Dm858e }));
      await firstConnected;

      const firstSnapshot = waitForJson(first, (message) => message.type === MessageType.DmmSnapshot);
      internals.acceptSnapshot(snapshot);
      expect(await firstSnapshot).toEqual({ type: MessageType.DmmSnapshot, snapshot });

      let firstReplayCount = 0;
      const firstListener = (data: RawData, isBinary: boolean): void => {
        if (isBinary) return;
        const message = JSON.parse(data.toString()) as ServerJsonMessage;
        if (message.type === MessageType.DmmSnapshot) firstReplayCount += 1;
      };
      first.on("message", firstListener);

      const second = await connect(port);
      clients.push(second);
      const secondConnected = waitForJson(second, (message) => message.type === MessageType.DmmConnected);
      const secondSnapshot = waitForJson(second, (message) => message.type === MessageType.DmmSnapshot);
      second.send(JSON.stringify({ type: MessageType.InstrumentSubscribe, instrument: SupportedInstrument.Dm858e }));
      await secondConnected;
      expect(await secondSnapshot).toEqual({ type: MessageType.DmmSnapshot, snapshot });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(firstReplayCount).toBe(0);
      first.off("message", firstListener);

      const closed = once(second, "close");
      second.close();
      await closed;

      const reconnect = await connect(port);
      clients.push(reconnect);
      const reconnectConnected = waitForJson(reconnect, (message) => message.type === MessageType.DmmConnected);
      const reconnectSnapshot = waitForJson(reconnect, (message) => message.type === MessageType.DmmSnapshot);
      reconnect.send(JSON.stringify({ type: MessageType.InstrumentSubscribe, instrument: SupportedInstrument.Dm858e }));
      await reconnectConnected;
      expect(await reconnectSnapshot).toEqual({ type: MessageType.DmmSnapshot, snapshot });
    } finally {
      await closeHarness(clients, gateway, httpServer);
    }
  });

  it("replays the current invalidated snapshot after same-function state changes", async () => {
    const httpServer = createServer();
    const { internals, gateway } = createHarness(httpServer);
    const port = await listen(httpServer);
    const clients: WebSocket[] = [];

    try {
      const first = await connect(port);
      clients.push(first);
      const connected = waitForJson(first, (message) => message.type === MessageType.DmmConnected);
      first.send(JSON.stringify({ type: MessageType.InstrumentSubscribe, instrument: SupportedInstrument.Dm858e }));
      await connected;

      const firstValue = waitForJson(first, (message) => message.type === MessageType.DmmSnapshot);
      internals.acceptSnapshot(snapshot);
      await firstValue;

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
      const stateMessage = waitForJson(first, (message) => message.type === MessageType.DmmState);
      const invalidatedMessage = waitForJson(first, (message) => message.type === MessageType.DmmSnapshot);
      internals.acceptState(changedState);
      expect(await stateMessage).toEqual({ type: MessageType.DmmState, state: changedState });
      expect(await invalidatedMessage).toEqual({ type: MessageType.DmmSnapshot, snapshot: invalidated });

      const second = await connect(port);
      clients.push(second);
      const secondConnected = waitForJson(second, (message) => message.type === MessageType.DmmConnected);
      const replay = waitForJson(second, (message) => message.type === MessageType.DmmSnapshot);
      second.send(JSON.stringify({ type: MessageType.InstrumentSubscribe, instrument: SupportedInstrument.Dm858e }));
      expect(await secondConnected).toEqual({
        type: MessageType.DmmConnected,
        protocolVersion: PROTOCOL_VERSION,
        info: dmmInfo,
        state: changedState,
      });
      expect(await replay).toEqual({ type: MessageType.DmmSnapshot, snapshot: invalidated });
    } finally {
      await closeHarness(clients, gateway, httpServer);
    }
  });
});
