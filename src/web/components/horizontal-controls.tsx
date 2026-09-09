import { TimebaseMode, type ScopeState } from "../../shared/scope-types.js";
import { formatSampleRate, formatSamples, formatSeconds } from "../format-value.js";
import type { ScopeActions } from "../scope-actions.js";
import { DeepCaptureKind, useScopeStore } from "../scope-store.js";
import { EditableNumberInput } from "./editable-number.js";

const MODE_LABELS: Record<TimebaseMode, string> = {
  [TimebaseMode.Main]: "Main",
  [TimebaseMode.Roll]: "Roll",
  [TimebaseMode.Xy]: "XY",
};

const TIMEBASE_STEPS = Array.from({ length: 33 }, (_, index) => {
  const exponent = Math.floor(index / 3) - 9;
  const multiplier = [1, 2, 5][index % 3] ?? 1;
  return multiplier * 10 ** exponent;
});

function nearestTimebaseIndex(value: number): number {
  let nearest = 0;
  let distance = Number.POSITIVE_INFINITY;
  TIMEBASE_STEPS.forEach((step, index) => {
    const nextDistance = Math.abs(Math.log10(value) - Math.log10(step));
    if (nextDistance < distance) {
      nearest = index;
      distance = nextDistance;
    }
  });
  return nearest;
}

interface HorizontalControlsProps {
  scope: ScopeState;
  actions: ScopeActions;
}

export function HorizontalControls({ scope, actions }: HorizontalControlsProps) {
  const deepCapture = useScopeStore((state) => state.deepCapture);
  const isDeep = deepCapture.kind === DeepCaptureKind.Ready;
  const displayedScale = isDeep ? deepCapture.scale : scope.horizontal.scale;
  const displayedPosition = isDeep ? deepCapture.position : scope.horizontal.position;
  const timebaseIndex = nearestTimebaseIndex(displayedScale);

  const commitTimebaseStep = (index: number): void => {
    const clamped = Math.max(0, Math.min(TIMEBASE_STEPS.length - 1, index));
    const value = TIMEBASE_STEPS[clamped];
    if (value !== undefined) {
      void actions.setHorizontalScale(value);
    }
  };

  const stepTimebase = (direction: -1 | 1): void => {
    commitTimebaseStep(timebaseIndex + direction);
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
              onClick={() => stepTimebase(-1)}
              aria-label="Decrease time per division"
            >
              −
            </button>
            <button
              type="button"
              className="step-button"
              onClick={() => stepTimebase(1)}
              aria-label="Increase time per division"
            >
              +
            </button>
          </div>
          <EditableNumberInput
            value={displayedScale}
            validate={(value) => value > 0}
            ariaLabel="Time per division"
            onCommit={(value) => {
              void actions.setHorizontalScale(value);
            }}
          />
          <span>{formatSeconds(displayedScale)}</span>
        </label>
        <label>
          Position
          <EditableNumberInput
            value={displayedPosition}
            ariaLabel="Horizontal position"
            onCommit={(value) => {
              void actions.setHorizontalPosition(value);
            }}
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
