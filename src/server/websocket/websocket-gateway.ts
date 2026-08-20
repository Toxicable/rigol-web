import { Buffer } from "node:buffer";
import type { Server as HttpServer } from "node:http";

import {
  WebSocket,
  WebSocketServer,
  type RawData,
} from "ws";

import {
  Channel,
  EdgeSlope,
  MeasurementKind,
  TriggerType,
  type MeasurementSpec,
  type ScopeInfo,
} from "../../shared/scope-types.js";
import {
  WAVEFORM_FRAME_VERSION,
  WAVEFORM_HEADER_BYTES,
  WAVEFORM_MAGIC,
} from "../../shared/waveform-protocol.js";
import {
  AcquisitionAction,
  ControlKind,
  MessageType,
  PROTOCOL_VERSION,
  WaveformKind,
  type ClientMessage,
  type ControlChange,
  type DeepCaptureReadyMessage,
  type InteractiveControl,
  type NonEmptyArray,
  type ServerJsonMessage,
  type WaveformViewportRequestMessage,
} from "../../shared/websocket-protocol.js";
import { ScopeController } from "../scope/scope-controller.js";
import { ScopeStateStore } from "../scope/scope-state-store.js";

const MAX_WAVEFORM_BUFFERED_BYTES = 256 * 1024;

export enum ServerScopeConnectionKind {
  Disconnected = 1,
  Connected = 2,
}

export type ServerScopeConnection =
  | {
      kind: ServerScopeConnectionKind.Disconnected;
      reason: string;
    }
  | {
      kind: ServerScopeConnectionKind.Connected;
      info: ScopeInfo;
      stateStore: ScopeStateStore;
      controller: ScopeController;
    };

export interface WaveformRequestHandlers {
  requestDeepCapture(requestId: number): Promise<DeepCaptureReadyMessage>;
  requestViewport(request: WaveformViewportRequestMessage): Promise<Uint8Array>;
}

interface ClientState {
  socket: WebSocket;
  pendingLiveFrames: Map<Channel, Uint8Array>;
  liveSendInFlight: boolean;
  viewportGenerations: Map<Channel, number>;
}

interface WaveformHeader {
  kind: WaveformKind;
  channel: Channel;
  captureId: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readRequestId(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new Error("requestId must be a non-negative integer");
  }

  return value as number;
}

function tryReadRequestId(value: unknown): number | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  try {
    return readRequestId(value.requestId);
  } catch {
    return undefined;
  }
}

function readFiniteNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${name} must be finite`);
  }

  return value;
}

function readNonNegativeInteger(value: unknown, name: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }

  return value as number;
}

function readPositiveInteger(value: unknown, name: string): number {
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return value as number;
}

function readChannel(value: unknown): Channel {
  switch (value) {
    case Channel.Ch1:
    case Channel.Ch2:
    case Channel.Ch3:
    case Channel.Ch4:
      return value;
    default:
      throw new Error("channel must be CH1 through CH4");
  }
}

function readEdgeSlope(value: unknown): EdgeSlope {
  switch (value) {
    case EdgeSlope.Rising:
    case EdgeSlope.Falling:
    case EdgeSlope.Either:
      return value;
    default:
      throw new Error("Invalid Edge slope");
  }
}

function readMeasurementKind(value: unknown): MeasurementKind {
  switch (value) {
    case MeasurementKind.Vpp:
    case MeasurementKind.Vmax:
    case MeasurementKind.Vmin:
    case MeasurementKind.Vavg:
    case MeasurementKind.Vrms:
    case MeasurementKind.Frequency:
    case MeasurementKind.Period:
      return value;
    default:
      throw new Error("Invalid measurement kind");
  }
}

function readControl(value: unknown): ControlChange {
  if (!isRecord(value)) {
    throw new Error("control must be an object");
  }

  switch (value.kind) {
    case ControlKind.ChannelEnabled:
      if (typeof value.value !== "boolean") {
        throw new Error("Channel enabled value must be boolean");
      }
      return {
        kind: ControlKind.ChannelEnabled,
        channel: readChannel(value.channel),
        value: value.value,
      };
    case ControlKind.ChannelScale:
      return {
        kind: ControlKind.ChannelScale,
        channel: readChannel(value.channel),
        value: readFiniteNumber(value.value, "Channel scale"),
      };
    case ControlKind.ChannelOffset:
      return {
        kind: ControlKind.ChannelOffset,
        channel: readChannel(value.channel),
        value: readFiniteNumber(value.value, "Channel offset"),
      };
    case ControlKind.HorizontalScale:
      return {
        kind: ControlKind.HorizontalScale,
        value: readFiniteNumber(value.value, "Horizontal scale"),
      };
    case ControlKind.HorizontalPosition:
      return {
        kind: ControlKind.HorizontalPosition,
        value: readFiniteNumber(value.value, "Horizontal position"),
      };
    case ControlKind.TriggerLevel:
      return {
        kind: ControlKind.TriggerLevel,
        value: readFiniteNumber(value.value, "Trigger level"),
      };
    case ControlKind.TriggerType:
      if (value.value !== TriggerType.Edge) {
        throw new Error("Version 1 only accepts TriggerType.Edge");
      }
      return { kind: ControlKind.TriggerType, value: TriggerType.Edge };
    case ControlKind.TriggerSource:
      return {
        kind: ControlKind.TriggerSource,
        value: readChannel(value.value),
      };
    case ControlKind.TriggerSlope:
      return {
        kind: ControlKind.TriggerSlope,
        value: readEdgeSlope(value.value),
      };
    default:
      throw new Error("Unknown control kind");
  }
}

function readInteractiveControl(value: unknown): InteractiveControl {
  const control = readControl(value);

  switch (control.kind) {
    case ControlKind.ChannelScale:
    case ControlKind.ChannelOffset:
    case ControlKind.HorizontalScale:
    case ControlKind.HorizontalPosition:
    case ControlKind.TriggerLevel:
      return control;
    default:
      throw new Error("Control is not interactive");
  }
}

function readMeasurements(value: unknown): NonEmptyArray<MeasurementSpec> {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("measurements must contain at least one item");
  }

  const measurements = value.map((item): MeasurementSpec => {
    if (!isRecord(item)) {
      throw new Error("measurement must be an object");
    }

    return {
      kind: readMeasurementKind(item.kind),
      channel: readChannel(item.channel),
    };
  });

  return measurements as NonEmptyArray<MeasurementSpec>;
}

function readAcquisitionAction(value: unknown): AcquisitionAction {
  switch (value) {
    case AcquisitionAction.Run:
    case AcquisitionAction.Stop:
    case AcquisitionAction.Single:
      return value;
    default:
      throw new Error("Invalid acquisition action");
  }
}

function parseClientMessage(value: unknown): ClientMessage {
  if (!isRecord(value)) {
    throw new Error("Message must be an object");
  }

  switch (value.type) {
    case MessageType.ControlSet:
      return {
        type: MessageType.ControlSet,
        requestId: readRequestId(value.requestId),
        control: readControl(value.control),
      };
    case MessageType.InteractionUpdate:
      return {
        type: MessageType.InteractionUpdate,
        control: readInteractiveControl(value.control),
      };
    case MessageType.InteractionCommit:
      return {
        type: MessageType.InteractionCommit,
        requestId: readRequestId(value.requestId),
        control: readInteractiveControl(value.control),
      };
    case MessageType.AcquisitionAction:
      return {
        type: MessageType.AcquisitionAction,
        requestId: readRequestId(value.requestId),
        action: readAcquisitionAction(value.action),
      };
    case MessageType.DeepCaptureRequest:
      return {
        type: MessageType.DeepCaptureRequest,
        requestId: readRequestId(value.requestId),
      };
    case MessageType.WaveformViewportRequest: {
      const startSample = readNonNegativeInteger(value.startSample, "startSample");
      const endSample = readPositiveInteger(value.endSample, "endSample");

      if (endSample <= startSample) {
        throw new Error("endSample must be greater than startSample");
      }

      return {
        type: MessageType.WaveformViewportRequest,
        requestId: readRequestId(value.requestId),
        captureId: readPositiveInteger(value.captureId, "captureId"),
        channel: readChannel(value.channel),
        startSample,
        endSample,
        pixelWidth: readPositiveInteger(value.pixelWidth, "pixelWidth"),
      };
    }
    case MessageType.ScpiExecute:
      if (typeof value.command !== "string") {
        throw new Error("command must be a string");
      }
      return {
        type: MessageType.ScpiExecute,
        requestId: readRequestId(value.requestId),
        command: value.command,
      };
    case MessageType.MeasurementRead:
      return {
        type: MessageType.MeasurementRead,
        requestId: readRequestId(value.requestId),
        measurements: readMeasurements(value.measurements),
      };
    default:
      throw new Error("Unknown client message type");
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function readWaveformHeader(frame: Uint8Array): WaveformHeader {
  if (frame.byteLength < WAVEFORM_HEADER_BYTES) {
    throw new Error("Waveform frame is shorter than its header");
  }

  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);

  if (view.getUint32(0, true) !== WAVEFORM_MAGIC) {
    throw new Error("Waveform frame has invalid magic");
  }

  if (view.getUint8(4) !== WAVEFORM_FRAME_VERSION) {
    throw new Error("Waveform frame has unsupported version");
  }

  const kind = view.getUint8(5);
  if (kind !== WaveformKind.Live && kind !== WaveformKind.DeepViewport) {
    throw new Error("Waveform frame has invalid kind");
  }

  const channel = readChannel(view.getUint8(6));

  if (view.getUint32(28, true) !== WAVEFORM_HEADER_BYTES) {
    throw new Error("Waveform frame has invalid header length");
  }

  return {
    kind,
    channel,
    captureId: view.getUint32(12, true),
  };
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

export class WebSocketGateway {
  private readonly webSocketServer: WebSocketServer;
  private readonly clients = new Map<WebSocket, ClientState>();
  private connection: ServerScopeConnection;
  private connectionRevision = 0;
  private unsubscribeStateStore: (() => void) | undefined;

  public constructor(
    server: HttpServer,
    initialConnection: ServerScopeConnection,
    private readonly waveformHandlers: WaveformRequestHandlers,
  ) {
    this.connection = initialConnection;
    this.webSocketServer = new WebSocketServer({
      server,
      path: "/ws",
      perMessageDeflate: false,
    });

    this.attachStateSubscription(initialConnection);
    this.webSocketServer.on("connection", (socket) => {
      this.acceptClient(socket);
    });
  }

  public setScopeConnection(connection: ServerScopeConnection): void {
    this.unsubscribeStateStore?.();
    this.unsubscribeStateStore = undefined;
    this.connection = connection;
    this.connectionRevision += 1;
    this.attachStateSubscription(connection);
    this.broadcastJson(this.lifecycleMessage(connection));
  }

  public broadcastWaveform(frame: Uint8Array): void {
    const header = readWaveformHeader(frame);

    if (header.kind !== WaveformKind.Live || header.captureId !== 0) {
      throw new Error("broadcastWaveform only accepts live waveform frames");
    }

    for (const client of this.clients.values()) {
      this.queueLiveFrame(client, header.channel, frame);
    }
  }

  public close(): Promise<void> {
    this.unsubscribeStateStore?.();
    this.unsubscribeStateStore = undefined;

    for (const client of this.clients.values()) {
      client.socket.close(1001, "Server shutting down");
    }

    return new Promise((resolve, reject) => {
      this.webSocketServer.close((error) => {
        if (error === undefined) {
          resolve();
          return;
        }

        reject(error);
      });
    });
  }

  private attachStateSubscription(connection: ServerScopeConnection): void {
    if (connection.kind !== ServerScopeConnectionKind.Connected) {
      return;
    }

    this.unsubscribeStateStore = connection.stateStore.subscribe((state) => {
      this.broadcastJson({ type: MessageType.ScopeState, state });
    });
  }

  private acceptClient(socket: WebSocket): void {
    const client: ClientState = {
      socket,
      pendingLiveFrames: new Map(),
      liveSendInFlight: false,
      viewportGenerations: new Map(),
    };

    this.clients.set(socket, client);
    this.sendJson(client, this.lifecycleMessage(this.connection));

    socket.on("message", (data, isBinary) => {
      this.receiveClientMessage(client, data, isBinary);
    });

    socket.on("close", () => {
      client.pendingLiveFrames.clear();
      client.viewportGenerations.clear();
      this.clients.delete(socket);
    });

    socket.on("error", (error) => {
      console.error("WebSocket client error", error);
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

    let message: ClientMessage;

    try {
      message = parseClientMessage(rawMessage);
    } catch (error) {
      const requestId = tryReadRequestId(rawMessage);
      if (requestId === undefined) {
        client.socket.close(1008, "Invalid client message");
      } else {
        this.sendFailure(client, requestId, error);
      }
      return;
    }

    void this.dispatchClientMessage(client, message);
  }

  private async dispatchClientMessage(
    client: ClientState,
    message: ClientMessage,
  ): Promise<void> {
    try {
      switch (message.type) {
        case MessageType.ControlSet: {
          const { controller, revision } = this.connectedController();
          await controller.setControl(message.control);
          this.requireConnectionRevision(revision);
          this.sendCompleted(client, message.requestId);
          return;
        }
        case MessageType.InteractionUpdate: {
          const { controller } = this.connectedController();
          try {
            await controller.updateInteraction(message.control);
          } catch (error) {
            console.error("Interactive scope update failed", error);
          }
          return;
        }
        case MessageType.InteractionCommit: {
          const { controller, revision } = this.connectedController();
          await controller.commitInteraction(message.control);
          this.requireConnectionRevision(revision);
          this.sendCompleted(client, message.requestId);
          return;
        }
        case MessageType.AcquisitionAction: {
          const { controller, revision } = this.connectedController();
          await controller.performAcquisitionAction(message.action);
          this.requireConnectionRevision(revision);
          this.sendCompleted(client, message.requestId);
          return;
        }
        case MessageType.MeasurementRead: {
          const { controller, revision } = this.connectedController();
          const values = await controller.readMeasurements(message.measurements);
          this.requireConnectionRevision(revision);
          this.sendJson(client, {
            type: MessageType.MeasurementResult,
            requestId: message.requestId,
            values,
          });
          return;
        }
        case MessageType.ScpiExecute: {
          const { controller, revision } = this.connectedController();
          const response = await controller.executeRawScpi(message.command);
          this.requireConnectionRevision(revision);
          this.sendJson(client, {
            type: MessageType.ScpiResult,
            requestId: message.requestId,
            response,
          });
          return;
        }
        case MessageType.DeepCaptureRequest: {
          const result = await this.waveformHandlers.requestDeepCapture(message.requestId);
          if (
            result.type !== MessageType.DeepCaptureReady ||
            result.requestId !== message.requestId
          ) {
            throw new Error("Deep capture handler returned a mismatched result");
          }
          this.sendJson(client, result);
          return;
        }
        case MessageType.WaveformViewportRequest:
          await this.dispatchViewportRequest(client, message);
          return;
      }
    } catch (error) {
      if (message.type === MessageType.InteractionUpdate) {
        console.error("Interactive scope update failed", error);
        return;
      }

      this.sendFailure(client, message.requestId, error);
    }
  }

  private async dispatchViewportRequest(
    client: ClientState,
    message: WaveformViewportRequestMessage,
  ): Promise<void> {
    const generation = (client.viewportGenerations.get(message.channel) ?? 0) + 1;
    client.viewportGenerations.set(message.channel, generation);
    const frame = await this.waveformHandlers.requestViewport(message);

    if (client.viewportGenerations.get(message.channel) !== generation) {
      this.sendFailure(
        client,
        message.requestId,
        new Error("Viewport request superseded by a newer request"),
      );
      return;
    }

    const header = readWaveformHeader(frame);
    if (
      header.kind !== WaveformKind.DeepViewport ||
      header.captureId !== message.captureId ||
      header.channel !== message.channel
    ) {
      throw new Error("Viewport handler returned a mismatched waveform frame");
    }

    if (client.socket.bufferedAmount > MAX_WAVEFORM_BUFFERED_BYTES) {
      this.sendFailure(
        client,
        message.requestId,
        new Error("Viewport response dropped because the client is backpressured"),
      );
      return;
    }

    this.sendBinary(client, frame);
  }

  private connectedController(): { controller: ScopeController; revision: number } {
    if (this.connection.kind !== ServerScopeConnectionKind.Connected) {
      throw new Error(`Scope disconnected: ${this.connection.reason}`);
    }

    return {
      controller: this.connection.controller,
      revision: this.connectionRevision,
    };
  }

  private requireConnectionRevision(revision: number): void {
    if (revision !== this.connectionRevision) {
      throw new Error("Scope session changed while request was in flight");
    }
  }

  private lifecycleMessage(connection: ServerScopeConnection): ServerJsonMessage {
    if (connection.kind === ServerScopeConnectionKind.Disconnected) {
      return {
        type: MessageType.ScopeDisconnected,
        reason: connection.reason,
      };
    }

    return {
      type: MessageType.ScopeConnected,
      protocolVersion: PROTOCOL_VERSION,
      info: connection.info,
      state: connection.stateStore.getState(),
    };
  }

  private broadcastJson(message: ServerJsonMessage): void {
    for (const client of this.clients.values()) {
      this.sendJson(client, message);
    }
  }

  private sendCompleted(client: ClientState, requestId: number): void {
    this.sendJson(client, { type: MessageType.CommandCompleted, requestId });
  }

  private sendFailure(client: ClientState, requestId: number, error: unknown): void {
    this.sendJson(client, {
      type: MessageType.CommandFailed,
      requestId,
      error: errorMessage(error),
    });
  }

  private sendJson(client: ClientState, message: ServerJsonMessage): void {
    if (client.socket.readyState !== WebSocket.OPEN) {
      return;
    }

    client.socket.send(JSON.stringify(message), { compress: false }, (error) => {
      if (error !== undefined) {
        console.error("WebSocket JSON send failed", error);
        return;
      }

      this.flushPendingLiveFrame(client);
    });
  }

  private queueLiveFrame(
    client: ClientState,
    channel: Channel,
    frame: Uint8Array,
  ): void {
    if (client.socket.readyState !== WebSocket.OPEN) {
      return;
    }

    if (
      client.liveSendInFlight ||
      client.socket.bufferedAmount > MAX_WAVEFORM_BUFFERED_BYTES
    ) {
      client.pendingLiveFrames.set(channel, frame);
      return;
    }

    client.pendingLiveFrames.delete(channel);
    this.sendLiveFrame(client, frame);
  }

  private sendLiveFrame(client: ClientState, frame: Uint8Array): void {
    client.liveSendInFlight = true;
    client.socket.send(
      frame,
      { binary: true, compress: false },
      (error) => {
        client.liveSendInFlight = false;

        if (error !== undefined) {
          console.error("WebSocket live waveform send failed", error);
          return;
        }

        this.flushPendingLiveFrame(client);
      },
    );
  }

  private flushPendingLiveFrame(client: ClientState): void {
    if (
      client.liveSendInFlight ||
      client.socket.readyState !== WebSocket.OPEN ||
      client.socket.bufferedAmount > MAX_WAVEFORM_BUFFERED_BYTES
    ) {
      return;
    }

    const pending = client.pendingLiveFrames.entries().next();
    if (pending.done) {
      return;
    }

    const [channel, frame] = pending.value;
    client.pendingLiveFrames.delete(channel);
    this.sendLiveFrame(client, frame);
  }

  private sendBinary(client: ClientState, frame: Uint8Array): void {
    if (client.socket.readyState !== WebSocket.OPEN) {
      return;
    }

    client.socket.send(
      frame,
      { binary: true, compress: false },
      (error) => {
        if (error !== undefined) {
          console.error("WebSocket waveform send failed", error);
          return;
        }

        this.flushPendingLiveFrame(client);
      },
    );
  }
}
