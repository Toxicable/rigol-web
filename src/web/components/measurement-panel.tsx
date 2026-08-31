import { useEffect, useState, type ChangeEvent } from "react";

import {
  Channel,
  MeasurementKind,
  type ScopeState,
} from "../../shared/scope-types.js";
import { formatAmplitude, formatHertz, formatSeconds } from "../format-value.js";
import { useScopeStore } from "../scope-store.js";
import type { ScopeWebSocketClient } from "../websocket-client.js";

const KIND_LABELS: Record<MeasurementKind, string> = {
  [MeasurementKind.Vpp]: "Vpp",
  [MeasurementKind.Vmax]: "Vmax",
  [MeasurementKind.Vmin]: "Vmin",
  [MeasurementKind.Vavg]: "Vavg",
  [MeasurementKind.Vrms]: "Vrms",
  [MeasurementKind.Frequency]: "Frequency",
  [MeasurementKind.Period]: "Period",
};

const KINDS = [
  MeasurementKind.Vpp,
  MeasurementKind.Vmax,
  MeasurementKind.Vmin,
  MeasurementKind.Vavg,
  MeasurementKind.Vrms,
  MeasurementKind.Frequency,
  MeasurementKind.Period,
] as const;

interface MeasurementPanelProps {
  scope: ScopeState;
  client: ScopeWebSocketClient;
}

export function MeasurementPanel({ scope, client }: MeasurementPanelProps) {
  const specs = useScopeStore((state) => state.measurementSpecs);
  const values = useScopeStore((state) => state.measurementValues);
  const setSpecs = useScopeStore((state) => state.setMeasurementSpecs);
  const [channel, setChannel] = useState(Channel.Ch1);
  const [kind, setKind] = useState(MeasurementKind.Vpp);

  useEffect(
    () => client.startMeasurementPolling(() => useScopeStore.getState().measurementSpecs),
    [client],
  );

  useEffect(() => {
    void client.setMeasurements(specs).catch((error: unknown) => {
      useScopeStore.getState().setError(error instanceof Error ? error.message : String(error));
    });
  }, [client, specs]);

  const add = () => {
    if (specs.some((spec) => spec.channel === channel && spec.kind === kind)) {
      return;
    }
    setSpecs([...specs, { channel, kind }]);
  };

  const format = (value: number, measurementKind: MeasurementKind, source: Channel) => {
    if (measurementKind === MeasurementKind.Frequency) {
      return formatHertz(value);
    }
    if (measurementKind === MeasurementKind.Period) {
      return formatSeconds(value);
    }
    const channelState = scope.channels[source - 1];
    return channelState === undefined ? String(value) : formatAmplitude(value, channelState.unit);
  };

  return (
    <section className="panel">
      <h2>Measurements</h2>
      <div className="measurement-add">
        <select value={channel} onChange={(event: ChangeEvent<HTMLSelectElement>) => setChannel(Number(event.target.value) as Channel)}>
          {[Channel.Ch1, Channel.Ch2, Channel.Ch3, Channel.Ch4].map((item) => (
            <option value={item} key={item}>CH{item}</option>
          ))}
        </select>
        <select value={kind} onChange={(event: ChangeEvent<HTMLSelectElement>) => setKind(Number(event.target.value) as MeasurementKind)}>
          {KINDS.map((item) => <option value={item} key={item}>{KIND_LABELS[item]}</option>)}
        </select>
        <button type="button" onClick={add}>Add</button>
      </div>
      {specs.length === 0 ? <p className="muted">No measurements selected.</p> : (
        <ul className="measurement-list">
          {specs.map((spec, index) => {
            const value = values[index];
            return (
              <li key={`${spec.channel}-${spec.kind}`}>
                <span>CH{spec.channel} {KIND_LABELS[spec.kind]}</span>
                <strong>
                  {value !== undefined && value.channel === spec.channel && value.kind === spec.kind
                    ? format(value.value, value.kind, value.channel)
                    : "—"}
                </strong>
                <button
                  type="button"
                  className="text-button"
                  onClick={() => setSpecs(specs.filter((_, candidate) => candidate !== index))}
                >
                  Remove
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
