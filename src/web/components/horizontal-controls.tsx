import { useEffect, useState, type ChangeEvent, type FocusEvent } from "react";

import { TimebaseMode, type ScopeState } from "../../shared/scope-types.js";
import { ControlKind } from "../../shared/websocket-protocol.js";
import { formatSampleRate, formatSamples, formatSeconds } from "../format-value.js";
import { DeepCaptureKind, useScopeStore } from "../scope-store.js";
import type { ScopeWebSocketClient } from "../websocket-client.js";

const MODE_LABELS: Record<TimebaseMode, string> = {
  [TimebaseMode.Main]: "Main",
  [TimebaseMode.Roll]: "Roll",
  [TimebaseMode.Xy]: "XY",
};

interface HorizontalControlsProps {
  scope: ScopeState;
  client: ScopeWebSocketClient;
}

export function HorizontalControls({ scope, client }: HorizontalControlsProps) {
  const deepCapture = useScopeStore((state) => state.deepCapture);
  const isDeep = deepCapture.kind === DeepCaptureKind.Ready;
  const displayedScale = isDeep ? deepCapture.scale : scope.horizontal.scale;
  const displayedPosition = isDeep ? deepCapture.position : scope.horizontal.position;
  const [editing, setEditing] = useState<"scale" | "position" | null>(null);
  const [scaleDraft, setScaleDraft] = useState(String(displayedScale));
  const [positionDraft, setPositionDraft] = useState(String(displayedPosition));

  useEffect(() => {
    if (editing !== "scale") {
      setScaleDraft(String(displayedScale));
    }
    if (editing !== "position") {
      setPositionDraft(String(displayedPosition));
    }
  }, [displayedPosition, displayedScale, editing]);

  const setNumber = (kind: ControlKind.HorizontalScale | ControlKind.HorizontalPosition, value: number) => {
    if (!Number.isFinite(value) || (kind === ControlKind.HorizontalScale && value <= 0)) {
      return;
    }

    if (deepCapture.kind === DeepCaptureKind.Ready) {
      useScopeStore.getState().setDeepHorizontal(
        kind === ControlKind.HorizontalPosition ? value : deepCapture.position,
        kind === ControlKind.HorizontalScale ? value : deepCapture.scale,
      );
      return;
    }

    const control = { kind, value } as const;
    useScopeStore.getState().applyOptimisticControl(control);
    void client.setControl(control).catch((error: unknown) => {
      useScopeStore.getState().setError(
        error instanceof Error ? error.message : String(error),
      );
    });
  };

  const commitDraft = (
    kind: ControlKind.HorizontalScale | ControlKind.HorizontalPosition,
    draft: string,
  ): void => {
    const value = Number(draft);
    if (Number.isFinite(value) && (kind !== ControlKind.HorizontalScale || value > 0)) {
      setNumber(kind, value);
    } else if (kind === ControlKind.HorizontalScale) {
      setScaleDraft(String(displayedScale));
    } else {
      setPositionDraft(String(displayedPosition));
    }
    setEditing(null);
  };

  const onBlur = (
    kind: ControlKind.HorizontalScale | ControlKind.HorizontalPosition,
    event: FocusEvent<HTMLInputElement>,
  ): void => {
    commitDraft(kind, event.currentTarget.value);
  };

  return (
    <section className="panel">
      <h2>Horizontal</h2>
      <div className="control-row">
        <label>
          Time/div
          <input
            type="number"
            min="0"
            step="any"
            value={scaleDraft}
            onFocus={() => {
              setEditing("scale");
              setScaleDraft(String(displayedScale));
            }}
            onChange={(event: ChangeEvent<HTMLInputElement>) => setScaleDraft(event.target.value)}
            onBlur={(event) => onBlur(ControlKind.HorizontalScale, event)}
          />
          <span>{formatSeconds(displayedScale)}</span>
        </label>
        <label>
          Position
          <input
            type="number"
            step="any"
            value={positionDraft}
            onFocus={() => {
              setEditing("position");
              setPositionDraft(String(displayedPosition));
            }}
            onChange={(event: ChangeEvent<HTMLInputElement>) => setPositionDraft(event.target.value)}
            onBlur={(event) => onBlur(ControlKind.HorizontalPosition, event)}
          />
          <span>{formatSeconds(displayedPosition)}</span>
        </label>
      </div>
      <dl className="compact-details horizontal-details">
        <div><dt>Mode</dt><dd>{MODE_LABELS[scope.horizontal.mode]}</dd></div>
        <div><dt>Sample rate</dt><dd>{formatSampleRate(scope.acquisition.sampleRate)}</dd></div>
        <div><dt>Memory</dt><dd>{formatSamples(scope.acquisition.memoryDepth)}</dd></div>
      </dl>
      {isDeep ? (
        <p className="notice">Deep capture position and Time/div are browser-local.</p>
      ) : scope.horizontal.mode !== TimebaseMode.Main ? (
        <p className="notice">Direct waveform pan is disabled outside Main mode.</p>
      ) : null}
    </section>
  );
}
