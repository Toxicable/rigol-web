import { ScopeRunState } from "../../shared/scope-types.js";
import { AcquisitionAction } from "../../shared/websocket-protocol.js";
import { BrowserConnectionKind, useScopeStore } from "../scope-store.js";
import type { ScopeWebSocketClient } from "../websocket-client.js";
import {
  WaveformDisplayMode,
  type WaveformController,
} from "../waveform/waveform-controller.js";

const RUN_STATE_LABELS: Record<ScopeRunState, string> = {
  [ScopeRunState.Triggered]: "T'D",
  [ScopeRunState.Waiting]: "WAIT",
  [ScopeRunState.Running]: "RUN",
  [ScopeRunState.Auto]: "AUTO",
  [ScopeRunState.Stopped]: "STOP",
};

interface ScopeToolbarProps {
  client: ScopeWebSocketClient;
  controller: WaveformController;
}

export function ScopeToolbar({ client, controller }: ScopeToolbarProps) {
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
    if (action === AcquisitionAction.Run) {
      controller.setDisplayMode(WaveformDisplayMode.Live);
      useScopeStore.getState().clearDeepCapture();
    }
    void client.acquisition(action).catch((error: unknown) => {
      useScopeStore.getState().setError(
        error instanceof Error ? error.message : String(error),
      );
    });
  };

  const deepCapture = async () => {
    try {
      const ready = await client.deepCapture();
      controller.setDisplayMode(WaveformDisplayMode.Deep);
      const xMin = scope.horizontal.position - 5 * scope.horizontal.scale;
      const xMax = scope.horizontal.position + 5 * scope.horizontal.scale;
      const width = Math.max(1, Math.round(window.innerWidth * 0.6));
      for (const channelInfo of ready.channels) {
        controller.setDesiredDeepTimeRange(
          ready.captureId,
          channelInfo.channel,
          xMin,
          xMax,
          width,
          channelInfo,
        );
      }
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
