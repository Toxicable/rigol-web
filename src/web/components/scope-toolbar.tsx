import { ScopeRunState } from "../../shared/scope-types.js";
import { AcquisitionAction } from "../../shared/websocket-protocol.js";
import { BrowserConnectionKind, useScopeStore } from "../scope-store.js";
import type { ScopeWebSocketClient } from "../websocket-client.js";
import { InstrumentHeader } from "./instrument-header.js";

const RUN_STATE_LABELS: Record<ScopeRunState, string> = {
  [ScopeRunState.Triggered]: "T'D",
  [ScopeRunState.Waiting]: "WAIT",
  [ScopeRunState.Running]: "RUN",
  [ScopeRunState.Auto]: "AUTO",
  [ScopeRunState.Stopped]: "STOP",
};

interface ScopeToolbarProps {
  client: ScopeWebSocketClient;
}

function surfaceError(error: unknown): void {
  useScopeStore.getState().setError(
    error instanceof Error ? error.message : String(error),
  );
}

export function ScopeToolbar({ client }: ScopeToolbarProps) {
  const connection = useScopeStore((state) => state.connection);
  const lastError = useScopeStore((state) => state.lastError);

  if (connection.kind !== BrowserConnectionKind.ScopeConnected) {
    const reason = "reason" in connection ? connection.reason : "Connecting";
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

  const sleep = async () => {
    try {
      const response = await fetch("/api/scope/sleep", { method: "POST" });
      if (!response.ok) {
        const detail = (await response.text()).trim();
        throw new Error(detail || `Sleep request failed with HTTP ${response.status}`);
      }
    } catch (error) {
      surfaceError(error);
    }
  };

  return (
    <InstrumentHeader>
      <div className="scope-toolbar-content">
        <span className="scope-identity">
          {connection.info.model} · {connection.info.serialNumber}
        </span>
        <span className="status-pill">{RUN_STATE_LABELS[scope.runState]}</span>
        <div className="toolbar-actions">
          <button
            type="button"
            className={stopped ? "acquisition-state-button" : "acquisition-state-button is-running"}
            aria-pressed={!stopped}
            onClick={() => command(AcquisitionAction.Run)}
          >
            Run
          </button>
          <button
            type="button"
            className={stopped ? "acquisition-state-button is-stopped" : "acquisition-state-button"}
            aria-pressed={stopped}
            onClick={() => command(AcquisitionAction.Stop)}
          >
            Stop
          </button>
          <button type="button" onClick={() => command(AcquisitionAction.Single)}>Single</button>
          <button
            type="button"
            disabled={!stopped}
            onClick={() => void deepCapture()}
          >
            Deep Capture
          </button>
          <button type="button" onClick={() => void sleep()}>Sleep</button>
        </div>
        {lastError !== null ? <span className="error-text">{lastError}</span> : null}
      </div>
    </InstrumentHeader>
  );
}
