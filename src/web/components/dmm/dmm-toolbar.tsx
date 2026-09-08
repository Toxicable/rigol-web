import {
  AppTransportKind,
  type AppTransportState,
} from "../../app-transport-store.js";
import type { DmmBrowserConnection } from "../../dmm/dmm-store.js";
import { DmmBrowserConnectionKind } from "../../dmm/dmm-store.js";
import { InstrumentHeader } from "../instrument-header.js";

interface DmmToolbarProps {
  transport: AppTransportState;
  connection: DmmBrowserConnection;
}

export function DmmToolbar({ transport, connection }: DmmToolbarProps) {
  return (
    <InstrumentHeader>
      <div className="scope-toolbar-content">
        <span className="status-pill" aria-live="polite">
          {connectionLabel(transport, connection)}
        </span>
        {transport.kind === AppTransportKind.Connected &&
        connection.kind === DmmBrowserConnectionKind.Connected ? (
          <span className="dmm-identity">
            {connection.info.manufacturer} · {connection.info.serialNumber}
          </span>
        ) : null}
      </div>
    </InstrumentHeader>
  );
}

function connectionLabel(
  transport: AppTransportState,
  connection: DmmBrowserConnection,
): string {
  switch (transport.kind) {
    case AppTransportKind.Connecting:
      return "Connecting";
    case AppTransportKind.Disconnected:
      return "Transport offline";
    case AppTransportKind.Connected:
      break;
  }

  switch (connection.kind) {
    case DmmBrowserConnectionKind.AwaitingInstrument:
      return "Starting DMM";
    case DmmBrowserConnectionKind.InstrumentDisconnected:
      return "DMM offline";
    case DmmBrowserConnectionKind.Connected:
      return "Connected";
  }
}
