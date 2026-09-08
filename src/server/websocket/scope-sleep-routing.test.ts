import { once } from "node:events";
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket, type RawData } from "ws";

import { SupportedInstrument } from "../../shared/instrument-types.js";
import {
  AcquisitionType,
  Channel,
  ChannelCoupling,
  ChannelUnit,
  EdgeSlope,
  ScopeRunState,
  TimebaseMode,
  TriggerCoupling,
  TriggerSweep,
  TriggerType,
  type ScopeInfo,
  type ScopeState,
} from "../../shared/scope-types.js";
import { MessageType, PROTOCOL_VERSION, type ServerJsonMessage } from "../../shared/websocket-protocol.js";
import type { DmmApplicationService } from "../dmm/dmm-service.js";
import {
  DmmConnectionKind,
  ScopeConnectionKind,
  type ScopeConnection,
} from "../instruments/instrument-connection.js";
import type { ScopeApplicationService } from "../scope/scope-service.js";
import { DmmWebSocketAdapter } from "./dmm-websocket-adapter.js";
import { ScopeWebSocketAdapter } from "./scope-websocket-adapter.js";
import { WebSocketGateway } from "./websocket-gateway.js";

const scopeInfo: ScopeInfo = {
  manufacturer: "RIGOL TECHNOLOGIES",
  model: "DHO804",
  serialNumber: "TEST-SLEEP",
  softwareVersion: "00.01.00",
};

const scopeState: ScopeState = {
  channels: [Channel.Ch1, Channel.Ch2, Channel.Ch3, Channel.Ch4].map((channel) => ({
    channel,
    enabled: channel === Channel.Ch1,
    coupling: ChannelCoupling.Dc,
    unit: ChannelUnit.Volts,
    scale: 1,
    offset: 0,
    probeRatio: 1,
  })) as ScopeState["channels"],
  horizontal: { mode: TimebaseMode.Main, scale: 1e-3, position: 0 },
  acquisition: {
    type: AcquisitionType.Normal,
    averages: 2,
    memoryDepth: 1_000,
    sampleRate: 1_000_000,
  },
  runState: ScopeRunState.Stopped,
  trigger: {
    type: TriggerType.Edge,
    sweep: TriggerSweep.Auto,
    source: Channel.Ch1,
    slope: EdgeSlope.Rising,
    level: 0,
    coupling: TriggerCoupling.Dc,
  },
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

interface Harness {
  server: HttpServer;
  gateway: WebSocketGateway;
  client: WebSocket | null;
  sleep: ReturnType<typeof vi.fn>;
  port: number;
}

let active: Harness | null = null;

afterEach(async () => {
  if (active === null) return;
  if (active.client?.readyState === WebSocket.OPEN) active.client.close();
  await active.gateway.close();
  await new Promise<void>((resolve, reject) => {
    active?.server.close((error) => error === undefined ? resolve() : reject(error));
  });
  active = null;
});

async function createHarness(): Promise<Harness> {
  const server = createServer();
  const sleep = vi.fn(async () => undefined);
  const connection: ScopeConnection = {
    kind: ScopeConnectionKind.Connected,
    info: scopeInfo,
    state: scopeState,
  };
  const scopeService = {
    getConnection: () => connection,
    subscribeConnection: () => () => {},
    subscribeState: () => () => {},
    subscribeWaveform: () => () => {},
    sleep,
  } as unknown as ScopeApplicationService;
  const dmmService = {
    getConnection: () => ({ kind: DmmConnectionKind.Disconnected, reason: "unused" } as const),
    getCurrentSnapshot: () => null,
    subscribeConnection: () => () => {},
    subscribeState: () => () => {},
    subscribeSnapshot: () => () => {},
  } as unknown as DmmApplicationService;
  const gateway = new WebSocketGateway(server, {
    scopeAdapter: new ScopeWebSocketAdapter(scopeService),
    dmmAdapter: new DmmWebSocketAdapter(dmmService),
  });
  const port = await listen(server);
  active = { server, gateway, client: null, sleep, port };
  return active;
}

async function connectAndSubscribe(harness: Harness): Promise<WebSocket> {
  const client = new WebSocket(`ws://127.0.0.1:${harness.port}/ws`);
  harness.client = client;
  const hello = waitForJson(client, (message) => message.type === MessageType.ProtocolHello);
  await once(client, "open");
  expect(await hello).toEqual({ type: MessageType.ProtocolHello, protocolVersion: PROTOCOL_VERSION });
  client.send(JSON.stringify({ type: MessageType.ProtocolHelloAck, protocolVersion: PROTOCOL_VERSION }));
  const connected = waitForJson(client, (message) => message.type === MessageType.ScopeConnected);
  client.send(JSON.stringify({ type: MessageType.InstrumentSubscribe, instrument: SupportedInstrument.Dho804 }));
  await connected;
  return client;
}

describe("scope Sleep WebSocket routing", () => {
  it("routes Sleep through ScopeService and completes the request", async () => {
    const harness = await createHarness();
    const client = await connectAndSubscribe(harness);
    const completed = waitForJson(
      client,
      (message) => message.type === MessageType.CommandCompleted && message.requestId === 7,
    );

    client.send(JSON.stringify({ type: MessageType.ScopeSleep, requestId: 7 }));

    expect(await completed).toEqual({ type: MessageType.CommandCompleted, requestId: 7 });
    expect(harness.sleep).toHaveBeenCalledOnce();
  });

  it("returns a command failure when scope Sleep orchestration fails", async () => {
    const harness = await createHarness();
    harness.sleep.mockRejectedValueOnce(new Error("ADB unavailable"));
    const client = await connectAndSubscribe(harness);
    const failed = waitForJson(
      client,
      (message) => message.type === MessageType.CommandFailed && message.requestId === 8,
    );

    client.send(JSON.stringify({ type: MessageType.ScopeSleep, requestId: 8 }));

    expect(await failed).toEqual({
      type: MessageType.CommandFailed,
      requestId: 8,
      error: "ADB unavailable",
    });
  });
});
