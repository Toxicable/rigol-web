import { useEffect, useState } from "react";

import type {
  DmmAcquisitionRate,
  DmmMeasurementFunction,
  DmmRange,
  DmmReadingSnapshot,
} from "../../shared/dmm-types.js";
import { AppTransportKind, type AppTransportState, useAppTransportStore } from "../app-transport-store.js";
import { DmmControls } from "../components/dmm/dmm-controls.js";
import {
  DEFAULT_DMM_TREND_HORIZONTAL,
  DmmHorizontalControls,
} from "../components/dmm/dmm-horizontal-controls.js";
import { DmmReading } from "../components/dmm/dmm-reading.js";
import { DmmToolbar } from "../components/dmm/dmm-toolbar.js";
import { DmmTrend } from "../components/dmm/dmm-trend.js";
import "./dmm.css";
import type { DmmActions } from "./dmm-actions.js";
import type { DmmBinding } from "./dmm-binding.js";
import { bindDmmRoute } from "./dmm-route-binding.js";
import {
  DmmBrowserConnectionKind,
  type DmmBrowserConnection,
  useDmmStore,
} from "./dmm-store.js";

interface DmmRouteProps {
  binding: DmmBinding;
  actions: DmmActions;
}

interface DmmRouteViewProps {
  transport: AppTransportState;
  connection: DmmBrowserConnection;
  latestReading: DmmReadingSnapshot | null;
  pending: boolean;
  controlError: string | null;
  onFunction(value: DmmMeasurementFunction): void;
  onRange(value: DmmRange): void;
  onAcquisitionRate(value: DmmAcquisitionRate): void;
}

export function DmmRoute({ binding, actions }: DmmRouteProps) {
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
      onFunction={(value) => {
        void actions.setFunction(value);
      }}
      onRange={(value) => {
        void actions.setRange(value);
      }}
      onAcquisitionRate={(value) => {
        void actions.setAcquisitionRate(value);
      }}
    />
  );
}

export function DmmRouteView({
  transport,
  connection,
  latestReading,
  pending,
  controlError,
  onFunction,
  onRange,
  onAcquisitionRate,
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
      <DmmToolbar transport={transport} connection={connection} />

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
                onFunction={onFunction}
                onRange={onRange}
                onAcquisitionRate={onAcquisitionRate}
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
