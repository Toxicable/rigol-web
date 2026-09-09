import type { AcquisitionOperation } from "../../shared/acquisition-types.js";
import { SupportedInstrument } from "../../shared/instrument-types.js";
import type { Ppk2Viewport } from "../../shared/ppk2-types.js";
import {
  MessageType,
  PROTOCOL_VERSION,
  type Ppk2CaptureStartMessage,
  type Ppk2CaptureStopMessage,
  type Ppk2ViewportRequestMessage,
  type ServerJsonMessage,
} from "../../shared/websocket-protocol.js";
import { AppConnection } from "../app-connection.js";
import { AppTransportKind, useAppTransportStore } from "../app-transport-store.js";
import { usePpk2Store } from "./ppk2-store.js";

export class Ppk2Binding {
  private active = false;
  private readonly stopJsonListening: () => void;
  private readonly stopTransportListening: () => void;

  public constructor(private readonly connection: AppConnection) {
    this.stopJsonListening = connection.onJsonMessage((message) => this.handleJson(message));
    this.stopTransportListening = useAppTransportStore.subscribe((state) => {
      if (!this.active || state.transport.kind === AppTransportKind.Connected) {
        return;
      }
      usePpk2Store.getState().setAwaitingInstrument();
    });
  }

  public activate(): void {
    if (this.active) return;
    this.active = true;
    usePpk2Store.getState().setAwaitingInstrument();
    this.connection.subscribeInstrument(SupportedInstrument.Ppk2);
  }

  public deactivate(): void {
    if (!this.active) return;
    this.active = false;
    this.connection.unsubscribeInstrument(SupportedInstrument.Ppk2);
    usePpk2Store.getState().setAwaitingInstrument();
  }

  public dispose(): void {
    this.deactivate();
    this.stopJsonListening();
    this.stopTransportListening();
  }

  public async startCapture(): Promise<AcquisitionOperation> {
    const response = await this.connection.request((requestId): Ppk2CaptureStartMessage => ({
      type: MessageType.Ppk2CaptureStart,
      requestId,
    }));
    if (response.type !== MessageType.AcquisitionOperationResult) {
      throw new Error("Unexpected PPK2 capture-start response");
    }
    return response.operation;
  }

  public async stopCapture(operationId: number): Promise<AcquisitionOperation> {
    const response = await this.connection.request((requestId): Ppk2CaptureStopMessage => ({
      type: MessageType.Ppk2CaptureStop,
      requestId,
      operationId,
    }));
    if (response.type !== MessageType.AcquisitionOperationResult) {
      throw new Error("Unexpected PPK2 capture-stop response");
    }
    return response.operation;
  }

  public async requestViewport(
    operationId: number,
    firstSequence: number,
    endSequenceExclusive: number,
    maxBuckets: number,
  ): Promise<Ppk2Viewport> {
    const response = await this.connection.request((requestId): Ppk2ViewportRequestMessage => ({
      type: MessageType.Ppk2ViewportRequest,
      requestId,
      operationId,
      firstSequence,
      endSequenceExclusive,
      maxBuckets,
    }));
    if (response.type !== MessageType.Ppk2ViewportResult) {
      throw new Error("Unexpected PPK2 viewport response");
    }
    return response.viewport;
  }

  private handleJson(message: ServerJsonMessage): void {
    if (!this.active) return;

    const store = usePpk2Store.getState();
    switch (message.type) {
      case MessageType.Ppk2Connected:
        this.requireProtocolVersion(message.protocolVersion);
        store.setConnected(message.info);
        return;
      case MessageType.Ppk2Disconnected:
        store.setInstrumentDisconnected(message.reason);
        return;
      case MessageType.Ppk2Stats:
        store.replaceStats(message.stats);
        return;
      case MessageType.Ppk2Live:
        store.appendLive(message.update);
        return;
      default:
        return;
    }
  }

  private requireProtocolVersion(protocolVersion: number): void {
    if (protocolVersion !== PROTOCOL_VERSION) {
      throw new Error(
        `Protocol version mismatch: server ${protocolVersion}, browser ${PROTOCOL_VERSION}`,
      );
    }
  }
}
