import { once } from "node:events";
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket, type RawData } from "ws";

import { SupportedInstrument } from "../../shared/instrument-types.js";
import {
  MessageType,
  PROTOCOL_VERSION,
  type ServerJsonMessage,
} from "../../shared/websocket-protocol.js";
import type {
  WebSocketAdapterHost,
  WebSocketInstrumentAdapter,
  WebSocketSession,
} from "./websocket-adapter.js";
import { WebSocketGateway } from "./websocket-gateway.js";

const TEST_ADAPTER_MESSAGE = 999;

class FakeAdapter implements WebSocketInstrumentAdapter {
  private host: WebSocketAdapterHost | null = null;

  public readonly attachSpy = vi.fn();
  public readonly detachSpy = vi.fn();
  public readonly tryDispatchSpy = vi.fn();
  public readonly initialPublicationsSpy = vi.fn();
  public readonly unsubscribedSpy = vi.fn();
  public readonly transportAvailableSpy = vi.fn();

  public constructor(public readonly instrument: SupportedInstrument) {}

  public attach(host: WebSocketAdapterHost): void {
    this.host = host;
    this.attachSpy(host);
  }

  public detach(): void {
    this.detachSpy();
    this.host = null;
  }

  public async tryDispatch(
    session: WebSocketSession,
    message: Record<string, unknown>,
  ): Promise<boolean> {
    this.tryDispatchSpy(session, message);
    if (message.type !== TEST_ADAPTER_MESSAGE) {
      return false;
    }
    if (!Number.isInteger(message.requestId)) {
      throw new Error("test requestId missing");
    }
    this.requireHost().sendCompleted(session, message.requestId as number);
    return true;
  }

  public sendInitialPublications(session: WebSocketSession): void {
    this.initialPublicationsSpy(session);
    if (this.instrument === SupportedInstrument.Dho804) {
      this.requireHost().sendJson(session, {
        type: MessageType.ScopeDisconnected,
        reason: "test lifecycle",
      });
      return;
    }
    this.requireHost().sendJson(session, {
      type: MessageType.DmmDisconnected,
      reason: "test lifecycle",
    });
  }

  public sessionUnsubscribed(session: WebSocketSession): void {
    this.unsubscribedSpy(session);
  }

  public transportAvailable(session: WebSocketSession): void {
    this.transportAvailableSpy(session);
  }

  private requireHost(): WebSocketAdapterHost {
    if (this.host === null) {
      throw new Error("Fake adapter not attached");
    }
    return this.host;
  }
}

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
  httpServer: HttpServer;
  gateway: WebSocketGateway;
  scopeAdapter: FakeAdapter;
  dmmAdapter: FakeAdapter;
  clients: WebSocket[];
  port: number;
}

let active: Harness | undefined;

afterEach(async () => {
  if (active === undefined) return;
  for (const client of active.clients) {
    if (client.readyState === WebSocket.OPEN) client.close();
  }
  await active.gateway.close();
  await new Promise<void>((resolve, reject) => {
    active?.httpServer.close((error) => error === undefined ? resolve() : reject(error));
  });
  active = undefined;
});

async function createHarness(): Promise<Harness> {
  const httpServer = createServer();
  const scopeAdapter = new FakeAdapter(SupportedInstrument.Dho804);
  const dmmAdapter = new FakeAdapter(SupportedInstrument.Dm858e);
  const gateway = new WebSocketGateway(httpServer, {
    scopeAdapter,
    dmmAdapter,
  });
  const port = await listen(httpServer);
  active = {
    httpServer,
    gateway,
    scopeAdapter,
    dmmAdapter,
    clients: [],
    port,
  };
  return active;
}

async function connect(server: Harness): Promise<WebSocket> {
  const client = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
  server.clients.push(client);
  const hello = waitForJson(client, (message) => message.type === MessageType.ProtocolHello);
  await once(client, "open");
  expect(await hello).toEqual({
    type: MessageType.ProtocolHello,
    protocolVersion: PROTOCOL_VERSION,
  });
  client.send(JSON.stringify({
    type: MessageType.ProtocolHelloAck,
    protocolVersion: PROTOCOL_VERSION,
  }));
  return client;
}

