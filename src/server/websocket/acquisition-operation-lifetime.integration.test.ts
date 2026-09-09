import { once } from "node:events";
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";

import { describe, expect, it } from "vitest";
import { WebSocket, type RawData } from "ws";

import {
  AcquisitionInitiatorKind,
  AcquisitionOperationState,
} from "../../shared/acquisition-types.js";
import { SupportedInstrument } from "../../shared/instrument-types.js";
import {
  MessageType,
  PROTOCOL_VERSION,
  type ServerJsonMessage,
} from "../../shared/websocket-protocol.js";
import { AcquisitionService } from "../acquisition/acquisition-service.js";
import { AcquisitionWebSocketAdapter } from "./acquisition-websocket-adapter.js";
import type {
  WebSocketAdapterHost,
  WebSocketInstrumentAdapter,
  WebSocketSession,
} from "./websocket-adapter.js";
import { WebSocketGateway } from "./websocket-gateway.js";

class NoopInstrumentAdapter implements WebSocketInstrumentAdapter {
  public constructor(public readonly instrument: SupportedInstrument) {}
  public attach(_host: WebSocketAdapterHost): void {}
  public detach(): void {}
  public async tryDispatch(
    _session: WebSocketSession,
    _message: Record<string, unknown>,
  ): Promise<boolean> {
    return false;
  }
  public sendInitialPublications(_session: WebSocketSession): void {}
  public sessionUnsubscribed(_session: WebSocketSession): void {}
  public transportAvailable(_session: WebSocketSession): void {}
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

describe("server-owned acquisition operation lifetime", () => {
  it("keeps a browser-started operation running after its socket disconnects", async () => {
    const httpServer = createServer();
    const acquisitionService = new AcquisitionService({ now: () => 1_800_000_000_000 });
    const gateway = new WebSocketGateway(httpServer, {
      acquisitionAdapter: new AcquisitionWebSocketAdapter(acquisitionService),
      scopeAdapter: new NoopInstrumentAdapter(SupportedInstrument.Dho804),
      dmmAdapter: new NoopInstrumentAdapter(SupportedInstrument.Dm858e),
      ppk2Adapter: new NoopInstrumentAdapter(SupportedInstrument.Ppk2),
    });
    const clients: WebSocket[] = [];
    const port = await listen(httpServer);

    try {
      const first = await connect(port);
      clients.push(first);
      const startResult = waitForJson(
        first,
        (message) => message.type === MessageType.AcquisitionOperationResult && message.requestId === 1,
      );
      first.send(JSON.stringify({
        type: MessageType.AcquisitionOperationStart,
        requestId: 1,
        label: "PPK2 capture",
      }));

      const started = await startResult;
      if (started.type !== MessageType.AcquisitionOperationResult) {
        throw new Error("Expected acquisition operation result");
      }
      const operationId = started.operation.id;
      expect(started.operation).toMatchObject({
        id: operationId,
        label: "PPK2 capture",
        state: AcquisitionOperationState.Running,
        initiator: {
          kind: AcquisitionInitiatorKind.Browser,
          sessionId: 1,
        },
      });

      const closed = once(first, "close");
      first.close();
      await closed;
      expect(acquisitionService.get(operationId).state).toBe(AcquisitionOperationState.Running);

      const second = await connect(port);
      clients.push(second);
      const listResult = waitForJson(
        second,
        (message) => message.type === MessageType.AcquisitionOperationListResult && message.requestId === 2,
      );
      second.send(JSON.stringify({
        type: MessageType.AcquisitionOperationList,
        requestId: 2,
      }));

      const listed = await listResult;
      if (listed.type !== MessageType.AcquisitionOperationListResult) {
        throw new Error("Expected acquisition operation list result");
      }
      expect(listed.operations).toContainEqual(started.operation);

      const stopResult = waitForJson(
        second,
        (message) => message.type === MessageType.AcquisitionOperationResult && message.requestId === 3,
      );
      second.send(JSON.stringify({
        type: MessageType.AcquisitionOperationStop,
        requestId: 3,
        operationId,
      }));
      const stopped = await stopResult;
      if (stopped.type !== MessageType.AcquisitionOperationResult) {
        throw new Error("Expected acquisition operation stop result");
      }
      expect(stopped.operation.state).toBe(AcquisitionOperationState.Stopped);
    } finally {
      for (const client of clients) {
        if (client.readyState === WebSocket.OPEN) client.close();
      }
      await gateway.close();
      acquisitionService.close();
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => error === undefined ? resolve() : reject(error));
      });
    }
  });
});
