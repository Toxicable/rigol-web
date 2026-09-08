import { SupportedInstrument } from "../shared/instrument-types.js";
import { ScopeRunState, type MeasurementSpec } from "../shared/scope-types.js";
import {
  AcquisitionAction,
  MessageType,
  PROTOCOL_VERSION,
  type AcquisitionActionMessage,
  type ControlChange,
  type ControlSetMessage,
  type DeepCaptureReadyMessage,
  type DeepCaptureRequestMessage,
  type InteractionCommitMessage,
  type InteractiveControl,
  type InteractionUpdateMessage,
  type MeasurementReadMessage,
  type MeasurementResultMessage,
  type MeasurementSetMessage,
  type NonEmptyArray,
  type ScopeSleepMessage,
  type ServerJsonMessage,
  type WaveformViewportRequestMessage,
} from "../shared/websocket-protocol.js";
import { AppConnection } from "./app-connection.js";
import { AppTransportKind, useAppTransportStore } from "./app-transport-store.js";
import { useScopeStore } from "./scope-store.js";
import type { DeepViewportRequest, WaveformController } from "./waveform/waveform-controller.js";
import { decodeWaveformFrame } from "./waveform/waveform-frame-decoder.js";

const MAX_BINARY_ERRORS = 3;

export class ScopeBinding {
  private active = false;
  private binaryErrors = 0;
  private measurementInFlight = false;
  private readonly stopJsonListening: () => void;
  private readonly stopBinaryListening: () => void;
  private readonly stopFailureListening: () => void;
  private readonly stopTransportListening: () => void;

  public constructor(
    private readonly connection: AppConnection,
    private readonly waveforms: WaveformController,
  ) {
    this.stopJsonListening = connection.onJsonMessage((message) => this.handleJson(message));
    this.stopBinaryListening = connection.onBinaryMessage((data) => this.handleBinary(data));
    this.stopFailureListening = connection.onUnhandledFailure((message) => {
      if (!this.active) {
        return;
      }
      this.waveforms.viewportRequestFailed(message.requestId);
      useScopeStore.getState().setError(message.error);
    });
    this.stopTransportListening = useAppTransportStore.subscribe((state) => {
      if (!this.active || state.transport.kind === AppTransportKind.Connected) {
        return;
      }
      this.resetForTransportLoss();
    });
  }

  public activate(): void {
    if (this.active) {
      return;
    }
    this.active = true;
    this.waveforms.resetSession();
    useScopeStore.getState().setAwaitingInstrument();
    this.connection.subscribeInstrument(SupportedInstrument.Dho804);
  }

  public deactivate(): void {
    if (!this.active) {
      return;
    }
    this.active = false;
    this.connection.unsubscribeInstrument(SupportedInstrument.Dho804);
    this.waveforms.resetSession();
    useScopeStore.getState().clearDeepCapture();
    useScopeStore.getState().setAwaitingInstrument();
  }

  public dispose(): void {
    this.deactivate();
    this.stopJsonListening();
    this.stopBinaryListening();
    this.stopFailureListening();
    this.stopTransportListening();
  }

  public setControl(control: ControlChange): Promise<void> {
    return this.sendCommand((requestId): ControlSetMessage => ({
      type: MessageType.ControlSet,
      requestId,
      control,
    }));
  }

  public interactionUpdate(control: InteractiveControl): void {
    const message: InteractionUpdateMessage = {
      type: MessageType.InteractionUpdate,
      control,
    };
    this.connection.send(message);
  }

  public interactionCommit(control: InteractiveControl): Promise<void> {
    return this.sendCommand((requestId): InteractionCommitMessage => ({
      type: MessageType.InteractionCommit,
      requestId,
      control,
    }));
  }

  public acquisition(action: AcquisitionAction): Promise<void> {
    if (action === AcquisitionAction.Run || action === AcquisitionAction.Single) {
      this.retireDeepCapture();
    }
    return this.sendCommand((requestId): AcquisitionActionMessage => ({
      type: MessageType.AcquisitionAction,
      requestId,
      action,
    }));
  }

  public sleep(): Promise<void> {
    return this.sendCommand((requestId): ScopeSleepMessage => ({
      type: MessageType.ScopeSleep,
      requestId,
    }));
  }

  public async deepCapture(): Promise<DeepCaptureReadyMessage> {
    try {
      const response = await this.connection.request(
        (requestId): DeepCaptureRequestMessage => ({
          type: MessageType.DeepCaptureRequest,
          requestId,
        }),
        (requestId) => useScopeStore.getState().setDeepCapturing(requestId),
      );
      if (response.type !== MessageType.DeepCaptureReady) {
        throw new Error("Unexpected response to deep capture request");
      }
      useScopeStore.getState().setDeepReady(response.captureId, response.channels);
      this.waveforms.setDeepCapture(response.captureId);
      return response;
    } catch (error) {
      useScopeStore.getState().clearDeepCapture();
      throw error;
    }
  }

  public requestViewport(request: DeepViewportRequest): number {
    return this.connection.sendWithRequestId(
      (requestId): WaveformViewportRequestMessage => ({
        type: MessageType.WaveformViewportRequest,
        requestId,
        ...request,
      }),
    );
  }

  public async readMeasurements(
    measurements: NonEmptyArray<MeasurementSpec>,
  ): Promise<MeasurementResultMessage> {
    const response = await this.connection.request(
      (requestId): MeasurementReadMessage => ({
        type: MessageType.MeasurementRead,
        requestId,
        measurements,
      }),
    );
    if (response.type !== MessageType.MeasurementResult) {
      throw new Error("Unexpected response to measurement request");
    }
    return response;
  }

  public setMeasurements(measurements: MeasurementSpec[]): Promise<void> {
    return this.sendCommand((requestId): MeasurementSetMessage => ({
      type: MessageType.MeasurementSet,
      requestId,
      measurements,
    }));
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

  private handleJson(message: ServerJsonMessage): void {
    if (!this.active) {
      return;
    }

    const store = useScopeStore.getState();
    switch (message.type) {
      case MessageType.ScopeConnected:
        this.requireProtocolVersion(message.protocolVersion);
        this.waveforms.resetSession();
        this.binaryErrors = 0;
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
      default:
        return;
    }
  }

  private handleBinary(data: ArrayBuffer): void {
    if (!this.active) {
      return;
    }

    try {
      const frame = decodeWaveformFrame(data);
      this.binaryErrors = 0;
      this.waveforms.acceptFrame(frame);
    } catch (error) {
      this.binaryErrors += 1;
      this.surfaceError(error);
      if (this.binaryErrors >= MAX_BINARY_ERRORS) {
        this.connection.close(1002, "Repeated malformed waveform frames");
      }
    }
  }

  private resetForTransportLoss(): void {
    this.waveforms.resetSession();
    useScopeStore.getState().setAwaitingInstrument();
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
    buildMessage: (requestId: number) =>
      | ControlSetMessage
      | InteractionCommitMessage
      | AcquisitionActionMessage
      | ScopeSleepMessage
      | MeasurementSetMessage,
  ): Promise<void> {
    return this.connection.request(buildMessage).then((response) => {
      if (response.type !== MessageType.CommandCompleted) {
        throw new Error("Unexpected command response");
      }
    });
  }

  private requireProtocolVersion(protocolVersion: number): void {
    if (protocolVersion !== PROTOCOL_VERSION) {
      throw new Error(
        `Protocol version mismatch: server ${protocolVersion}, browser ${PROTOCOL_VERSION}`,
      );
    }
  }

  private surfaceError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    console.error(error);
    useScopeStore.getState().setError(message);
  }
}

export { AcquisitionAction };
