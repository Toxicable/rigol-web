import { ScopeRunState, type MeasurementSpec } from "../shared/scope-types.js";
import {
  AcquisitionAction,
  MessageType,
  PROTOCOL_VERSION,
  type AcquisitionActionMessage,
  type CommandCompletedMessage,
  type CommandFailedMessage,
  type ControlChange,
  type ControlSetMessage,
  type DeepCaptureReadyMessage,
  type DeepCaptureRequestMessage,
  type InteractionCommitMessage,
  type InteractiveControl,
  type InteractionUpdateMessage,
  type MeasurementReadMessage,
  type MeasurementResultMessage,
  type NonEmptyArray,
  type ScpiExecuteMessage,
  type ScpiResultMessage,
  type ServerJsonMessage,
  type WaveformViewportRequestMessage,
} from "../shared/websocket-protocol.js";
import { useScopeStore } from "./scope-store.js";
import type { DeepViewportRequest, WaveformController } from "./waveform/waveform-controller.js";
import { decodeWaveformFrame } from "./waveform/waveform-frame-decoder.js";

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

interface PendingRequest {
  resolve: (message: ServerJsonMessage) => void;
  reject: (error: Error) => void;
}

const OPEN = 1;
const MAX_BINARY_ERRORS = 3;

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
    case MessageType.ScopeConnected:
    case MessageType.ScopeState:
    case MessageType.ScopeDisconnected:
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

export class ScopeWebSocketClient {
  private socket: WebSocketLike | null = null;
  private requestId = 0;
  private readonly pending = new Map<number, PendingRequest>();
  private disposed = false;
  private binaryErrors = 0;
  private measurementInFlight = false;

  public constructor(
    private readonly waveforms: WaveformController,
    private readonly socketFactory: SocketFactory = defaultSocketFactory,
    private readonly urlFactory: () => string = websocketUrl,
  ) {}

  public connect(): void {
    this.disposed = false;
    this.waveforms.resetSession();
    useScopeStore.getState().setConnecting();
    const socket = this.socketFactory(this.urlFactory());
    socket.binaryType = "arraybuffer";
    socket.onopen = () => {
      this.binaryErrors = 0;
    };
    socket.onmessage = (event) => this.handleMessage(event.data);
    socket.onerror = () => {
      useScopeStore.getState().setError("WebSocket transport error");
    };
    socket.onclose = (event) => {
      if (this.socket !== socket) {
        return;
      }
      this.socket = null;
      this.waveforms.resetSession();
      const reason = event.reason || "WebSocket disconnected";
      useScopeStore.getState().setTransportDisconnected(reason);
      this.rejectPending(new Error(reason));
      if (!this.disposed) {
        window.setTimeout(() => this.connect(), 500);
      }
    };
    this.socket = socket;
  }

  public dispose(): void {
    this.disposed = true;
    this.socket?.close(1000, "Client disposed");
    this.socket = null;
    this.waveforms.resetSession();
    this.rejectPending(new Error("WebSocket client disposed"));
  }

  public setControl(control: ControlChange): Promise<void> {
    const requestId = this.nextRequestId();
    const message: ControlSetMessage = {
      type: MessageType.ControlSet,
      requestId,
      control,
    };
    return this.sendCommand(message);
  }

  public interactionUpdate(control: InteractiveControl): void {
    const message: InteractionUpdateMessage = {
      type: MessageType.InteractionUpdate,
      control,
    };
    this.send(message);
  }

  public interactionCommit(control: InteractiveControl): Promise<void> {
    const requestId = this.nextRequestId();
    const message: InteractionCommitMessage = {
      type: MessageType.InteractionCommit,
      requestId,
      control,
    };
    return this.sendCommand(message);
  }

  public acquisition(action: AcquisitionAction): Promise<void> {
    if (action === AcquisitionAction.Run || action === AcquisitionAction.Single) {
      this.retireDeepCapture();
    }
    const requestId = this.nextRequestId();
    const message: AcquisitionActionMessage = {
      type: MessageType.AcquisitionAction,
      requestId,
      action,
    };
    return this.sendCommand(message);
  }

  public async deepCapture(): Promise<DeepCaptureReadyMessage> {
    const requestId = this.nextRequestId();
    useScopeStore.getState().setDeepCapturing(requestId);
    const message: DeepCaptureRequestMessage = {
      type: MessageType.DeepCaptureRequest,
      requestId,
    };
    try {
      const response = await this.sendRequest(message);
      if (response.type !== MessageType.DeepCaptureReady) {
        throw new Error("Unexpected response to deep capture request");
      }
      return response;
    } catch (error) {
      useScopeStore.getState().clearDeepCapture();
      throw error;
    }
  }

  public requestViewport(request: DeepViewportRequest): number {
    const requestId = this.nextRequestId();
    const message: WaveformViewportRequestMessage = {
      type: MessageType.WaveformViewportRequest,
      requestId,
      ...request,
    };
    this.send(message);
    return requestId;
  }

  public async executeScpi(command: string): Promise<string> {
    const requestId = this.nextRequestId();
    const message: ScpiExecuteMessage = {
      type: MessageType.ScpiExecute,
      requestId,
      command,
    };
    const response = await this.sendRequest(message);
    if (response.type === MessageType.CommandCompleted) {
      return "";
    }
    if (response.type !== MessageType.ScpiResult) {
      throw new Error("Unexpected response to SCPI request");
    }
    return response.response;
  }

