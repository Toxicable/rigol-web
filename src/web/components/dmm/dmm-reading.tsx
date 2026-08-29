import {
  DmmRangeMode,
  type DmmReadingSnapshot,
  type DmmState,
} from "../../../shared/dmm-types.js";
import {
  dmmAcquisitionRateLabel,
  dmmFunctionLabel,
  dmmRangeLabel,
  dmmRangeUnit,
} from "../../dmm/dmm-capabilities.js";
import { formatDmmRange, formatDmmReading } from "../../dmm/dmm-format.js";

interface DmmReadingProps {
  state: DmmState;
  snapshot: DmmReadingSnapshot | null;
}

export function DmmReading({ state, snapshot }: DmmReadingProps) {
  const currentSnapshot = snapshot?.function === state.function ? snapshot : null;
  const reading = formatDmmReading(currentSnapshot, state.acquisitionRate);
  const rangeUnit = dmmRangeUnit(state.function);

  return (
    <section className="panel dmm-reading-panel">
      <div className="dmm-reading-header">
        <div>
          <span className="dmm-eyebrow">Primary measurement</span>
          <h1>{dmmFunctionLabel(state.function)}</h1>
        </div>
        <span className="status-pill">Latest reading</span>
      </div>

      <div className={reading.numeric ? "dmm-primary-reading numeric" : "dmm-primary-reading"}>
        <span className="dmm-reading-value">{reading.value}</span>
        <span className="dmm-reading-unit">{reading.unit}</span>
      </div>
      <div className="dmm-reading-detail" aria-live="polite">
        {reading.detail ?? "Latest available measurement"}
      </div>

      <dl className="dmm-reading-metadata">
        <div>
          <dt>Function</dt>
          <dd>{dmmFunctionLabel(state.function)}</dd>
        </div>
        {state.range !== null ? (
          <div>
            <dt>{dmmRangeLabel(state.function)}</dt>
            <dd>
              {state.range.mode === DmmRangeMode.Auto
                ? "Auto"
                : rangeUnit === null
                  ? String(state.range.value)
                  : formatDmmRange(state.range.value, rangeUnit)}
            </dd>
          </div>
        ) : null}
        {state.acquisitionRate !== null ? (
          <div>
            <dt>Rate</dt>
            <dd>{dmmAcquisitionRateLabel(state.acquisitionRate)}</dd>
          </div>
        ) : null}
      </dl>
    </section>
  );
}
