import { useEffect } from "react";

import type {
  DmmControlChange,
  DmmReadingSnapshot,
} from "../../shared/dmm-types.js";
import {
  DmmControls,
  dmmControlMatchesState,
} from "../components/dmm/dmm-controls.js";
import { DmmReading } from "../components/dmm/dmm-reading.js";
import { DmmToolbar } from "../components/dmm/dmm-toolbar.js";
import { DmmTrend } from "../components/dmm/dmm-trend.js";
import type { ScopeWebSocketClient } from "../websocket-client.js";
import "./dmm.css";
import { bindDmmRoute } from "./dmm-route-binding.js";
import {
  DmmBrowserConnectionKind,
  type DmmBrowserConnection,
  useDmmStore,
} from "./dmm-store.js";

interface DmmRouteProps {
  client: ScopeWebSocketClient;
}

interface DmmRouteViewProps {
  connection: DmmBrowserConnection;
  latestReading: DmmReadingSnapshot | null;
  pending: boolean;
  controlError: string | null;
  onControl(control: DmmControlChange): void;
}

export type DmmControlClient = Pick<ScopeWebSocketClient, "setDmmControl">;

export async function applyDmmControl(
  client: DmmControlClient,
  control: DmmControlChange,
): Promise<void> {
  const store = useDmmStore.getState();
  if (
    store.connection.kind === DmmBrowserConnectionKind.Connected &&
    dmmControlMatchesState(store.connection.state, control)
  ) {
    return;
  }

  const ownership = store.beginControl(control);
  try {
    await client.setDmmControl(control);
    useDmmStore.getState().finishControl(ownership);
  } catch (error) {
    useDmmStore.getState().failControl(
      ownership,
      error instanceof Error ? error.message : String(error),
    );
  }
}

export function DmmRoute({ client }: DmmRouteProps) {
  const connection = useDmmStore((state) => state.connection);
  const latestReading = useDmmStore((state) => state.latestReading);
  const pendingControl = useDmmStore((state) => state.pendingControl);
  const controlError = useDmmStore((state) => state.controlError);

  useEffect(() => bindDmmRoute(client), [client]);

  return (
    <DmmRouteView
      connection={connection}
      latestReading={latestReading}
      pending={pendingControl !== null}
      controlError={controlError}
      onControl={(control) => void applyDmmControl(client, control)}
    />
  );
}

export function DmmRouteView({
  connection,
  latestReading,
  pending,
  controlError,
  onControl,
}: DmmRouteViewProps) {
  return (
    <section className="dmm-route">
      <DmmToolbar connection={connection} />

      {connection.kind === DmmBrowserConnectionKind.Connected ? (
        <>
          <div className="dmm-layout">
            <div className="dmm-measurement-column">
              <DmmReading state={connection.state} snapshot={latestReading} />
              <DmmTrend
                measurementFunction={connection.state.function}
                snapshot={latestReading}
              />
            </div>
            <aside className="control-stack">
              <DmmControls
                state={connection.state}
                pending={pending}
                onControl={onControl}
              />
            </aside>
          </div>
          {controlError !== null ? (
            <div className="dmm-control-error" role="alert">
              Control rejected: {controlError}
            </div>
          ) : null}
        </>
      ) : (
        <section className="empty-state dmm-route-shell">
          <div>
            <h1>DM858E</h1>
            <p>{connectionDetail(connection)}</p>
          </div>
        </section>
      )}
    </section>
  );
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
