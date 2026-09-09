import { Buffer } from "node:buffer";
import type { Server as HttpServer } from "node:http";

import {
  WebSocket,
  WebSocketServer,
  type RawData,
} from "ws";

import { SupportedInstrument } from "../../shared/instrument-types.js";
import {
  MessageType,
  PROTOCOL_VERSION,
  type ServerJsonMessage,
} from "../../shared/websocket-protocol.js";
import type {
  BinarySendCallback,
  WebSocketAdapterHost,
  WebSocketApplicationAdapter,
  WebSocketInstrumentAdapter,
  WebSocketSession,
} from "./websocket-adapter.js";
import {
  isRecord,
  readInstrument,
  readPositiveInteger,
  tryReadRequestId,
} from "./websocket-validation.js";

const MAX_BUFFERED_BYTES = 256 * 1024;

export interface WebSocketGatewayOptions {
  acquisitionAdapter: WebSocketApplicationAdapter;
  scopeAdapter: WebSocketInstrumentAdapter;
  dmmAdapter: WebSocketInstrumentAdapter;
  ppk2Adapter: WebSocketInstrumentAdapter;
}

interface ClientState extends WebSocketSession {
  socket: WebSocket;
  protocolReady: boolean;
  subscriptions: Set<SupportedInstrument>;
}

type CommonClientMessage =
  | {
      type: MessageType.ProtocolHelloAck;
      protocolVersion: number;
    }
  | {
      type: MessageType.InstrumentSubscribe;
      instrument: SupportedInstrument;
    }
  | {
      type: MessageType.InstrumentUnsubscribe;
      instrument: SupportedInstrument;
    };

function readCommonClientMessage(value: unknown): CommonClientMessage | null {
  if (!isRecord(value)) {
    throw new Error("Message must be an object");
  }

  switch (value.type) {
    case MessageType.ProtocolHelloAck:
      return {
        type: MessageType.ProtocolHelloAck,
        protocolVersion: readPositiveInteger(value.protocolVersion, "protocolVersion"),
      };
    case MessageType.InstrumentSubscribe:
      return {
        type: MessageType.InstrumentSubscribe,
        instrument: readInstrument(value.instrument),
      };
    case MessageType.InstrumentUnsubscribe:
      return {
        type: MessageType.InstrumentUnsubscribe,
        instrument: readInstrument(value.instrument),
      };
    default:
      return null;
  }
}

function rawDataToText(data: RawData): string {
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }

  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }

  return data.toString("utf8");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Common WebSocket session/protocol broker.
 *
 * Browser subscriptions control publication/fanout only. Physical instrument
 * and acquisition-operation lifetimes are server-owned and do not depend on
 * browser sessions.
 */
export class WebSocketGateway implements WebSocketAdapterHost {
  private readonly webSocketServer: WebSocketServer;
  private readonly clients = new Map<WebSocket, ClientState>();
  private readonly acquisitionAdapter: WebSocketApplicationAdapter;
  private readonly adapters: readonly WebSocketInstrumentAdapter[];
  private readonly adaptersByInstrument: ReadonlyMap<
    SupportedInstrument,
    WebSocketInstrumentAdapter
  >;
  private nextClientId = 1;

  public constructor(
    server: HttpServer,
    options: WebSocketGatewayOptions,
  ) {
    requireAdapterInstrument(
      options.scopeAdapter,
      SupportedInstrument.Dho804,
      "scopeAdapter",
    );
    requireAdapterInstrument(
      options.dmmAdapter,
      SupportedInstrument.Dm858e,
      "dmmAdapter",
    );
    requireAdapterInstrument(
      options.ppk2Adapter,
      SupportedInstrument.Ppk2,
      "ppk2Adapter",
    );
    this.acquisitionAdapter = options.acquisitionAdapter;
    this.adapters = [options.scopeAdapter, options.dmmAdapter, options.ppk2Adapter];
    this.adaptersByInstrument = new Map<
      SupportedInstrument,
      WebSocketInstrumentAdapter
    >([
      [SupportedInstrument.Dho804, options.scopeAdapter],
      [SupportedInstrument.Dm858e, options.dmmAdapter],
      [SupportedInstrument.Ppk2, options.ppk2Adapter],
    ]);

    this.acquisitionAdapter.attach(this);
    for (const adapter of this.adapters) {
      adapter.attach(this);
    }

    this.webSocketServer = new WebSocketServer({
      server,
      path: "/ws",
      perMessageDeflate: false,
    });
    this.webSocketServer.on("connection", (socket) => {
      this.acceptClient(socket);
    });
  }

