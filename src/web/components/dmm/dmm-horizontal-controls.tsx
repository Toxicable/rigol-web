import { useEffect, useState, type ChangeEvent, type FocusEvent } from "react";

import { formatSeconds } from "../../format-value.js";

export const DMM_TREND_RETENTION_SECONDS = 5 * 60;
export const DMM_TREND_HORIZONTAL_DIVISIONS = 10;

const DMM_TREND_TIMEBASE_STEPS = [
  0.1,
  0.2,
  0.5,
  1,
  2,
  5,
  10,
  20,
  30,
] as const;

export interface DmmTrendHorizontal {
  readonly scale: number;
  readonly position: number;
}

export const DEFAULT_DMM_TREND_HORIZONTAL: DmmTrendHorizontal = {
  scale: 1,
  position: 0,
};

interface DmmHorizontalControlsProps {
  horizontal: DmmTrendHorizontal;
  onChange(horizontal: DmmTrendHorizontal): void;
}

export function normalizeDmmTrendHorizontal(
  horizontal: DmmTrendHorizontal,
): DmmTrendHorizontal {
  const minimumScale = DMM_TREND_TIMEBASE_STEPS[0];
  const maximumScale = DMM_TREND_TIMEBASE_STEPS[DMM_TREND_TIMEBASE_STEPS.length - 1];
  if (minimumScale === undefined || maximumScale === undefined) {
    throw new Error("Missing DMM trend timebase limits");
  }

  const requestedScale = Number.isFinite(horizontal.scale)
    ? horizontal.scale
    : DEFAULT_DMM_TREND_HORIZONTAL.scale;
  const scale = Math.min(maximumScale, Math.max(minimumScale, requestedScale));
  const maximumLookback = Math.max(
    0,
    DMM_TREND_RETENTION_SECONDS - scale * DMM_TREND_HORIZONTAL_DIVISIONS,
  );
  const requestedPosition = Number.isFinite(horizontal.position)
    ? horizontal.position
    : DEFAULT_DMM_TREND_HORIZONTAL.position;
  const position = Math.min(0, Math.max(-maximumLookback, requestedPosition));
  return { scale, position };
}

function nearestTimebaseIndex(value: number): number {
  let nearest = 0;
  let distance = Number.POSITIVE_INFINITY;
  DMM_TREND_TIMEBASE_STEPS.forEach((step, index) => {
    const nextDistance = Math.abs(Math.log10(value) - Math.log10(step));
    if (nextDistance < distance) {
      nearest = index;
      distance = nextDistance;
    }
  });
  return nearest;
}

export function DmmHorizontalControls({
  horizontal,
  onChange,
}: DmmHorizontalControlsProps) {
  const normalized = normalizeDmmTrendHorizontal(horizontal);
  const timebaseIndex = nearestTimebaseIndex(normalized.scale);
  const [editing, setEditing] = useState<"scale" | "position" | null>(null);
  const [scaleDraft, setScaleDraft] = useState(String(normalized.scale));
  const [positionDraft, setPositionDraft] = useState(String(normalized.position));

  useEffect(() => {
    if (editing !== "scale") {
      setScaleDraft(String(normalized.scale));
    }
    if (editing !== "position") {
      setPositionDraft(String(normalized.position));
    }
  }, [editing, normalized.position, normalized.scale]);

  const commitHorizontal = (next: DmmTrendHorizontal): void => {
    onChange(normalizeDmmTrendHorizontal(next));
    setEditing(null);
  };

  const commitDraft = (
    kind: "scale" | "position",
    draft: string,
  ): void => {
    const value = Number(draft);
    if (!Number.isFinite(value)) {
      if (kind === "scale") {
        setScaleDraft(String(normalized.scale));
      } else {
        setPositionDraft(String(normalized.position));
      }
      setEditing(null);
      return;
    }

    commitHorizontal(kind === "scale"
      ? { scale: value, position: normalized.position }
      : { scale: normalized.scale, position: value });
  };

  const onBlur = (
    kind: "scale" | "position",
    event: FocusEvent<HTMLInputElement>,
  ): void => {
    commitDraft(kind, event.currentTarget.value);
  };

  const commitTimebaseStep = (index: number): void => {
    const clamped = Math.max(0, Math.min(DMM_TREND_TIMEBASE_STEPS.length - 1, index));
    const value = DMM_TREND_TIMEBASE_STEPS[clamped];
    if (value !== undefined) {
      commitHorizontal({ scale: value, position: normalized.position });
    }
  };

  return (
    <section className="panel">
      <h2>Horizontal</h2>
      <div className="control-row">
        <label>
          Time/div
          <div className="timebase-control">
            <button
              type="button"
              className="step-button"
              onClick={() => commitTimebaseStep(timebaseIndex - 1)}
              aria-label="Decrease DMM trend time per division"
            >
              −
            </button>
            <button
              type="button"
              className="step-button"
              onClick={() => commitTimebaseStep(timebaseIndex + 1)}
              aria-label="Increase DMM trend time per division"
            >
              +
            </button>
          </div>
          <input
            type="number"
            min="0.1"
            max="30"
            step="any"
            value={scaleDraft}
            onFocus={() => {
              setEditing("scale");
              setScaleDraft(String(normalized.scale));
            }}
            onChange={(event: ChangeEvent<HTMLInputElement>) => setScaleDraft(event.target.value)}
            onBlur={(event) => onBlur("scale", event)}
          />
          <span>{formatSeconds(normalized.scale)}</span>
        </label>
        <label>
          Position
          <input
            type="number"
            max="0"
            step="any"
            value={positionDraft}
            onFocus={() => {
              setEditing("position");
              setPositionDraft(String(normalized.position));
            }}
            onChange={(event: ChangeEvent<HTMLInputElement>) => setPositionDraft(event.target.value)}
            onBlur={(event) => onBlur("position", event)}
          />
          <span>{formatSeconds(normalized.position)}</span>
        </label>
      </div>
      <div className="dmm-horizontal-actions">
        <button
          type="button"
          disabled={normalized.position === 0}
          onClick={() => commitHorizontal({ scale: normalized.scale, position: 0 })}
        >
          Latest
        </button>
      </div>
      <p className="notice">
        Position 0 s follows the latest snapshot; negative values pan backward through the retained five-minute browser history.
      </p>
    </section>
  );
}
