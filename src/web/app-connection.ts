import { SupportedInstrument } from "../shared/instrument-types.js";
import {
  MessageType,
  PROTOCOL_VERSION,
  type AcquisitionActionMessage,
  type ClientMessage,
  type CommandFailedMessage,
  type ControlSetMessage,
  type DeepCaptureRequestMessage,
  type DmmControlSetMessage,
  type InstrumentSubscribeMessage,
  type InstrumentUnsubscribeMessage,
  type InteractionCommitMessage,
  type MeasurementReadMessage,
  type MeasurementSetMessage,
  type ProtocolHelloAckMessage,
  type ScopeSleepMessage,
  type ScpiExecuteMessage,
  type ServerJsonMessage,
  type WaveformViewportRequestMessage,
} from "../shared/websocket-protocol.js";
import { useAppTransportStore } from "./app-transport-store.js";

interface SocketMessageEvent {
  data: string | ArrayBuffer;
}

interface SocketCloseEvent {
  reason: string;
}

export interface WebSocketLike {
  binaryType: BinaryType;
  readyState: number;
  onopen: (() => void) | null;
  onmessage: ((event: SocketMessageEvent) => void) | null;
  onclose: ((event: SocketCloseEvent) => void) | null;
  onerror: (() => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

type SocketFactory = (url: string) => WebSocketLike;
type JsonMessageListener = (message: ServerJsonMessage) => void;
type BinaryMessageListener = (data: ArrayBuffer) => void;
type UnhandledFailureListener = (message: CommandFailedMessage) => void;

export type RequestMessage =
  | ControlSetMessage
  | InteractionCommitMessage
  | AcquisitionActionMessage
  | ScopeSleepMessage
  | DeepCaptureRequestMessage
  | ScpiExecuteMessage
  | MeasurementReadMessage
  | MeasurementSetMessage
  | DmmControlSetMessage
  | WaveformViewportRequestMessage;

interface PendingRequest {
  resolve: (message: ServerJsonMessage) => void;
  reject: (error: Error) => void;
}

const OPEN = 1;

function defaultSocketFactory(url: string): WebSocketLike {
  return new WebSocket(url) as WebSocketLike;
}

function websocketUrl(): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/ws`;
}

function asServerMessage(value: unknown): ServerJsonMessage {
  if (typeof value !== "object" || value === null || !("type" in value)) {
    throw new Error("Invalid WebSocket JSON message");
  }

  const type = (value as { type: unknown }).type;
  if (typeof type !== "number") {
    throw new Error("WebSocket message type must be numeric");
  }

  switch (type) {
    case MessageType.ProtocolHello:
    case MessageType.ScopeConnected:
    case MessageType.ScopeState:
    case MessageType.ScopeDisconnected:
    case MessageType.DmmConnected:
    case MessageType.DmmState:
    case MessageType.DmmDisconnected:
    case MessageType.DmmSnapshot:
    case MessageType.CommandCompleted:
    case MessageType.CommandFailed:
    case MessageType.ScpiResult:
    case MessageType.MeasurementResult:
    case MessageType.DeepCaptureReady:
      return value as ServerJsonMessage;
    default:
      throw new Error(`Unsupported server message type ${type}`);
  }
}

export class AppConnection {
  private socket: WebSocketLike | null = null;
  private requestId = 0;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly subscriptions = new Set<SupportedInstrument>();
  private readonly jsonListeners = new Set<JsonMessageListener>();
  private readonly binaryListeners = new Set<BinaryMessageListener>();
  private readonly unhandledFailureListeners = new Set<UnhandledFailureListener>();
  private disposed = false;
  private protocolReady = false;

  public constructor(
    private readonly socketFactory: SocketFactory = defaultSocketFactory,
    private readonly urlFactory: () => string = websocketUrl,
  ) {}

  public connect(): void {
    this.disposed = false;
    this.protocolReady = false;
    useAppTransportStore.getState().setConnecting();

    const socket = this.socketFactory(this.urlFactory());
    socket.binaryType = "arraybuffer";
    socket.onopen = () => {};
    socket.onmessage = (event) => this.handleMessage(event.data);
    socket.onerror = () => {
      useAppTransportStore.getState().setDisconnected("WebSocket transport error");
    };
    socket.onclose = (event) => {
      if (this.socket !== socket) {
        return;
      }
      this.socket = null;
      this.protocolReady = false;
      const reason = event.reason || "WebSocket disconnected";
      useAppTransportStore.getState().setDisconnected(reason);
      this.rejectPending(new Error(reason));
      if (!this.disposed) {
        window.setTimeout(() => this.connect(), 500);
      }
    };
    this.socket = socket;
  }

  public dispose(): void {
    this.disposed = true;
    this.protocolReady = false;
    this.subscriptions.clear();
    this.jsonListeners.clear();
    this.binaryListeners.clear();
    this.unhandledFailureListeners.clear();
    this.socket?.close(1000, "Client disposed");
    this.socket = null;
    this.rejectPending(new Error("WebSocket client disposed"));
  }

  public subscribeInstrument(instrument: SupportedInstrument): void {
    if (this.subscriptions.has(instrument)) {
      return;
    }
    this.subscriptions.add(instrument);
    if (this.socket?.readyState === OPEN && this.protocolReady) {
      this.sendInstrumentSubscribe(instrument);
    }
  }

  public unsubscribeInstrument(instrument: SupportedInstrument): void {
    if (!this.subscriptions.delete(instrument)) {
      return;
    }
    if (this.socket?.readyState === OPEN && this.protocolReady) {
      const message: InstrumentUnsubscribeMessage = {
        type: MessageType.InstrumentUnsubscribe,
        instrument,
      };
      this.send(message);
    }
  }

  public onJsonMessage(listener: JsonMessageListener): () => void {
    this.jsonListeners.add(listener);
    return () => this.jsonListeners.delete(listener);
  }

  public onBinaryMessage(listener: BinaryMessageListener): () => void {
    this.binaryListeners.add(listener);
    return () => this.binaryListeners.delete(listener);
  }

  public onUnhandledFailure(listener: UnhandledFailureListener): () => void {
    this.unhandledFailureListeners.add(listener);
    return () => this.unhandledFailureListeners.delete(listener);
  }

  public send(message: ClientMessage): void {
    const socket = this.socket;
    if (socket === null || socket.readyState !== OPEN) {
      throw new Error("WebSocket is not connected");
    }
    if (!this.protocolReady) {
      throw new Error("WebSocket protocol handshake is not complete");
    }
    socket.send(JSON.stringify(message));
  }

  public request(
    buildMessage: (requestId: number) => RequestMessage,
    requestAllocated?: (requestId: number) => void,
  ): Promise<ServerJsonMessage> {
    const requestId = this.allocateRequestId();
    const message = buildMessage(requestId);
    if (message.requestId !== requestId) {
      throw new Error("Request builder returned the wrong request ID");
    }
    requestAllocated?.(requestId);

    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      try {
        this.send(message);
      } catch (error) {
        this.pending.delete(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  public sendWithRequestId(buildMessage: (requestId: number) => RequestMessage): number {
    const requestId = this.allocateRequestId();
    const message = buildMessage(requestId);
    if (message.requestId !== requestId) {
      throw new Error("Request builder returned the wrong request ID");
    }
    this.send(message);
    return requestId;
  }

  public async executeScpi(
    instrument: SupportedInstrument,
    command: string,
  ): Promise<string> {
    const response = await this.request((requestId): ScpiExecuteMessage => ({
      type: MessageType.ScpiExecute,
      requestId,
      instrument,
      command,
    }));
    if (response.type === MessageType.CommandCompleted) {
      return "";
    }
    if (response.type !== MessageType.ScpiResult) {
      throw new Error("Unexpected response to SCPI request");
    }
    return response.response;
  }

  public close(code?: number, reason?: string): void {
    this.socket?.close(code, reason);
  }

  private sendInstrumentSubscribe(instrument: SupportedInstrument): void {
    const message: InstrumentSubscribeMessage = {
      type: MessageType.InstrumentSubscribe,
      instrument,
    };
    this.send(message);
  }

  private handleMessage(data: string | ArrayBuffer): void {
    if (typeof data !== "string") {
      for (const listener of this.binaryListeners) {
        listener(data);
      }
      return;
    }

    try {
      const message = asServerMessage(JSON.parse(data) as unknown);
      this.handleJson(message);
    } catch (error) {
      console.error("WebSocket message handling failed", error);
    }
  }

  private handleJson(message: ServerJsonMessage): void {
    if (message.type === MessageType.ProtocolHello) {
      if (message.protocolVersion !== PROTOCOL_VERSION) {
        const reason = `Protocol version mismatch: server ${message.protocolVersion}, browser ${PROTOCOL_VERSION}`;
        useAppTransportStore.getState().setDisconnected(reason);
        this.socket?.close(1002, reason);
        return;
      }

      this.protocolReady = true;
      const ack: ProtocolHelloAckMessage = {
        type: MessageType.ProtocolHelloAck,
        protocolVersion: PROTOCOL_VERSION,
      };
      this.send(ack);
      useAppTransportStore.getState().setConnected();
      for (const instrument of this.subscriptions) {
        this.sendInstrumentSubscribe(instrument);
      }
      return;
    }

    if (message.type === MessageType.CommandFailed) {
      if (!this.rejectRequest(message)) {
        for (const listener of this.unhandledFailureListeners) {
          listener(message);
        }
      }
    } else if ("requestId" in message && typeof message.requestId === "number") {
      this.resolvePending(message.requestId, message);
    }

    for (const listener of this.jsonListeners) {
      listener(message);
    }
  }

  private allocateRequestId(): number {
    const current = this.requestId;
    this.requestId = current >= Number.MAX_SAFE_INTEGER ? 0 : current + 1;
    return current;
  }

  private resolvePending(requestId: number, message: ServerJsonMessage): void {
    const pending = this.pending.get(requestId);
    if (pending === undefined) {
      return;
    }
    this.pending.delete(requestId);
    pending.resolve(message);
  }

  private rejectRequest(message: CommandFailedMessage): boolean {
    const pending = this.pending.get(message.requestId);
    if (pending === undefined) {
      return false;
    }
    this.pending.delete(message.requestId);
    pending.reject(new Error(message.error));
    return true;
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }
}
