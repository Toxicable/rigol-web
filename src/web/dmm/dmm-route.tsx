import { useEffect, useState } from "react";

import type {
  DmmControlChange,
  DmmReadingSnapshot,
} from "../../shared/dmm-types.js";
import { AppTransportKind, type AppTransportState, useAppTransportStore } from "../app-transport-store.js";
import {
  DmmControls,
  dmmControlMatchesState,
} from "../components/dmm/dmm-controls.js";
import {
  DEFAULT_DMM_TREND_HORIZONTAL,
  DmmHorizontalControls,
} from "../components/dmm/dmm-horizontal-controls.js";
import { DmmReading } from "../components/dmm/dmm-reading.js";
import { DmmToolbar } from "../components/dmm/dmm-toolbar.js";
import { DmmTrend } from "../components/dmm/dmm-trend.js";
import "./dmm.css";
import type { DmmBinding } from "./dmm-binding.js";
import { bindDmmRoute } from "./dmm-route-binding.js";
import {
  DmmBrowserConnectionKind,
  type DmmBrowserConnection,
  useDmmStore,
} from "./dmm-store.js";

interface DmmRouteProps {
  binding: DmmBinding;
}

interface DmmRouteViewProps {
  transport: AppTransportState;
  connection: DmmBrowserConnection;
  latestReading: DmmReadingSnapshot | null;
  pending: boolean;
  controlError: string | null;
  onControl(control: DmmControlChange): void;
}

export type DmmControlClient = Pick<DmmBinding, "setDmmControl">;

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

export function DmmRoute({ binding }: DmmRouteProps) {
  const transport = useAppTransportStore((state) => state.transport);
  const connection = useDmmStore((state) => state.connection);
  const latestReading = useDmmStore((state) => state.latestReading);
  const pendingControl = useDmmStore((state) => state.pendingControl);
  const controlError = useDmmStore((state) => state.controlError);

  useEffect(() => bindDmmRoute(binding), [binding]);

  return (
    <DmmRouteView
      transport={transport}
      connection={connection}
      latestReading={latestReading}
      pending={pendingControl !== null}
      controlError={controlError}
      onControl={(control) => void applyDmmControl(binding, control)}
    />
  );
}

export function DmmRouteView({
  transport,
  connection,
  latestReading,
  pending,
  controlError,
  onControl,
}: DmmRouteViewProps) {
  const measurementFunction = connection.kind === DmmBrowserConnectionKind.Connected
    ? connection.state.function
    : null;
  const [trendHorizontal, setTrendHorizontal] = useState(DEFAULT_DMM_TREND_HORIZONTAL);

  useEffect(() => {
    setTrendHorizontal((current) => ({ ...current, position: 0 }));
  }, [measurementFunction]);

  const connected =
    transport.kind === AppTransportKind.Connected &&
    connection.kind === DmmBrowserConnectionKind.Connected;

  return (
    <section className="dmm-route">
      <DmmToolbar connection={connection} />

      {connected ? (
        <>
          <div className="dmm-layout">
            <div className="dmm-measurement-column">
              <DmmReading state={connection.state} snapshot={latestReading} />
              <DmmTrend
                measurementFunction={connection.state.function}
                range={connection.state.range}
                snapshot={latestReading}
                horizontal={trendHorizontal}
              />
            </div>
            <aside className="control-stack">
              <DmmControls
                state={connection.state}
                pending={pending}
                onControl={onControl}
              />
              <DmmHorizontalControls
                horizontal={trendHorizontal}
                onChange={setTrendHorizontal}
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
            <p>{connectionDetail(transport, connection)}</p>
          </div>
        </section>
      )}
    </section>
  );
}

function connectionDetail(
  transport: AppTransportState,
  connection: DmmBrowserConnection,
): string {
  switch (transport.kind) {
    case AppTransportKind.Connecting:
      return "Connecting to Rigol Web.";
    case AppTransportKind.Disconnected:
      return `Rigol Web transport disconnected: ${transport.reason}`;
    case AppTransportKind.Connected:
      break;
  }

  switch (connection.kind) {
    case DmmBrowserConnectionKind.AwaitingInstrument:
      return "Waiting for the DM858E runtime.";
    case DmmBrowserConnectionKind.InstrumentDisconnected:
      return connection.reason;
    case DmmBrowserConnectionKind.Connected:
      return `${connection.info.model} connected.`;
  }
}
