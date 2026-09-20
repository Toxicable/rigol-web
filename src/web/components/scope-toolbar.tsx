import { useEffect, type Dispatch } from "react";

import { ScopeRunState, TimebaseMode } from "../../shared/scope-types.js";
import { AppTransportKind, useAppTransportStore } from "../app-transport-store.js";
import type { ScopeActions } from "../scope-actions.js";
import { BrowserConnectionKind, useScopeStore } from "../scope-store.js";
import {
  waveformCursorMarkerCount,
  type WaveformCursorAction,
  type WaveformCursorState,
} from "../waveform/waveform-cursors.js";
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
  cursorState: WaveformCursorState;
  dispatchCursor: Dispatch<WaveformCursorAction>;
}

function isEditableTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement &&
    target.closest("input, select, textarea, [contenteditable='true']") !== null;
}

export function ScopeToolbar({ actions, cursorState, dispatchCursor }: ScopeToolbarProps) {
  const transport = useAppTransportStore((state) => state.transport);
  const connection = useScopeStore((state) => state.connection);
  const sleepPending = useScopeStore((state) => state.sleepPending);
  const lastError = useScopeStore((state) => state.lastError);
  const connected =
    transport.kind === AppTransportKind.Connected &&
    connection.kind === BrowserConnectionKind.ScopeConnected;

  useEffect(() => {
    if (!connected) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        isEditableTarget(event.target)
      ) return;
      if (event.key.toLowerCase() === "c") {
        event.preventDefault();
        dispatchCursor({ type: "toggle-armed" });
      } else if (event.key === "Escape" && cursorState.armed) {
        event.preventDefault();
        dispatchCursor({ type: "set-armed", value: false });
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [connected, cursorState.armed, dispatchCursor]);

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
  const cursorCount = waveformCursorMarkerCount(cursorState);

  return (
    <InstrumentHeader>
      <div className="scope-toolbar-content">
        <span className="status-pill">{RUN_STATE_LABELS[scope.runState]}</span>
        <div className="toolbar-actions">
          <button
            type="button"
            className={cursorState.armed ? "cursor-mode-button is-active" : "cursor-mode-button"}
            aria-pressed={cursorState.armed}
            title="Toggle local waveform cursors (C); Escape exits cursor mode"
            onClick={() => dispatchCursor({ type: "toggle-armed" })}
          >
            Cursors{cursorState.armed ? `: ${cursorState.nextSlot}` : ""}
          </button>
          <button
            type="button"
            disabled={cursorCount === 0}
            title="Clear local waveform cursors"
            onClick={() => dispatchCursor({ type: "clear" })}
          >
            Clear Cursors
          </button>
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