  public async close(): Promise<void> {
    for (const client of this.clients.values()) {
      this.releaseClientSubscriptions(client);
      client.socket.close(1001, "Server shutting down");
    }

    this.acquisitionAdapter.detach();
    for (const adapter of this.adapters) {
      adapter.detach();
    }

    await new Promise<void>((resolve, reject) => {
      this.webSocketServer.close((error) => {
        if (error === undefined) {
          resolve();
          return;
        }
        reject(error);
      });
    });
  }

  public requireSubscribed(
    session: WebSocketSession,
    instrument: SupportedInstrument,
  ): void {
    const client = this.client(session);
    if (client.subscriptions.has(instrument)) {
      return;
    }

    throw new Error(`Browser session is not subscribed to ${instrumentName(instrument)}`);
  }

  public isOpen(session: WebSocketSession): boolean {
    return this.client(session).socket.readyState === WebSocket.OPEN;
  }

  public isBackpressured(session: WebSocketSession): boolean {
    return this.client(session).socket.bufferedAmount > MAX_BUFFERED_BYTES;
  }

  public sendJson(session: WebSocketSession, message: ServerJsonMessage): void {
    const client = this.client(session);
    if (client.socket.readyState !== WebSocket.OPEN) {
      return;
    }

    client.socket.send(JSON.stringify(message), { compress: false }, (error) => {
      if (error !== undefined && error !== null) {
        console.error("WebSocket JSON send failed", {
          clientId: client.id,
          readyState: client.socket.readyState,
          bufferedBytes: client.socket.bufferedAmount,
          messageType: message.type,
          error,
        });
      }
      this.notifyTransportAvailable(client);
    });
  }

  public sendBinary(
    session: WebSocketSession,
    frame: Uint8Array,
    callback?: BinarySendCallback,
  ): void {
    const client = this.client(session);
    if (client.socket.readyState !== WebSocket.OPEN) {
      callback?.(new Error("WebSocket is not open"));
      return;
    }

    client.socket.send(
      frame,
      { binary: true, compress: false },
      (error) => {
        const normalized = error ?? undefined;
        if (normalized !== undefined) {
          console.error("WebSocket binary send failed", {
            clientId: client.id,
            readyState: client.socket.readyState,
            bufferedBytes: client.socket.bufferedAmount,
            frameBytes: frame.byteLength,
            error: normalized,
          });
        }
        callback?.(normalized);
        this.notifyTransportAvailable(client);
      },
    );
  }

  public sendCompleted(session: WebSocketSession, requestId: number): void {
    this.sendJson(session, { type: MessageType.CommandCompleted, requestId });
  }

  public sendFailure(
    session: WebSocketSession,
    requestId: number,
    error: unknown,
  ): void {
    this.sendJson(session, {
      type: MessageType.CommandFailed,
      requestId,
      error: errorMessage(error),
    });
  }

  public broadcastJson(
    instrument: SupportedInstrument,
    message: ServerJsonMessage,
  ): void {
    this.forEachSubscribed(instrument, (session) => {
      this.sendJson(session, message);
    });
  }

  public forEachSubscribed(
    instrument: SupportedInstrument,
    callback: (session: WebSocketSession) => void,
  ): void {
    for (const client of this.clients.values()) {
      if (client.protocolReady && client.subscriptions.has(instrument)) {
        callback(client);
      }
    }
  }

  private acceptClient(socket: WebSocket): void {
    const client: ClientState = {
      id: this.nextClientId++,
      socket,
      protocolReady: false,
      subscriptions: new Set(),
    };
    this.clients.set(socket, client);

    socket.on("message", (data, isBinary) => {
      this.receiveClientMessage(client, data, isBinary);
    });

    socket.on("close", (code, reason) => {
      console.info("WebSocket client closed", {
        clientId: client.id,
        code,
        reason: reason.toString("utf8"),
        bufferedBytes: socket.bufferedAmount,
      });
      this.releaseClientSubscriptions(client);
      this.clients.delete(socket);
    });

    socket.on("error", (error) => {
      console.error("WebSocket client error", {
        clientId: client.id,
        readyState: socket.readyState,
        bufferedBytes: socket.bufferedAmount,
        error,
      });
    });

    this.sendJson(client, {
      type: MessageType.ProtocolHello,
      protocolVersion: PROTOCOL_VERSION,
    });
  }

