import { useEffect, useState, type ChangeEvent } from "react";

import {
  Channel,
  MeasurementKind,
} from "../../shared/scope-types.js";
import { LocalMeasurementAccumulator } from "../local-measurements.js";
import { MeasurementSource, useScopeStore } from "../scope-store.js";
import type { ScopeWebSocketClient } from "../websocket-client.js";
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
  { label: "Voltage", kinds: [MeasurementKind.Vpp, MeasurementKind.Vmax, MeasurementKind.Vmin, MeasurementKind.Vtop, MeasurementKind.Vbase, MeasurementKind.Vamp, MeasurementKind.Vavg, MeasurementKind.Vrms, MeasurementKind.Vupper, MeasurementKind.Vmid, MeasurementKind.Vlower, MeasurementKind.Overshoot, MeasurementKind.Preshoot] },
  { label: "Timing", kinds: [MeasurementKind.Frequency, MeasurementKind.Period, MeasurementKind.RiseTime, MeasurementKind.FallTime, MeasurementKind.PositiveWidth, MeasurementKind.NegativeWidth, MeasurementKind.PositiveDuty, MeasurementKind.NegativeDuty, MeasurementKind.Tvmax, MeasurementKind.Tvmin] },
] as const;

interface MeasurementPanelProps {
  client: ScopeWebSocketClient;
  controller: WaveformController;
}

export function MeasurementPanel({ client, controller }: MeasurementPanelProps) {
  const source = useScopeStore((state) => state.measurementSource);
  const setSource = useScopeStore((state) => state.setMeasurementSource);
  const specs = useScopeStore((state) => state.measurementSpecs);
  const setSpecs = useScopeStore((state) => state.setMeasurementSpecs);
  const [channel, setChannel] = useState(Channel.Ch1);
  const [kind, setKind] = useState(MeasurementKind.Vpp);
  const [localMeasurements] = useState(() => new LocalMeasurementAccumulator());

  useEffect(() => {
    if (source !== MeasurementSource.Scope) {
      return;
    }
    return client.startMeasurementPolling(() => useScopeStore.getState().measurementSpecs);
  }, [client, source]);

  useEffect(() => {
    if (source !== MeasurementSource.Scope) {
      return;
    }
    void client.setMeasurements(specs).catch((error: unknown) => {
      useScopeStore.getState().setError(error instanceof Error ? error.message : String(error));
    });
  }, [client, source, specs]);

  useEffect(() => {
    if (source !== MeasurementSource.Local) {
      return;
    }
    void client.setMeasurements([]).catch((error: unknown) => {
      useScopeStore.getState().setError(error instanceof Error ? error.message : String(error));
    });
  }, [client, source]);

  useEffect(() => {
    localMeasurements.reset();
    if (source !== MeasurementSource.Local) {
      return;
    }

    const update = () => {
      useScopeStore
        .getState()
        .setLocalMeasurementValues(localMeasurements.update(specs, controller));
    };
    update();
    return controller.subscribe(update);
  }, [controller, localMeasurements, source, specs]);

  const add = () => {
    if (specs.some((spec) => spec.channel === channel && spec.kind === kind)) {
      return;
    }
    setSpecs([...specs, { channel, kind }]);
  };

  return (
    <section className="panel">
      <h2>Measurements</h2>
      <div className="measurement-add">
        <select
          aria-label="Measurement source"
          value={source}
          onChange={(event: ChangeEvent<HTMLSelectElement>) =>
            setSource(Number(event.target.value) as MeasurementSource)
          }
        >
          <option value={MeasurementSource.Scope}>Source: Scope</option>
          <option value={MeasurementSource.Local}>Source: Local</option>
        </select>
        <select value={channel} onChange={(event: ChangeEvent<HTMLSelectElement>) => setChannel(Number(event.target.value) as Channel)}>
          {[Channel.Ch1, Channel.Ch2, Channel.Ch3, Channel.Ch4].map((item) => (
            <option value={item} key={item}>CH{item}</option>
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
              <span>CH{spec.channel} {KIND_LABELS[spec.kind]}</span>
              <button
                type="button"
                className="text-button"
                onClick={() => setSpecs(specs.filter((_, candidate) => candidate !== index))}
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
