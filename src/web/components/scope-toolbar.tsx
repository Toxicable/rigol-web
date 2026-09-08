import { ScopeRunState, TimebaseMode } from "../../shared/scope-types.js";
import { AppTransportKind, useAppTransportStore } from "../app-transport-store.js";
import type { ScopeActions } from "../scope-actions.js";
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
  actions: ScopeActions;
}

export function ScopeToolbar({ actions }: ScopeToolbarProps) {
  const transport = useAppTransportStore((state) => state.transport);
  const connection = useScopeStore((state) => state.connection);
  const sleepPending = useScopeStore((state) => state.sleepPending);
  const lastError = useScopeStore((state) => state.lastError);
  const connected =
    transport.kind === AppTransportKind.Connected &&
    connection.kind === BrowserConnectionKind.ScopeConnected;

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

  return (
    <InstrumentHeader>
      <div className="scope-toolbar-content">
        <span className="status-pill">{RUN_STATE_LABELS[scope.runState]}</span>
        <div className="toolbar-actions">
          <button
            type="button"
            className={stopped ? "acquisition-state-button is-stopped" : "acquisition-state-button is-running"}
            onClick={() => {
              void (stopped ? actions.run() : actions.stop());
            }}
          >
            {stopped ? "Run" : "Stop"}
          </button>
          <button
            type="button"
            disabled={singleDisabled}
            title={singleDisabled ? "Single acquisition is unavailable in Roll mode" : undefined}
            onClick={() => {
              void actions.single();
            }}
          >
            Single
          </button>
          <button
            type="button"
            disabled={!stopped}
            onClick={() => {
              void actions.deepCapture();
            }}
          >
            Deep Capture
          </button>
          <button
            type="button"
            disabled={sleepPending}
            onClick={() => {
              void actions.sleep();
            }}
          >
            Sleep
          </button>
        </div>
        {lastError !== null ? <span className="error-text">{lastError}</span> : null}
      </div>
    </InstrumentHeader>
  );
}
