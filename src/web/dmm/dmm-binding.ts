import type { DmmControlChange } from "../../shared/dmm-types.js";
import { SupportedInstrument } from "../../shared/instrument-types.js";
import {
  MessageType,
  PROTOCOL_VERSION,
  type DmmControlSetMessage,
  type ServerJsonMessage,
} from "../../shared/websocket-protocol.js";
import { AppConnection } from "../app-connection.js";
import { AppTransportKind, useAppTransportStore } from "../app-transport-store.js";
import { useDmmStore } from "./dmm-store.js";

export class DmmBinding {
  private active = false;
  private readonly stopJsonListening: () => void;
  private readonly stopTransportListening: () => void;

  public constructor(private readonly connection: AppConnection) {
    this.stopJsonListening = connection.onJsonMessage((message) => this.handleJson(message));
    this.stopTransportListening = useAppTransportStore.subscribe((state) => {
      if (!this.active || state.transport.kind === AppTransportKind.Connected) {
        return;
      }
      useDmmStore.getState().setAwaitingInstrument();
    });
  }

  public activate(): void {
    if (this.active) {
      return;
    }
    this.active = true;
    useDmmStore.getState().setAwaitingInstrument();
    this.connection.subscribeInstrument(SupportedInstrument.Dm858e);
  }

  public deactivate(): void {
    if (!this.active) {
      return;
    }
    this.active = false;
    this.connection.unsubscribeInstrument(SupportedInstrument.Dm858e);
    useDmmStore.getState().setAwaitingInstrument();
  }

  public dispose(): void {
    this.deactivate();
    this.stopJsonListening();
    this.stopTransportListening();
  }

  public setDmmControl(control: DmmControlChange): Promise<void> {
    return this.connection.request((requestId): DmmControlSetMessage => ({
      type: MessageType.DmmControlSet,
      requestId,
      control,
    })).then((response) => {
      if (response.type !== MessageType.CommandCompleted) {
        throw new Error("Unexpected command response");
      }
    });
  }

  public executeScpi(command: string): Promise<string> {
    return this.connection.executeScpi(SupportedInstrument.Dm858e, command);
  }

  private handleJson(message: ServerJsonMessage): void {
    if (!this.active) {
      return;
    }

    const store = useDmmStore.getState();
    switch (message.type) {
      case MessageType.DmmConnected:
        this.requireProtocolVersion(message.protocolVersion);
        store.setConnected(message.info, message.state);
        return;
      case MessageType.DmmState:
        store.replaceState(message.state);
        return;
      case MessageType.DmmDisconnected:
        store.setInstrumentDisconnected(message.reason);
        return;
      case MessageType.DmmSnapshot:
        store.setLatestReading(message.snapshot);
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
