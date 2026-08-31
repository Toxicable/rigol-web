import { Buffer } from "node:buffer";
import type { Server as HttpServer } from "node:http";

import {
  WebSocket,
  WebSocketServer,
  type RawData,
} from "ws";

import {
  DmmAcquisitionRate,
  DmmControlKind,
  DmmMeasurementFunction,
  DmmRangeMode,
  type DmmControlChange,
  type DmmInfo,
  type DmmRange,
  type DmmReadingSnapshot,
  type DmmState,
} from "../../shared/dmm-types.js";
import { SupportedInstrument } from "../../shared/instrument-types.js";
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
import { InstrumentRegistry } from "../instruments/instrument-registry.js";
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

export enum ServerDmmConnectionKind {
  Disconnected = 1,
  Connected = 2,
}

export type ServerDmmConnection =
  | {
      kind: ServerDmmConnectionKind.Disconnected;
      reason: string;
    }
  | {
      kind: ServerDmmConnectionKind.Connected;
      info: DmmInfo;
      state: DmmState;
    };

export interface WaveformRequestHandlers {
  requestDeepCapture(requestId: number): Promise<DeepCaptureReadyMessage>;
  requestViewport(request: WaveformViewportRequestMessage): Promise<Uint8Array>;
}

export interface DmmRequestHandlers {
  setControl(control: DmmControlChange): Promise<void>;
  executeRawScpi(command: string): Promise<string>;
}

export interface WebSocketGatewayOptions {
  instruments: InstrumentRegistry;
  initialDmmConnection: ServerDmmConnection;
  waveformHandlers: WaveformRequestHandlers;
  dmmHandlers: DmmRequestHandlers;
}