  private receiveClientMessage(
    client: ClientState,
    data: RawData,
    isBinary: boolean,
  ): void {
    if (isBinary) {
      client.socket.close(1003, "Client binary messages are not supported");
      return;
    }

    let rawMessage: unknown;
    try {
      rawMessage = JSON.parse(rawDataToText(data));
    } catch {
      client.socket.close(1008, "Malformed JSON message");
      return;
    }

    let commonMessage: CommonClientMessage | null;
    try {
      commonMessage = readCommonClientMessage(rawMessage);
    } catch (error) {
      const requestId = tryReadRequestId(rawMessage);
      if (requestId === undefined) {
        client.socket.close(1008, "Invalid client message");
      } else {
        this.sendFailure(client, requestId, error);
      }
      return;
    }

    if (commonMessage?.type === MessageType.ProtocolHelloAck) {
      this.acceptProtocolHello(client, commonMessage.protocolVersion);
      return;
    }

    if (!client.protocolReady) {
      client.socket.close(1002, "Protocol handshake required");
      return;
    }

    if (!isRecord(rawMessage)) {
      client.socket.close(1008, "Invalid client message");
      return;
    }

    void this.dispatchClientMessage(client, rawMessage, commonMessage);
  }

  private acceptProtocolHello(client: ClientState, protocolVersion: number): void {
    if (protocolVersion !== PROTOCOL_VERSION) {
      client.socket.close(
        1002,
        `Protocol version mismatch: server ${PROTOCOL_VERSION}, browser ${protocolVersion}`,
      );
      return;
    }
    client.protocolReady = true;
  }

  private async dispatchClientMessage(
    client: ClientState,
    rawMessage: Record<string, unknown>,
    commonMessage: CommonClientMessage | null,
  ): Promise<void> {
    try {
      if (commonMessage !== null) {
        switch (commonMessage.type) {
          case MessageType.InstrumentSubscribe:
            this.subscribeClient(client, commonMessage.instrument);
            return;
          case MessageType.InstrumentUnsubscribe:
            this.unsubscribeClient(client, commonMessage.instrument);
            return;
          case MessageType.ProtocolHelloAck:
            return;
        }
      }

      if (await this.acquisitionAdapter.tryDispatch(client, rawMessage)) {
        return;
      }
      for (const adapter of this.adapters) {
        if (await adapter.tryDispatch(client, rawMessage)) {
          return;
        }
      }
      throw new Error("Unknown client message type");
    } catch (error) {
      const requestId = tryReadRequestId(rawMessage);
      if (requestId === undefined) {
        client.socket.close(1011, "WebSocket request failed");
        return;
      }
      this.sendFailure(client, requestId, error);
    }
  }

  private subscribeClient(
    client: ClientState,
    instrument: SupportedInstrument,
  ): void {
    if (client.subscriptions.has(instrument)) {
      return;
    }

    client.subscriptions.add(instrument);
    try {
      this.adapterForInstrument(instrument).sendInitialPublications(client);
    } catch (error) {
      client.subscriptions.delete(instrument);
      this.adapterForInstrument(instrument).sessionUnsubscribed(client);
      throw error;
    }
  }

  private unsubscribeClient(
    client: ClientState,
    instrument: SupportedInstrument,
  ): void {
    if (!client.subscriptions.delete(instrument)) {
      return;
    }

    this.adapterForInstrument(instrument).sessionUnsubscribed(client);
  }

  private releaseClientSubscriptions(client: ClientState): void {
    for (const instrument of client.subscriptions) {
      this.adapterForInstrument(instrument).sessionUnsubscribed(client);
    }
    client.subscriptions.clear();
  }

  private adapterForInstrument(
    instrument: SupportedInstrument,
  ): WebSocketInstrumentAdapter {
    const adapter = this.adaptersByInstrument.get(instrument);
    if (adapter === undefined) {
      throw new Error(`Unsupported instrument ${instrument}`);
    }
    return adapter;
  }

  private notifyTransportAvailable(client: ClientState): void {
    for (const adapter of this.adapters) {
      adapter.transportAvailable(client);
    }
  }

  private client(session: WebSocketSession): ClientState {
    return session as ClientState;
  }
}

function requireAdapterInstrument(
  adapter: WebSocketInstrumentAdapter,
  expected: SupportedInstrument,
  name: string,
): void {
  if (adapter.instrument !== expected) {
    throw new Error(`${name} does not target the expected instrument`);
  }
}

function instrumentName(instrument: SupportedInstrument): string {
  switch (instrument) {
    case SupportedInstrument.Dho804:
      return "DHO804";
    case SupportedInstrument.Dm858e:
      return "DM858E";
    case SupportedInstrument.Ppk2:
      return "PPK2";
  }
}
