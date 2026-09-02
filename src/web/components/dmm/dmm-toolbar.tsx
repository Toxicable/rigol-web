import type { DmmBrowserConnection } from "../../dmm/dmm-store.js";
import { DmmBrowserConnectionKind } from "../../dmm/dmm-store.js";
import { InstrumentHeader } from "../instrument-header.js";

interface DmmToolbarProps {
  connection: DmmBrowserConnection;
}

export function DmmToolbar({ connection }: DmmToolbarProps) {
  return (
    <InstrumentHeader>
      <div className="scope-toolbar-content">
        <span className="status-pill" aria-live="polite">
          {connectionLabel(connection)}
        </span>
        {connection.kind === DmmBrowserConnectionKind.Connected ? (
          <span className="dmm-identity">
            {connection.info.manufacturer} · {connection.info.serialNumber}
          </span>
        ) : null}
      </div>
    </InstrumentHeader>
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
