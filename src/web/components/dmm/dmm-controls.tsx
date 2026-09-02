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

function DmmFunctionIcon({ value }: { readonly value: DmmMeasurementFunction }) {
  switch (value) {
    case DmmMeasurementFunction.DcVoltage:
      return <span className="dmm-function-symbol" aria-hidden="true">V⎓</span>;
    case DmmMeasurementFunction.AcVoltage:
      return <span className="dmm-function-symbol" aria-hidden="true">V~</span>;
    case DmmMeasurementFunction.DcCurrent:
      return <span className="dmm-function-symbol" aria-hidden="true">A⎓</span>;
    case DmmMeasurementFunction.AcCurrent:
      return <span className="dmm-function-symbol" aria-hidden="true">A~</span>;
    case DmmMeasurementFunction.Resistance2Wire:
      return <span className="dmm-function-symbol" aria-hidden="true">Ω</span>;
    case DmmMeasurementFunction.Resistance4Wire:
      return <span className="dmm-function-symbol dmm-function-symbol-wide" aria-hidden="true">4WΩ</span>;
    case DmmMeasurementFunction.Continuity:
      return (
        <svg className="dmm-function-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path className="dmm-function-icon-fill" d="M4 10h4l5-4v12l-5-4H4z" />
          <path d="M16 9.25c1.35 1.5 1.35 4 0 5.5" />
          <path d="M19 6.5c2.75 3 2.75 8 0 11" />
        </svg>
      );
    case DmmMeasurementFunction.Diode:
      return (
        <svg className="dmm-function-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M3 12h5" />
          <path className="dmm-function-icon-fill" d="M8 7l7 5-7 5z" />
          <path d="M15 7v10" />
          <path d="M15 12h6" />
        </svg>
      );
    case DmmMeasurementFunction.Frequency:
      return (
        <svg className="dmm-function-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M2 12c2.5-6 4.5-6 7 0s4.5 6 7 0 4.5-6 6 0" />
        </svg>
      );
    case DmmMeasurementFunction.Period:
      return (
        <svg className="dmm-function-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M3 14V9h6v5h6V9h6" />
          <path d="M9 18h6" />
          <path d="M9 16.5V19.5M15 16.5V19.5" />
        </svg>
      );
    case DmmMeasurementFunction.Capacitance:
      return (
        <svg className="dmm-function-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M3 12h7M10 6v12M14 6v12M14 12h7" />
        </svg>
      );
    case DmmMeasurementFunction.Temperature:
      return (
        <svg className="dmm-function-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M10 5a2 2 0 0 1 4 0v8.3a4 4 0 1 1-4 0z" />
          <path d="M12 8v8" />
        </svg>
      );
  }
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
              <span className="dmm-function-choice-label">
                <DmmFunctionIcon value={option.value} />
                <span>{option.shortLabel}</span>
              </span>
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
