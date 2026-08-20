import { ScopeRunState } from "../../shared/scope-types.js";
import { AcquisitionAction } from "../../shared/websocket-protocol.js";
import { BrowserConnectionKind, useScopeStore } from "../scope-store.js";
import type { ScopeWebSocketClient } from "../websocket-client.js";

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

export function ScopeToolbar({ client }: ScopeToolbarProps) {
  const connection = useScopeStore((state) => state.connection);
  const lastError = useScopeStore((state) => state.lastError);

  if (connection.kind !== BrowserConnectionKind.ScopeConnected) {
    const reason = "reason" in connection ? connection.reason : "Connecting";
    return (
      <header className="scope-toolbar">
        <strong>Rigol Web</strong>
        <span className="status-pill">{reason}</span>
        {lastError !== null ? <span className="error-text">{lastError}</span> : null}
      </header>
    );
  }

  const scope = connection.scope;
  const command = (action: AcquisitionAction) => {
    void client.acquisition(action).catch((error: unknown) => {
      useScopeStore.getState().setError(
        error instanceof Error ? error.message : String(error),
      );
    });
  };

  const deepCapture = async () => {
    try {
      await client.deepCapture();
    } catch (error) {
      useScopeStore.getState().setError(
        error instanceof Error ? error.message : String(error),
      );
    }
  };

  return (
    <header className="scope-toolbar">
      <strong>Rigol Web</strong>
      <span className="scope-identity">
        {connection.info.model} · {connection.info.serialNumber}
      </span>
      <span className="status-pill">{RUN_STATE_LABELS[scope.runState]}</span>
      <div className="toolbar-actions">
        <button type="button" onClick={() => command(AcquisitionAction.Run)}>Run</button>
        <button type="button" onClick={() => command(AcquisitionAction.Stop)}>Stop</button>
        <button type="button" onClick={() => command(AcquisitionAction.Single)}>Single</button>
        <button
          type="button"
          disabled={scope.runState !== ScopeRunState.Stopped}
          onClick={() => void deepCapture()}
        >
          Deep Capture
        </button>
      </div>
      {lastError !== null ? <span className="error-text">{lastError}</span> : null}
    </header>
  );
}
