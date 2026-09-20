import { useEffect, useState, type ChangeEvent } from "react";

import {
  MeasurementKind,
  WaveformSource,
} from "../../shared/scope-types.js";
import { LocalMeasurementAccumulator } from "../local-measurements.js";
import type { ScopeActions } from "../scope-actions.js";
import { MeasurementSource, useScopeStore } from "../scope-store.js";
import { waveformSourceLabel } from "../waveform-source-style.js";
import type { WaveformController } from "../waveform/waveform-controller.js";

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

const MEASUREMENT_GROUPS = [
  { label: "Amplitude", kinds: [MeasurementKind.Vpp, MeasurementKind.Vmax, MeasurementKind.Vmin, MeasurementKind.Vtop, MeasurementKind.Vbase, MeasurementKind.Vamp, MeasurementKind.Vavg, MeasurementKind.Vrms, MeasurementKind.Vupper, MeasurementKind.Vmid, MeasurementKind.Vlower, MeasurementKind.Overshoot, MeasurementKind.Preshoot] },
  { label: "Timing", kinds: [MeasurementKind.Frequency, MeasurementKind.Period, MeasurementKind.RiseTime, MeasurementKind.FallTime, MeasurementKind.PositiveWidth, MeasurementKind.NegativeWidth, MeasurementKind.PositiveDuty, MeasurementKind.NegativeDuty, MeasurementKind.Tvmax, MeasurementKind.Tvmin] },
] as const;

const SOURCES = [
  WaveformSource.Ch1,
  WaveformSource.Ch2,
  WaveformSource.Ch3,
  WaveformSource.Ch4,
  WaveformSource.Math1,
  WaveformSource.Math2,
  WaveformSource.Math3,
  WaveformSource.Math4,
] as const;

interface MeasurementPanelProps {
  actions: ScopeActions;
  controller: WaveformController;
}

export function MeasurementPanel({ actions, controller }: MeasurementPanelProps) {
  const source = useScopeStore((state) => state.measurementSource);
  const specs = useScopeStore((state) => state.measurementSpecs);
  const [waveformSource, setWaveformSource] = useState(WaveformSource.Ch1);
  const [kind, setKind] = useState(MeasurementKind.Vpp);
  const [localMeasurements] = useState(() => new LocalMeasurementAccumulator());

  useEffect(() => {
    if (source !== MeasurementSource.Scope) return;
    return actions.startMeasurementPolling();
  }, [actions, source]);

  useEffect(() => {
    localMeasurements.reset();
    if (source !== MeasurementSource.Local) return;
    const update = () => {
      useScopeStore.getState().setLocalMeasurementValues(localMeasurements.update(specs, controller));
    };
    update();
    return controller.subscribe(update);
  }, [controller, localMeasurements, source, specs]);

  const add = () => {
    if (specs.some((spec) => spec.channel === waveformSource && spec.kind === kind)) return;
    actions.setMeasurementSpecs([...specs, { channel: waveformSource, kind }]);
  };

  return (
    <section className="panel">
      <h2>Measurements</h2>
      <div className="measurement-add">
        <select
          aria-label="Measurement calculation source"
          value={source}
          onChange={(event: ChangeEvent<HTMLSelectElement>) =>
            actions.setMeasurementSource(Number(event.target.value) as MeasurementSource)
          }
        >
          <option value={MeasurementSource.Scope}>Source: Scope</option>
          <option value={MeasurementSource.Local}>Source: Local</option>
        </select>
        <select
          aria-label="Measurement waveform source"
          value={waveformSource}
          onChange={(event: ChangeEvent<HTMLSelectElement>) =>
            setWaveformSource(Number(event.target.value) as WaveformSource)
          }
        >
          {SOURCES.map((item) => (
            <option value={item} key={item}>{waveformSourceLabel(item)}</option>
          ))}
        </select>
        <select value={kind} onChange={(event: ChangeEvent<HTMLSelectElement>) => setKind(Number(event.target.value) as MeasurementKind)}>
          {MEASUREMENT_GROUPS.map((group) => (
            <optgroup label={group.label} key={group.label}>
              {group.kinds.map((item) => <option value={item} key={item}>{KIND_LABELS[item]}</option>)}
            </optgroup>
          ))}
        </select>
        <button type="button" onClick={add}>Add</button>
      </div>
      {specs.length === 0 ? <p className="muted">No measurements selected.</p> : (
        <ul className="measurement-list">
          {specs.map((spec, index) => (
            <li key={`${spec.channel}-${spec.kind}`}>
              <span>{waveformSourceLabel(spec.channel)} {KIND_LABELS[spec.kind]}</span>
              <button
                type="button"
                className="text-button"
                onClick={() => actions.setMeasurementSpecs(specs.filter((_, candidate) => candidate !== index))}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
