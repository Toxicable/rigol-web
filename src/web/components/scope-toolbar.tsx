import { ScopeRunState } from "../../shared/scope-types.js";
import { AcquisitionAction } from "../../shared/websocket-protocol.js";
import { BrowserConnectionKind, useScopeStore } from "../scope-store.js";
import type { ScopeWebSocketClient } from "../websocket-client.js";
import { InstrumentHeader } from "./instrument-header.js";

const RUN_STATE_LABELS: Record<ScopeRunState, string> = {
  [ScopeRunState.Triggered]: "Triggered",
  [ScopeRunState.Waiting]: "Waiting",
  [ScopeRunState.Running]: "Running",
  [ScopeRunState.Auto]: "Auto",
  [ScopeRunState.Stopped]: "Stopped",
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

  const powerAction = async (action: "sleep" | "wake") => {
    try {
      const response = await fetch(`/api/scope/${action}`, { method: "POST" });
      if (!response.ok) {
        const detail = (await response.text()).trim();
        throw new Error(detail || `${action} request failed with HTTP ${response.status}`);
      }
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
            className={stopped ? "acquisition-state-button is-running" : "acquisition-state-button is-stopped"}
            onClick={() => command(stopped ? AcquisitionAction.Run : AcquisitionAction.Stop)}
          >
            {stopped ? "Run" : "Stop"}
          </button>
          <button type="button" onClick={() => command(AcquisitionAction.Single)}>Single</button>
          <button
            type="button"
            disabled={!stopped}
            onClick={() => void deepCapture()}
          >
            Deep Capture
          </button>
          <button type="button" onClick={() => void powerAction("sleep")}>Sleep</button>
          <button type="button" onClick={() => void powerAction("wake")}>Wake</button>
        </div>
        {lastError !== null ? <span className="error-text">{lastError}</span> : null}
      </div>
    </InstrumentHeader>
  );
}
