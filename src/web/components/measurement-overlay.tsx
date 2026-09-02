import {
  MeasurementKind,
  type ScopeState,
} from "../../shared/scope-types.js";
import {
  formatAmplitude,
  formatHertz,
  formatPercent,
  formatSeconds,
} from "../format-value.js";
import { useScopeStore } from "../scope-store.js";

const KIND_LABELS: Record<MeasurementKind, string> = {
  [MeasurementKind.Vpp]: "Vpp",
  [MeasurementKind.Vmax]: "Vmax",
  [MeasurementKind.Vmin]: "Vmin",
  [MeasurementKind.Vavg]: "Vavg",
  [MeasurementKind.Vrms]: "Vrms",
  [MeasurementKind.Frequency]: "Frequency",
  [MeasurementKind.Period]: "Period",
  [MeasurementKind.Vtop]: "Vtop",
  [MeasurementKind.Vbase]: "Vbase",
  [MeasurementKind.Vamp]: "Vamp",
  [MeasurementKind.Vupper]: "Vupper",
  [MeasurementKind.Vmid]: "Vmid",
  [MeasurementKind.Vlower]: "Vlower",
  [MeasurementKind.Overshoot]: "Overshoot",
  [MeasurementKind.Preshoot]: "Preshoot",
  [MeasurementKind.RiseTime]: "Rise time",
  [MeasurementKind.FallTime]: "Fall time",
  [MeasurementKind.PositiveWidth]: "+Width",
  [MeasurementKind.NegativeWidth]: "-Width",
  [MeasurementKind.PositiveDuty]: "+Duty",
  [MeasurementKind.NegativeDuty]: "-Duty",
  [MeasurementKind.Tvmax]: "Tvmax",
  [MeasurementKind.Tvmin]: "Tvmin",
};

interface MeasurementOverlayProps {
  scope: ScopeState;
}

function isTimeMeasurement(kind: MeasurementKind): boolean {
  switch (kind) {
    case MeasurementKind.Period:
    case MeasurementKind.RiseTime:
    case MeasurementKind.FallTime:
    case MeasurementKind.PositiveWidth:
    case MeasurementKind.NegativeWidth:
    case MeasurementKind.Tvmax:
    case MeasurementKind.Tvmin:
      return true;
    default:
      return false;
  }
}

function isPercentMeasurement(kind: MeasurementKind): boolean {
  switch (kind) {
    case MeasurementKind.Overshoot:
    case MeasurementKind.Preshoot:
    case MeasurementKind.PositiveDuty:
    case MeasurementKind.NegativeDuty:
      return true;
    default:
      return false;
  }
}

function formatMeasurement(
  scope: ScopeState,
  value: number,
  kind: MeasurementKind,
  channel: number,
): string {
  if (kind === MeasurementKind.Frequency) {
    return formatHertz(value);
  }
  if (isTimeMeasurement(kind)) {
    return formatSeconds(value);
  }
  if (isPercentMeasurement(kind)) {
    return formatPercent(value);
  }
  const channelState = scope.channels[channel - 1];
  return channelState === undefined ? String(value) : formatAmplitude(value, channelState.unit);
}

export function MeasurementOverlay({ scope }: MeasurementOverlayProps) {
  const specs = useScopeStore((state) => state.measurementSpecs);
  const values = useScopeStore((state) => state.measurementValues);

  if (specs.length === 0) {
    return null;
  }

  return (
    <div className="measurement-overlay" aria-label="Measurements">
      {specs.map((spec, index) => {
        const value = values[index];
        const statistics =
          value !== undefined &&
          value.channel === spec.channel &&
          value.kind === spec.kind &&
          value.statistics.count > 0
            ? value.statistics
            : null;
        const formatted = (raw: number) =>
          formatMeasurement(scope, raw, spec.kind, spec.channel);

        return (
          <div
            className={`measurement-overlay-item ch${spec.channel}`}
            key={`${spec.channel}-${spec.kind}`}
          >
            <div className="measurement-overlay-primary">
              <span className="measurement-overlay-channel">CH{spec.channel}</span>
              <span className="measurement-overlay-kind">{KIND_LABELS[spec.kind]}</span>
              <strong>{statistics === null ? "—" : formatted(statistics.current)}</strong>
            </div>
            {statistics === null ? null : (
              <dl className="measurement-overlay-stats">
                <div><dt>Min</dt><dd>{formatted(statistics.minimum)}</dd></div>
                <div><dt>Avg</dt><dd>{formatted(statistics.average)}</dd></div>
                <div><dt>Max</dt><dd>{formatted(statistics.maximum)}</dd></div>
                <div><dt>σ</dt><dd>{formatted(statistics.deviation)}</dd></div>
                <div><dt>n</dt><dd>{statistics.count}</dd></div>
              </dl>
            )}
          </div>
        );
      })}
    </div>
  );
}
