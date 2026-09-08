import { useState } from "react";

import { ScopeRunState, TimebaseMode } from "../../shared/scope-types.js";
import { AcquisitionAction } from "../../shared/websocket-protocol.js";
import { AppTransportKind, useAppTransportStore } from "../app-transport-store.js";
import type { ScopeBinding } from "../scope-binding.js";
import { BrowserConnectionKind, useScopeStore } from "../scope-store.js";
import { InstrumentHeader } from "./instrument-header.js";

const RUN_STATE_LABELS: Record<ScopeRunState, string> = {
  [ScopeRunState.Triggered]: "Triggered",
  [ScopeRunState.Waiting]: "Waiting",
  [ScopeRunState.Running]: "Running",
  [ScopeRunState.Auto]: "Auto",
  [ScopeRunState.Stopped]: "Stopped",
};

interface ScopeToolbarProps {
  client: ScopeBinding;
}

function surfaceError(error: unknown): void {
  useScopeStore.getState().setError(
    error instanceof Error ? error.message : String(error),
  );
}

export function ScopeToolbar({ client }: ScopeToolbarProps) {
  const transport = useAppTransportStore((state) => state.transport);
  const connection = useScopeStore((state) => state.connection);
  const lastError = useScopeStore((state) => state.lastError);
  const [sleepPending, setSleepPending] = useState(false);
  const connected =
    transport.kind === AppTransportKind.Connected &&
    connection.kind === BrowserConnectionKind.ScopeConnected;

  const runSleep = async () => {
    if (sleepPending) {
      return;
    }
    setSleepPending(true);
    try {
      await client.sleep();
    } catch (error) {
      surfaceError(error);
    } finally {
      setSleepPending(false);
    }
  };

  if (!connected) {
    let reason = "Waiting for DHO804";
    if (transport.kind === AppTransportKind.Connecting) {
      reason = "Connecting";
    } else if (transport.kind === AppTransportKind.Disconnected) {
      reason = transport.reason;
    } else if (connection.kind === BrowserConnectionKind.ScopeDisconnected) {
      reason = connection.reason;
    }
    return (
      <InstrumentHeader>
        <div className="scope-toolbar-content">
          <span className="status-pill">{reason}</span>
          {lastError !== null ? <span className="error-text">{lastError}</span> : null}
        </div>
      </InstrumentHeader>
    );
  }

  const scope = connection.scope;
  const stopped = scope.runState === ScopeRunState.Stopped;
  const singleDisabled = scope.horizontal.mode === TimebaseMode.Roll;
  const command = (action: AcquisitionAction) => {
    void client.acquisition(action).catch(surfaceError);
  };

  const deepCapture = async () => {
    try {
      await client.deepCapture();
    } catch (error) {
      surfaceError(error);
    }
  };

  return (
    <InstrumentHeader>
      <div className="scope-toolbar-content">
        <span className="status-pill">{RUN_STATE_LABELS[scope.runState]}</span>
        <div className="toolbar-actions">
          <button
            type="button"
            className={stopped ? "acquisition-state-button is-stopped" : "acquisition-state-button is-running"}
            onClick={() => command(stopped ? AcquisitionAction.Run : AcquisitionAction.Stop)}
          >
            {stopped ? "Run" : "Stop"}
          </button>
          <button
            type="button"
            disabled={singleDisabled}
            title={singleDisabled ? "Single acquisition is unavailable in Roll mode" : undefined}
            onClick={() => command(AcquisitionAction.Single)}
          >
            Single
          </button>
          <button
            type="button"
            disabled={!stopped}
            onClick={() => void deepCapture()}
          >
            Deep Capture
          </button>
          <button type="button" disabled={sleepPending} onClick={() => void runSleep()}>
            Sleep
          </button>
        </div>
        {lastError !== null ? <span className="error-text">{lastError}</span> : null}
      </div>
    </InstrumentHeader>
  );
}
