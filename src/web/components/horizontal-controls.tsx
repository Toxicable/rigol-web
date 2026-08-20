import type { ChangeEvent } from "react";

import { TimebaseMode, type ScopeState } from "../../shared/scope-types.js";
import { ControlKind } from "../../shared/websocket-protocol.js";
import { formatSampleRate, formatSamples, formatSeconds } from "../format-value.js";
import { useScopeStore } from "../scope-store.js";
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
  const setNumber = (kind: ControlKind.HorizontalScale | ControlKind.HorizontalPosition, value: number) => {
    if (!Number.isFinite(value) || (kind === ControlKind.HorizontalScale && value <= 0)) {
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
            value={scope.horizontal.scale}
            onChange={(event: ChangeEvent<HTMLInputElement>) =>
              setNumber(ControlKind.HorizontalScale, event.target.valueAsNumber)
            }
          />
          <span>{formatSeconds(scope.horizontal.scale)}</span>
        </label>
        <label>
          Position
          <input
            type="number"
            step="any"
            value={scope.horizontal.position}
            onChange={(event: ChangeEvent<HTMLInputElement>) =>
              setNumber(ControlKind.HorizontalPosition, event.target.valueAsNumber)
            }
          />
          <span>{formatSeconds(scope.horizontal.position)}</span>
        </label>
      </div>
      <dl className="compact-details horizontal-details">
        <div><dt>Mode</dt><dd>{MODE_LABELS[scope.horizontal.mode]}</dd></div>
        <div><dt>Sample rate</dt><dd>{formatSampleRate(scope.acquisition.sampleRate)}</dd></div>
        <div><dt>Memory</dt><dd>{formatSamples(scope.acquisition.memoryDepth)}</dd></div>
      </dl>
      {scope.horizontal.mode !== TimebaseMode.Main ? (
        <p className="notice">Direct waveform pan is disabled outside Main mode.</p>
      ) : null}
    </section>
  );
}
