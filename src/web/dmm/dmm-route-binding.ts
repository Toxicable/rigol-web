import { SupportedInstrument } from "../../shared/instrument-types.js";
import { MessageType } from "../../shared/websocket-protocol.js";
import {
  BrowserTransportKind,
  type ScopeWebSocketClient,
} from "../websocket-client.js";
import { useDmmStore } from "./dmm-store.js";

export type DmmLifecycleClient = Pick<
  ScopeWebSocketClient,
  "onTransportState" | "onDmmMessage" | "subscribeInstrument" | "unsubscribeInstrument"
>;

export function bindDmmRoute(client: DmmLifecycleClient): () => void {
  useDmmStore.getState().setConnecting();

  const stopTransportListening = client.onTransportState((transport) => {
    switch (transport.kind) {
      case BrowserTransportKind.Connecting:
        useDmmStore.getState().setConnecting();
        return;
      case BrowserTransportKind.Connected:
        useDmmStore.getState().setAwaitingInstrument();
        return;
      case BrowserTransportKind.Disconnected:
        useDmmStore.getState().setTransportDisconnected(transport.reason);
        return;
    }
  });

  const stopDmmListening = client.onDmmMessage((message) => {
    switch (message.type) {
      case MessageType.DmmConnected:
        useDmmStore.getState().setConnected(message.info, message.state);
        return;
      case MessageType.DmmState:
        useDmmStore.getState().replaceState(message.state);
        return;
      case MessageType.DmmDisconnected:
        useDmmStore.getState().setInstrumentDisconnected(message.reason);
        return;
      case MessageType.DmmSnapshot:
        useDmmStore.getState().setLatestReading(message.snapshot);
        return;
    }
  });

  client.subscribeInstrument(SupportedInstrument.Dm858e);

  return () => {
    client.unsubscribeInstrument(SupportedInstrument.Dm858e);
    stopDmmListening();
    stopTransportListening();
    useDmmStore.getState().setAwaitingInstrument();
  };
}
