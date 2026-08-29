import { useEffect } from "react";

import type {
  DmmControlChange,
  DmmReadingSnapshot,
} from "../../shared/dmm-types.js";
import { SupportedInstrument } from "../../shared/instrument-types.js";
import { MessageType } from "../../shared/websocket-protocol.js";
import { DmmControls } from "../components/dmm/dmm-controls.js";
import { DmmReading } from "../components/dmm/dmm-reading.js";
import { ScpiConsole } from "../components/scpi-console.js";
import {
  BrowserTransportKind,
  type ScopeWebSocketClient,
} from "../websocket-client.js";
import "./dmm.css";
import {
  DmmBrowserConnectionKind,
  type DmmBrowserConnection,
  useDmmStore,
} from "./dmm-store.js";

interface DmmRouteProps {
  client: ScopeWebSocketClient;
}

interface DmmRouteViewProps {
  client: ScopeWebSocketClient;
  connection: DmmBrowserConnection;
  latestReading: DmmReadingSnapshot | null;
  pending: boolean;
  controlError: string | null;
  onControl(control: DmmControlChange): void;
}

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

export function DmmRoute({ client }: DmmRouteProps) {
  const connection = useDmmStore((state) => state.connection);
  const latestReading = useDmmStore((state) => state.latestReading);
  const pendingControl = useDmmStore((state) => state.pendingControl);
  const controlError = useDmmStore((state) => state.controlError);

  useEffect(() => bindDmmRoute(client), [client]);

  const applyControl = async (control: DmmControlChange): Promise<void> => {
    useDmmStore.getState().beginControl(control);
    try {
      await client.setDmmControl(control);
      useDmmStore.getState().finishControl();
    } catch (error) {
      useDmmStore.getState().failControl(
        error instanceof Error ? error.message : String(error),
      );
    }
  };

  return (
    <DmmRouteView
      client={client}
      connection={connection}
      latestReading={latestReading}
      pending={pendingControl !== null}
      controlError={controlError}
      onControl={(control) => void applyControl(control)}
    />
  );
}

export function DmmRouteView({
  client,
  connection,
  latestReading,
  pending,
  controlError,
  onControl,
}: DmmRouteViewProps) {
  return (
    <>
      <header className="dmm-toolbar">
        <div>
          <strong>DM858E</strong>
          {connection.kind === DmmBrowserConnectionKind.Connected ? (
            <span className="dmm-identity">
              {connection.info.manufacturer} · {connection.info.serialNumber}
            </span>
          ) : null}
        </div>
        <span className="status-pill" aria-live="polite">{connectionLabel(connection)}</span>
      </header>

      {connection.kind === DmmBrowserConnectionKind.Connected ? (
        <>
          <div className="dmm-layout">
            <DmmReading state={connection.state} snapshot={latestReading} />
            <DmmControls
              state={connection.state}
              pending={pending}
              onControl={onControl}
            />
          </div>
          {controlError !== null ? (
            <div className="dmm-control-error" role="alert">
              Control rejected: {controlError}
            </div>
          ) : null}
          <div className="dmm-bottom">
            <ScpiConsole
              client={client}
              instrument={SupportedInstrument.Dm858e}
              placeholder="DATA:LAST?"
            />
          </div>
        </>
      ) : (
        <section className="empty-state dmm-route-shell">
          <div>
            <h1>DM858E</h1>
            <p>{connectionDetail(connection)}</p>
          </div>
        </section>
      )}
    </>
  );
}

function connectionLabel(connection: DmmBrowserConnection): string {
  switch (connection.kind) {
    case DmmBrowserConnectionKind.Connecting:
      return "Connecting";
    case DmmBrowserConnectionKind.AwaitingInstrument:
      return "Starting DMM";
    case DmmBrowserConnectionKind.TransportDisconnected:
      return "Transport offline";
    case DmmBrowserConnectionKind.InstrumentDisconnected:
      return "DMM offline";
    case DmmBrowserConnectionKind.Connected:
      return "Connected";
  }
}

function connectionDetail(connection: DmmBrowserConnection): string {
  switch (connection.kind) {
    case DmmBrowserConnectionKind.Connecting:
      return "Connecting to Rigol Web.";
    case DmmBrowserConnectionKind.AwaitingInstrument:
      return "Waiting for the DM858E runtime.";
    case DmmBrowserConnectionKind.TransportDisconnected:
      return `Rigol Web transport disconnected: ${connection.reason}`;
    case DmmBrowserConnectionKind.InstrumentDisconnected:
      return connection.reason;
    case DmmBrowserConnectionKind.Connected:
      return `${connection.info.model} connected.`;
  }
}
