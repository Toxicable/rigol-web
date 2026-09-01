import {
  MeasurementKind,
  type ScopeState,
} from "../../shared/scope-types.js";
import { formatAmplitude, formatHertz, formatSeconds } from "../format-value.js";
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

function formatMeasurement(
  scope: ScopeState,
  value: number,
  kind: MeasurementKind,
  channel: number,
): string {
  if (kind === MeasurementKind.Frequency) {
    return formatHertz(value);
  }
  if (kind === MeasurementKind.Period) {
    return formatSeconds(value);
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
        const formatted =
          value !== undefined && value.channel === spec.channel && value.kind === spec.kind
            ? formatMeasurement(scope, value.value, value.kind, value.channel)
            : "—";
        return (
          <div
            className={`measurement-overlay-item ch${spec.channel}`}
            key={`${spec.channel}-${spec.kind}`}
          >
            <span className="measurement-overlay-channel">CH{spec.channel}</span>
            <span className="measurement-overlay-kind">{KIND_LABELS[spec.kind]}</span>
            <strong>{formatted}</strong>
          </div>
        );
      })}
    </div>
  );
}