async function subscribeScope(client: WebSocket): Promise<void> {
  const lifecycle = waitForJson(
    client,
    (message) => message.type === MessageType.ScopeDisconnected,
  );
  client.send(JSON.stringify({
    type: MessageType.InstrumentSubscribe,
    instrument: SupportedInstrument.Dho804,
  }));
  await lifecycle;
}

describe("WebSocketGateway broker", () => {
  it("requires the protocol handshake before application messages", async () => {
    const server = await createHarness();
    const client = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
    server.clients.push(client);
    await once(client, "open");
    const closed = once(client, "close");

    client.send(JSON.stringify({
      type: MessageType.InstrumentSubscribe,
      instrument: SupportedInstrument.Dho804,
    }));

    const [code] = await closed;
    expect(code).toBe(1002);
    expect(server.scopeAdapter.initialPublicationsSpy).not.toHaveBeenCalled();
  });

  it("rejects protocol version mismatch before adapter dispatch", async () => {
    const server = await createHarness();
    const client = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
    server.clients.push(client);
    await once(client, "open");
    const closed = once(client, "close");

    client.send(JSON.stringify({
      type: MessageType.ProtocolHelloAck,
      protocolVersion: PROTOCOL_VERSION + 1,
    }));

    const [code] = await closed;
    expect(code).toBe(1002);
    expect(server.scopeAdapter.tryDispatchSpy).not.toHaveBeenCalled();
    expect(server.dmmAdapter.tryDispatchSpy).not.toHaveBeenCalled();
  });

  it("treats subscribe and unsubscribe as publication state only", async () => {
    const server = await createHarness();
    const first = await connect(server);
    const second = await connect(server);

    await subscribeScope(first);
    await subscribeScope(second);
    expect(server.scopeAdapter.initialPublicationsSpy).toHaveBeenCalledTimes(2);

    first.send(JSON.stringify({
      type: MessageType.InstrumentUnsubscribe,
      instrument: SupportedInstrument.Dho804,
    }));
    second.send(JSON.stringify({
      type: MessageType.InstrumentUnsubscribe,
      instrument: SupportedInstrument.Dho804,
    }));

    await vi.waitFor(() => {
      expect(server.scopeAdapter.unsubscribedSpy).toHaveBeenCalledTimes(2);
    });
  });

  it("delegates non-common messages to adapters and owns result framing", async () => {
    const server = await createHarness();
    const client = await connect(server);
    await subscribeScope(client);
    const completed = waitForJson(
      client,
      (message) => message.type === MessageType.CommandCompleted && message.requestId === 7,
    );

    client.send(JSON.stringify({ type: TEST_ADAPTER_MESSAGE, requestId: 7 }));

    expect(await completed).toEqual({
      type: MessageType.CommandCompleted,
      requestId: 7,
    });
    expect(server.scopeAdapter.tryDispatchSpy).toHaveBeenCalledOnce();
    expect(server.dmmAdapter.tryDispatchSpy).not.toHaveBeenCalled();
  });

  it("returns common command failure when no adapter claims a request", async () => {
    const server = await createHarness();
    const client = await connect(server);
    const failed = waitForJson(
      client,
      (message) => message.type === MessageType.CommandFailed && message.requestId === 8,
    );

    client.send(JSON.stringify({ type: 998, requestId: 8 }));

    expect(await failed).toEqual({
      type: MessageType.CommandFailed,
      requestId: 8,
      error: "Unknown client message type",
    });
    expect(server.scopeAdapter.tryDispatchSpy).toHaveBeenCalledOnce();
    expect(server.dmmAdapter.tryDispatchSpy).toHaveBeenCalledOnce();
  });

  it("releases only adapter publication/session state on socket close", async () => {
    const server = await createHarness();
    const client = await connect(server);
    await subscribeScope(client);
    const closed = once(client, "close");

    client.close();
    await closed;

    expect(server.scopeAdapter.unsubscribedSpy).toHaveBeenCalledOnce();
  });
});
