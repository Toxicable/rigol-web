import { useState } from "react";

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

const MAX_API_ERROR_DETAIL_LENGTH = 240;

type ScopePowerAction = "sleep" | "wake";

interface ScopeToolbarProps {
  client: ScopeWebSocketClient;
}

function surfaceError(error: unknown): void {
  useScopeStore.getState().setError(
    error instanceof Error ? error.message : String(error),
  );
}

async function powerActionError(action: ScopePowerAction, response: Response): Promise<Error> {
  const fallback = `${action} request failed with HTTP ${response.status}`;
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("text/plain")) {
    return new Error(fallback);
  }

  const detail = (await response.text()).trim();
  if (detail.length === 0 || detail.length > MAX_API_ERROR_DETAIL_LENGTH) {
    return new Error(fallback);
  }
  return new Error(detail);
}

async function powerAction(action: ScopePowerAction): Promise<boolean> {
  try {
    const response = await fetch(`/api/scope/${action}`, { method: "POST" });
    if (!response.ok) {
      throw await powerActionError(action, response);
    }
    return true;
  } catch (error) {
    surfaceError(error);
    return false;
  }
}

export function ScopeToolbar({ client }: ScopeToolbarProps) {
  const connection = useScopeStore((state) => state.connection);
  const lastError = useScopeStore((state) => state.lastError);
  const [sleepRequested, setSleepRequested] = useState(false);
  const connected = connection.kind === BrowserConnectionKind.ScopeConnected;
  const instrumentPowerAction: ScopePowerAction = connected && !sleepRequested ? "sleep" : "wake";

  const runInstrumentPowerAction = async () => {
    const succeeded = await powerAction(instrumentPowerAction);
    if (!succeeded) {
      return;
    }
    setSleepRequested(instrumentPowerAction === "sleep");
  };

  if (!connected) {
    const reason = "reason" in connection ? connection.reason : "Connecting";
    return (
      <InstrumentHeader>
        <div className="scope-toolbar-content">
          <span className="status-pill">{reason}</span>
          <div className="toolbar-actions">
            <button type="button" onClick={() => void runInstrumentPowerAction()}>Wake</button>
          </div>
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
          <button type="button" onClick={() => command(AcquisitionAction.Single)}>Single</button>
          <button
            type="button"
            disabled={!stopped}
            onClick={() => void deepCapture()}
          >
            Deep Capture
          </button>
          <button type="button" onClick={() => void runInstrumentPowerAction()}>
            {instrumentPowerAction === "sleep" ? "Sleep" : "Wake"}
          </button>
        </div>
        {lastError !== null ? <span className="error-text">{lastError}</span> : null}
      </div>
    </InstrumentHeader>
  );
}