  public async readMeasurements(
    measurements: NonEmptyArray<MeasurementSpec>,
  ): Promise<MeasurementResultMessage> {
    const requestId = this.nextRequestId();
    const message: MeasurementReadMessage = {
      type: MessageType.MeasurementRead,
      requestId,
      measurements,
    };
    const response = await this.sendRequest(message);
    if (response.type !== MessageType.MeasurementResult) {
      throw new Error("Unexpected response to measurement request");
    }
    return response;
  }

  public async pollMeasurementsOnce(measurements: MeasurementSpec[]): Promise<void> {
    if (measurements.length === 0 || this.measurementInFlight) {
      return;
    }

    this.measurementInFlight = true;
    try {
      const [first, ...rest] = measurements;
      if (first === undefined) {
        return;
      }
      const response = await this.readMeasurements([first, ...rest]);
      useScopeStore.getState().setMeasurementValues(response.values);
    } finally {
      this.measurementInFlight = false;
    }
  }

  public startMeasurementPolling(
    getMeasurements: () => MeasurementSpec[],
    intervalMs = 1000,
  ): () => void {
    void this.pollMeasurementsOnce(getMeasurements()).catch((error: unknown) => {
      this.surfaceError(error);
    });
    const timer = window.setInterval(() => {
      void this.pollMeasurementsOnce(getMeasurements()).catch((error: unknown) => {
        this.surfaceError(error);
      });
    }, intervalMs);
    return () => window.clearInterval(timer);
  }

  private handleMessage(data: string | ArrayBuffer): void {
    if (typeof data !== "string") {
      try {
        const frame = decodeWaveformFrame(data);
        this.binaryErrors = 0;
        this.waveforms.acceptFrame(frame);
      } catch (error) {
        this.binaryErrors += 1;
        this.surfaceError(error);
        if (this.binaryErrors >= MAX_BINARY_ERRORS) {
          this.socket?.close(1002, "Repeated malformed waveform frames");
        }
      }
      return;
    }

    try {
      const message = asServerMessage(JSON.parse(data) as unknown);
      this.handleJson(message);
    } catch (error) {
      this.surfaceError(error);
    }
  }

  private handleJson(message: ServerJsonMessage): void {
    const store = useScopeStore.getState();
    switch (message.type) {
      case MessageType.ScopeConnected:
        if (message.protocolVersion !== PROTOCOL_VERSION) {
          throw new Error(
            `Protocol version mismatch: server ${message.protocolVersion}, browser ${PROTOCOL_VERSION}`,
          );
        }
        this.waveforms.resetSession();
        store.setScopeConnected(message.info, message.state);
        this.reconcileRunState(message.state.runState);
        return;

      case MessageType.ScopeState:
        store.replaceScope(message.state);
        this.reconcileRunState(message.state.runState);
        return;

      case MessageType.ScopeDisconnected:
        this.waveforms.resetSession();
        store.setScopeDisconnected(message.reason);
        return;

      case MessageType.DeepCaptureReady:
        store.setDeepReady(message.captureId, message.channels);
        this.waveforms.setDeepCapture(message.captureId);
        this.resolvePending(message.requestId, message);
        return;

      case MessageType.MeasurementResult:
        store.setMeasurementValues(message.values);
        this.resolvePending(message.requestId, message);
        return;

      case MessageType.ScpiResult:
      case MessageType.CommandCompleted:
        this.resolvePending(message.requestId, message);
        return;

      case MessageType.CommandFailed:
        this.rejectRequest(message);
        return;
    }
  }

  private reconcileRunState(runState: ScopeRunState): void {
    if (runState !== ScopeRunState.Stopped) {
      this.retireDeepCapture();
    }
  }

  private retireDeepCapture(): void {
    this.waveforms.retireDeepCapture();
    useScopeStore.getState().clearDeepCapture();
  }

  private sendCommand(
    message: ControlSetMessage | InteractionCommitMessage | AcquisitionActionMessage,
  ): Promise<void> {
    return this.sendRequest(message).then((response) => {
      if (response.type !== MessageType.CommandCompleted) {
        throw new Error("Unexpected command response");
      }
    });
  }

  private sendRequest(
    message:
      | ControlSetMessage
      | InteractionCommitMessage
      | AcquisitionActionMessage
      | DeepCaptureRequestMessage
      | ScpiExecuteMessage
      | MeasurementReadMessage,
  ): Promise<ServerJsonMessage> {
    return new Promise((resolve, reject) => {
      this.pending.set(message.requestId, { resolve, reject });
      try {
        this.send(message);
      } catch (error) {
        this.pending.delete(message.requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private send(message: object): void {
    const socket = this.socket;
    if (socket === null || socket.readyState !== OPEN) {
      throw new Error("WebSocket is not connected");
    }
    socket.send(JSON.stringify(message));
  }

  private nextRequestId(): number {
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

  private rejectRequest(message: CommandFailedMessage): void {
    this.waveforms.viewportRequestFailed(message.requestId);
    const pending = this.pending.get(message.requestId);
    const error = new Error(message.error);
    if (pending === undefined) {
      useScopeStore.getState().setError(message.error);
      return;
    }
    this.pending.delete(message.requestId);
    pending.reject(error);
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }

  private surfaceError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    console.error(error);
    useScopeStore.getState().setError(message);
  }
}

export { AcquisitionAction };
export type {
  CommandCompletedMessage,
  CommandFailedMessage,
  ScpiResultMessage,
};
