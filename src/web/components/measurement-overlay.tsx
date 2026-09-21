import type { CSSProperties } from "react";

import {
  MeasurementKind,
  waveformSourceUnit,
  type ScopeState,
  type WaveformSource,
} from "../../shared/scope-types.js";
import {
  formatStableAmplitude,
  formatStableHertz,
  formatStablePercent,
  formatStableSeconds,
} from "../format-value.js";
import { useScopeStore } from "../scope-store.js";
import type { ScopeActions } from "../scope-actions.js";
import { waveformSourceAccent, waveformSourceLabel } from "../waveform-source-style.js";

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
  actions: ScopeActions;
}

function isTimeMeasurement(kind: MeasurementKind): boolean {
  return kind === MeasurementKind.Period ||
    kind === MeasurementKind.RiseTime ||
    kind === MeasurementKind.FallTime ||
    kind === MeasurementKind.PositiveWidth ||
    kind === MeasurementKind.NegativeWidth ||
    kind === MeasurementKind.Tvmax ||
    kind === MeasurementKind.Tvmin;
}

function isPercentMeasurement(kind: MeasurementKind): boolean {
  return kind === MeasurementKind.Overshoot ||
    kind === MeasurementKind.Preshoot ||
    kind === MeasurementKind.PositiveDuty ||
    kind === MeasurementKind.NegativeDuty;
}

function formatMeasurement(
  scope: ScopeState,
  value: number,
  kind: MeasurementKind,
  source: WaveformSource,
): string {
  if (kind === MeasurementKind.Frequency) return formatStableHertz(value);
  if (isTimeMeasurement(kind)) return formatStableSeconds(value);
  if (isPercentMeasurement(kind)) return formatStablePercent(value);
  return formatStableAmplitude(value, waveformSourceUnit(scope, source));
}

export function MeasurementOverlay({ scope, actions }: MeasurementOverlayProps) {
  const specs = useScopeStore((state) => state.measurementSpecs);
  const values = useScopeStore((state) => state.measurementValues);
  if (specs.length === 0) return null;

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
        const formatted = (raw: number) => formatMeasurement(scope, raw, spec.kind, spec.channel);
        const style = {
          "--channel-accent": waveformSourceAccent(spec.channel),
        } as CSSProperties;

        return (
          <div className="measurement-overlay-item" style={style} key={`${spec.channel}-${spec.kind}`}>
            <div className="measurement-overlay-primary">
              <span className="measurement-overlay-channel">{waveformSourceLabel(spec.channel)}</span>
              <span className="measurement-overlay-kind">{KIND_LABELS[spec.kind]}</span>
              <strong>{statistics === null ? "—" : formatted(statistics.current)}</strong>
              <button
                type="button"
                className="measurement-remove-button"
                aria-label={`Remove ${waveformSourceLabel(spec.channel)} ${KIND_LABELS[spec.kind]} measurement`}
                onClick={() => actions.setMeasurementSpecs(specs.filter((_, candidate) => candidate !== index))}
              >
                ×
              </button>
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