interface ClientState {
  socket: WebSocket;
  protocolReady: boolean;
  subscriptions: Set<SupportedInstrument>;
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

function readPositiveFiniteNumber(value: unknown, name: string): number {
  const parsed = readFiniteNumber(value, name);
  if (parsed <= 0) {
    throw new Error(`${name} must be positive`);
  }
  return parsed;
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

function readInstrument(value: unknown): SupportedInstrument {
  switch (value) {
    case SupportedInstrument.Dho804:
    case SupportedInstrument.Dm858e:
      return value;
    default:
      throw new Error("Unsupported instrument");
  }
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
        throw new Error("Only TriggerType.Edge is writable");
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

function readDmmFunction(value: unknown): DmmMeasurementFunction {
  switch (value) {
    case DmmMeasurementFunction.DcVoltage:
    case DmmMeasurementFunction.AcVoltage:
    case DmmMeasurementFunction.DcCurrent:
    case DmmMeasurementFunction.AcCurrent:
    case DmmMeasurementFunction.Resistance2Wire:
    case DmmMeasurementFunction.Resistance4Wire:
    case DmmMeasurementFunction.Continuity:
    case DmmMeasurementFunction.Diode:
    case DmmMeasurementFunction.Frequency:
    case DmmMeasurementFunction.Period:
    case DmmMeasurementFunction.Capacitance:
    case DmmMeasurementFunction.Temperature:
      return value;
    default:
      throw new Error("Invalid DMM measurement function");
  }
}

function readDmmRange(value: unknown): DmmRange {
  if (!isRecord(value)) {
    throw new Error("DMM range must be an object");
  }

  switch (value.mode) {
    case DmmRangeMode.Auto:
      return { mode: DmmRangeMode.Auto };
    case DmmRangeMode.Fixed:
      return {
        mode: DmmRangeMode.Fixed,
        value: readPositiveFiniteNumber(value.value, "DMM fixed range"),
      };
    default:
      throw new Error("Invalid DMM range mode");
  }
}

function readDmmAcquisitionRate(value: unknown): DmmAcquisitionRate {
  switch (value) {
    case DmmAcquisitionRate.Slow:
    case DmmAcquisitionRate.Medium:
    case DmmAcquisitionRate.Fast:
      return value;
    default:
      throw new Error("Invalid DMM acquisition rate");
  }
}

function readDmmControl(value: unknown): DmmControlChange {
  if (!isRecord(value)) {
    throw new Error("DMM control must be an object");
  }

  switch (value.kind) {
    case DmmControlKind.Function:
      return {
        kind: DmmControlKind.Function,
        value: readDmmFunction(value.value),
      };
    case DmmControlKind.Range:
      return {
        kind: DmmControlKind.Range,
        function: readDmmFunction(value.function),
        value: readDmmRange(value.value),
      };
    case DmmControlKind.AcquisitionRate:
      return {
        kind: DmmControlKind.AcquisitionRate,
        function: readDmmFunction(value.function),
        value: readDmmAcquisitionRate(value.value),
      };
    default:
      throw new Error("Unknown DMM control kind");
  }
}

function parseClientMessage(value: unknown): ClientMessage {
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
        instrument: readInstrument(value.instrument),
        command: value.command,
      };
    case MessageType.MeasurementRead:
      return {
        type: MessageType.MeasurementRead,
        requestId: readRequestId(value.requestId),
        measurements: readMeasurements(value.measurements),
      };
    case MessageType.DmmControlSet:
      return {
        type: MessageType.DmmControlSet,
        requestId: readRequestId(value.requestId),
        control: readDmmControl(value.control),
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
  private readonly instruments: InstrumentRegistry;
  private readonly waveformHandlers: WaveformRequestHandlers;
  private readonly dmmHandlers: DmmRequestHandlers;
  private scopeConnection: ServerScopeConnection;
  private scopeConnectionRevision = 0;
  private dmmConnection: ServerDmmConnection;
  private dmmConnectionRevision = 0;
  private unsubscribeScopeStateStore: (() => void) | undefined;

  public constructor(
    server: HttpServer,
    initialScopeConnection: ServerScopeConnection,
    options: WebSocketGatewayOptions,
  ) {
    this.scopeConnection = initialScopeConnection;
    this.dmmConnection = options.initialDmmConnection;
    this.instruments = options.instruments;
    this.waveformHandlers = options.waveformHandlers;
    this.dmmHandlers = options.dmmHandlers;
    this.webSocketServer = new WebSocketServer({
      server,
      path: "/ws",
      perMessageDeflate: false,
    });

    this.attachScopeStateSubscription(initialScopeConnection);
    this.webSocketServer.on("connection", (socket) => {
      this.acceptClient(socket);
    });
  }

  public setScopeConnection(connection: ServerScopeConnection): void {
    this.unsubscribeScopeStateStore?.();
    this.unsubscribeScopeStateStore = undefined;
    this.scopeConnection = connection;
    this.scopeConnectionRevision += 1;
    this.attachScopeStateSubscription(connection);
    this.broadcastJsonToInstrument(SupportedInstrument.Dho804, this.scopeLifecycleMessage(connection));
  }

  public setDmmConnection(connection: ServerDmmConnection): void {
    this.dmmConnection = connection;
    this.dmmConnectionRevision += 1;
    this.broadcastJsonToInstrument(SupportedInstrument.Dm858e, this.dmmLifecycleMessage(connection));
  }

  public publishDmmState(state: DmmState): void {
    if (this.dmmConnection.kind !== ServerDmmConnectionKind.Connected) {
      return;
    }
    this.dmmConnection = { ...this.dmmConnection, state };
    this.broadcastJsonToInstrument(SupportedInstrument.Dm858e, {
      type: MessageType.DmmState,
      state,
    });
  }

  public broadcastDmmSnapshot(snapshot: DmmReadingSnapshot): void {
    this.broadcastJsonToInstrument(SupportedInstrument.Dm858e, {
      type: MessageType.DmmSnapshot,
      snapshot,
    });
  }

  public broadcastWaveform(frame: Uint8Array): void {
    const header = readWaveformHeader(frame);

    if (header.kind !== WaveformKind.Live || header.captureId !== 0) {
      throw new Error("broadcastWaveform only accepts live waveform frames");
    }

    for (const client of this.clients.values()) {
      if (client.protocolReady && client.subscriptions.has(SupportedInstrument.Dho804)) {
        this.queueLiveFrame(client, header.channel, frame);
      }
    }
  }

  public async close(): Promise<void> {
    this.unsubscribeScopeStateStore?.();
    this.unsubscribeScopeStateStore = undefined;

    await Promise.all(
      [...this.clients.values()].map((client) => this.instruments.releaseSession(client)),
    );

    for (const client of this.clients.values()) {
      client.socket.close(1001, "Server shutting down");
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

  private attachScopeStateSubscription(connection: ServerScopeConnection): void {
    if (connection.kind !== ServerScopeConnectionKind.Connected) {
      return;
    }

    this.unsubscribeScopeStateStore = connection.stateStore.subscribe((state) => {
      this.broadcastJsonToInstrument(SupportedInstrument.Dho804, {
        type: MessageType.ScopeState,
        state,
      });
    });
  }

  private acceptClient(socket: WebSocket): void {
    const client: ClientState = {
      socket,
      protocolReady: false,
      subscriptions: new Set(),
      pendingLiveFrames: new Map(),
      liveSendInFlight: false,
      viewportGenerations: new Map(),
    };

    this.clients.set(socket, client);

    socket.on("message", (data, isBinary) => {
      this.receiveClientMessage(client, data, isBinary);
    });

    socket.on("close", () => {
      client.subscriptions.clear();
      client.pendingLiveFrames.clear();
      client.viewportGenerations.clear();
      this.clients.delete(socket);
      void this.instruments.releaseSession(client).catch((error: unknown) => {
        console.error("Failed to release browser instrument subscriptions", error);
      });
    });

    socket.on("error", (error) => {
      console.error("WebSocket client error", error);
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
    if (message.type === MessageType.ProtocolHelloAck) {
      if (message.protocolVersion !== PROTOCOL_VERSION) {
        client.socket.close(
          1002,
          `Protocol version mismatch: server ${PROTOCOL_VERSION}, browser ${message.protocolVersion}`,
        );
        return;
      }
      client.protocolReady = true;
      return;
    }

    if (!client.protocolReady) {
      client.socket.close(1002, "Protocol handshake required");
      return;
    }

    try {
      switch (message.type) {
        case MessageType.InstrumentSubscribe:
          await this.subscribeClient(client, message.instrument);
          return;
        case MessageType.InstrumentUnsubscribe:
          await this.unsubscribeClient(client, message.instrument);
          return;
        case MessageType.ControlSet: {
          this.requireSubscribed(client, SupportedInstrument.Dho804);
          const { controller, revision } = this.connectedScopeController();
          await controller.setControl(message.control);
          this.requireScopeConnectionRevision(revision);
          this.sendCompleted(client, message.requestId);
          return;
        }
        case MessageType.InteractionUpdate: {
          this.requireSubscribed(client, SupportedInstrument.Dho804);
          const { controller } = this.connectedScopeController();
          try {
            await controller.updateInteraction(message.control);
          } catch (error) {
            console.error("Interactive scope update failed", error);
          }
          return;
        }
        case MessageType.InteractionCommit: {
          this.requireSubscribed(client, SupportedInstrument.Dho804);
          const { controller, revision } = this.connectedScopeController();
          await controller.commitInteraction(message.control);
          this.requireScopeConnectionRevision(revision);
          this.sendCompleted(client, message.requestId);
          return;
        }
        case MessageType.AcquisitionAction: {
          this.requireSubscribed(client, SupportedInstrument.Dho804);
          const { controller, revision } = this.connectedScopeController();
          await controller.performAcquisitionAction(message.action);
          this.requireScopeConnectionRevision(revision);
          this.sendCompleted(client, message.requestId);
          return;
        }
        case MessageType.MeasurementRead: {
          this.requireSubscribed(client, SupportedInstrument.Dho804);
          const { controller, revision } = this.connectedScopeController();
          const values = await controller.readMeasurements(message.measurements);
          this.requireScopeConnectionRevision(revision);
          this.sendJson(client, {
            type: MessageType.MeasurementResult,
            requestId: message.requestId,
            values,
          });
          return;
        }
        case MessageType.ScpiExecute: {
          this.requireSubscribed(client, message.instrument);
          let response: string;
          if (message.instrument === SupportedInstrument.Dho804) {
            const { controller, revision } = this.connectedScopeController();
            response = await controller.executeRawScpi(message.command);
            this.requireScopeConnectionRevision(revision);
          } else {
            const revision = this.dmmConnectionRevision;
            response = await this.dmmHandlers.executeRawScpi(message.command);
            this.requireDmmConnectionRevision(revision);
          }
          this.sendJson(client, {
            type: MessageType.ScpiResult,
            requestId: message.requestId,
            response,
          });
          return;
        }
        case MessageType.DeepCaptureRequest: {
          this.requireSubscribed(client, SupportedInstrument.Dho804);
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
          this.requireSubscribed(client, SupportedInstrument.Dho804);
          await this.dispatchViewportRequest(client, message);
          return;
        case MessageType.DmmControlSet: {
          this.requireSubscribed(client, SupportedInstrument.Dm858e);
          const revision = this.dmmConnectionRevision;
          await this.dmmHandlers.setControl(message.control);
          this.requireDmmConnectionRevision(revision);
          this.sendCompleted(client, message.requestId);
          return;
        }
      }
    } catch (error) {
      if (message.type === MessageType.InteractionUpdate) {
        console.error("Interactive scope update failed", error);
        return;
      }

      if (
        message.type === MessageType.InstrumentSubscribe ||
        message.type === MessageType.InstrumentUnsubscribe
      ) {
        this.sendInstrumentDisconnected(client, message.instrument, errorMessage(error));
        return;
      }

      this.sendFailure(client, message.requestId, error);
    }
  }

  private async subscribeClient(
    client: ClientState,
    instrument: SupportedInstrument,
  ): Promise<void> {
    if (client.subscriptions.has(instrument)) {
      return;
    }

    client.subscriptions.add(instrument);
    this.sendInstrumentLifecycle(client, instrument);
    try {
      await this.instruments.subscribe(client, instrument);
    } catch (error) {
      client.subscriptions.delete(instrument);
      throw error;
    }
  }

  private async unsubscribeClient(
    client: ClientState,
    instrument: SupportedInstrument,
  ): Promise<void> {
    if (!client.subscriptions.delete(instrument)) {
      return;
    }

    if (instrument === SupportedInstrument.Dho804) {
      client.pendingLiveFrames.clear();
      client.viewportGenerations.clear();
    }
    await this.instruments.unsubscribe(client, instrument);
  }

  private requireSubscribed(client: ClientState, instrument: SupportedInstrument): void {
    if (!client.subscriptions.has(instrument)) {
      const name = instrument === SupportedInstrument.Dho804 ? "DHO804" : "DM858E";
      throw new Error(`Browser session is not subscribed to ${name}`);
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

  private connectedScopeController(): { controller: ScopeController; revision: number } {
    if (this.scopeConnection.kind !== ServerScopeConnectionKind.Connected) {
      throw new Error(`Scope disconnected: ${this.scopeConnection.reason}`);
    }

    return {
      controller: this.scopeConnection.controller,
      revision: this.scopeConnectionRevision,
    };
  }

  private requireScopeConnectionRevision(revision: number): void {
    if (revision !== this.scopeConnectionRevision) {
      throw new Error("Scope session changed while request was in flight");
    }
  }

  private requireDmmConnectionRevision(revision: number): void {
    if (revision !== this.dmmConnectionRevision) {
      throw new Error("DMM session changed while request was in flight");
    }
  }

  private scopeLifecycleMessage(connection: ServerScopeConnection): ServerJsonMessage {
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

  private dmmLifecycleMessage(connection: ServerDmmConnection): ServerJsonMessage {
    if (connection.kind === ServerDmmConnectionKind.Disconnected) {
      return {
        type: MessageType.DmmDisconnected,
        reason: connection.reason,
      };
    }

    return {
      type: MessageType.DmmConnected,
      protocolVersion: PROTOCOL_VERSION,
      info: connection.info,
      state: connection.state,
    };
  }

  private sendInstrumentLifecycle(client: ClientState, instrument: SupportedInstrument): void {
    if (instrument === SupportedInstrument.Dho804) {
      this.sendJson(client, this.scopeLifecycleMessage(this.scopeConnection));
      return;
    }
    this.sendJson(client, this.dmmLifecycleMessage(this.dmmConnection));
  }

  private sendInstrumentDisconnected(
    client: ClientState,
    instrument: SupportedInstrument,
    reason: string,
  ): void {
    if (instrument === SupportedInstrument.Dho804) {
      this.sendJson(client, { type: MessageType.ScopeDisconnected, reason });
      return;
    }
    this.sendJson(client, { type: MessageType.DmmDisconnected, reason });
  }

  private broadcastJsonToInstrument(
    instrument: SupportedInstrument,
    message: ServerJsonMessage,
  ): void {
    for (const client of this.clients.values()) {
      if (client.protocolReady && client.subscriptions.has(instrument)) {
        this.sendJson(client, message);
      }
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
