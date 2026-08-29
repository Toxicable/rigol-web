import {
  DmmAcquisitionRate,
  DmmControlKind,
  DmmMeasurementFunction,
  DmmRangeMode,
  type DmmControlChange,
  type DmmRange,
  type DmmState,
} from "../../../shared/dmm-types.js";
import {
  dmmAcquisitionRateLabel,
  dmmFixedRanges,
  dmmFunctionOptions,
  dmmRangeLabel,
  dmmRangeUnit,
} from "../../dmm/dmm-capabilities.js";
import { formatDmmRange } from "../../dmm/dmm-format.js";

interface DmmControlsProps {
  state: DmmState;
  pending: boolean;
  onControl(control: DmmControlChange): void;
}

export function functionControlForSelection(value: DmmMeasurementFunction): DmmControlChange {
  return {
    kind: DmmControlKind.Function,
    value,
  };
}

export function rangeControlForState(state: DmmState, value: DmmRange): DmmControlChange {
  if (state.range === null) {
    throw new Error("Current DMM function does not expose range control");
  }
  return {
    kind: DmmControlKind.Range,
    function: state.function,
    value,
  };
}

export function rateControlForState(
  state: DmmState,
  value: DmmAcquisitionRate,
): DmmControlChange {
  if (state.acquisitionRate === null) {
    throw new Error("Current DMM function does not expose acquisition-rate control");
  }
  return {
    kind: DmmControlKind.AcquisitionRate,
    function: state.function,
    value,
  };
}

export function dmmControlMatchesState(
  state: DmmState,
  control: DmmControlChange,
): boolean {
  switch (control.kind) {
    case DmmControlKind.Function:
      return state.function === control.value;
    case DmmControlKind.Range:
      return control.function === state.function &&
        state.range !== null &&
        sameRange(state.range, control.value);
    case DmmControlKind.AcquisitionRate:
      return control.function === state.function &&
        state.acquisitionRate === control.value;
  }
}

function sameRange(left: DmmRange, right: DmmRange): boolean {
  if (left.mode !== right.mode) {
    return false;
  }
  if (left.mode === DmmRangeMode.Auto || right.mode === DmmRangeMode.Auto) {
    return true;
  }
  return left.value === right.value;
}

export function DmmControls({ state, pending, onControl }: DmmControlsProps) {
  const ranges = dmmFixedRanges(state.function);
  const rangeUnit = dmmRangeUnit(state.function);
  const currentRange = state.range;
  const currentRate = state.acquisitionRate;

  return (
    <section className="panel dmm-controls-panel">
      <div className="dmm-section-heading">
        <h2>Function</h2>
        {pending ? <span className="status-pill">Applying…</span> : null}
      </div>
      <div className="dmm-function-grid">
        {dmmFunctionOptions.map((option) => {
          const active = state.function === option.value;
          return (
            <button
              type="button"
              key={option.value}
              className={active ? "dmm-choice active" : "dmm-choice"}
              aria-pressed={active}
              disabled={pending || active}
              title={option.label}
              onClick={() => onControl(functionControlForSelection(option.value))}
            >
              {option.shortLabel}
            </button>
          );
        })}
      </div>

      {currentRange !== null ? (
        <div className="dmm-control-group">
          <h2>{dmmRangeLabel(state.function)}</h2>
          <div className="dmm-choice-row">
            <button
              type="button"
              className={currentRange.mode === DmmRangeMode.Auto ? "dmm-choice active" : "dmm-choice"}
              aria-pressed={currentRange.mode === DmmRangeMode.Auto}
              disabled={pending || currentRange.mode === DmmRangeMode.Auto}
              onClick={() => onControl(rangeControlForState(state, { mode: DmmRangeMode.Auto }))}
            >
              Auto
            </button>
            {ranges.map((range) => {
              const active = currentRange.mode === DmmRangeMode.Fixed && currentRange.value === range;
              return (
                <button
                  type="button"
                  key={range}
                  className={active ? "dmm-choice active" : "dmm-choice"}
                  aria-pressed={active}
                  disabled={pending || active}
                  onClick={() => onControl(rangeControlForState(state, {
                    mode: DmmRangeMode.Fixed,
                    value: range,
                  }))}
                >
                  {rangeUnit === null ? String(range) : formatDmmRange(range, rangeUnit)}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}

      {currentRate !== null ? (
        <div className="dmm-control-group">
          <h2>Rate / resolution</h2>
          <div className="dmm-rate-grid">
            {[
              DmmAcquisitionRate.Slow,
              DmmAcquisitionRate.Medium,
              DmmAcquisitionRate.Fast,
            ].map((rate) => {
              const active = currentRate === rate;
              return (
                <button
                  type="button"
                  key={rate}
                  className={active ? "dmm-choice active" : "dmm-choice"}
                  aria-pressed={active}
                  disabled={pending || active}
                  onClick={() => onControl(rateControlForState(state, rate))}
                >
                  {dmmAcquisitionRateLabel(rate)}
                </button>
              );
            })}
          </div>
          <p className="muted dmm-rate-note">Fast mode is specified up to 80 readings/s; effective rate depends on measurement configuration.</p>
        </div>
      ) : null}
    </section>
  );
}
