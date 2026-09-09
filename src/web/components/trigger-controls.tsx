import type { ChangeEvent } from "react";

import {
  Channel,
  EdgeSlope,
  TriggerCoupling,
  TriggerSweep,
  TriggerType,
  type ScopeState,
} from "../../shared/scope-types.js";
import type { ScopeActions } from "../scope-actions.js";
import { EditableNumberInput } from "./editable-number.js";

const TYPE_LABELS: Record<TriggerType, string> = {
  [TriggerType.Edge]: "Edge",
  [TriggerType.Pulse]: "Pulse",
  [TriggerType.Slope]: "Slope",
  [TriggerType.Video]: "Video",
  [TriggerType.Pattern]: "Pattern",
  [TriggerType.Duration]: "Duration",
  [TriggerType.Timeout]: "Timeout",
  [TriggerType.Runt]: "Runt",
  [TriggerType.Window]: "Window",
  [TriggerType.Delay]: "Delay",
  [TriggerType.SetupHold]: "Setup/Hold",
  [TriggerType.NthEdge]: "Nth Edge",
  [TriggerType.Rs232]: "RS232",
  [TriggerType.I2c]: "I²C",
  [TriggerType.Spi]: "SPI",
  [TriggerType.Can]: "CAN",
};
const SWEEP_LABELS: Record<TriggerSweep, string> = {
  [TriggerSweep.Auto]: "Auto",
  [TriggerSweep.Normal]: "Normal",
  [TriggerSweep.Single]: "Single",
};
const SLOPE_LABELS: Record<EdgeSlope, string> = {
  [EdgeSlope.Rising]: "Rising",
  [EdgeSlope.Falling]: "Falling",
  [EdgeSlope.Either]: "Either",
};
const COUPLING_LABELS: Record<TriggerCoupling, string> = {
  [TriggerCoupling.Ac]: "AC",
  [TriggerCoupling.Dc]: "DC",
  [TriggerCoupling.LowFrequencyReject]: "LF reject",
  [TriggerCoupling.HighFrequencyReject]: "HF reject",
};
const SWEEPS = [TriggerSweep.Auto, TriggerSweep.Normal, TriggerSweep.Single] as const;
const COUPLINGS = [
  TriggerCoupling.Ac,
  TriggerCoupling.Dc,
  TriggerCoupling.LowFrequencyReject,
  TriggerCoupling.HighFrequencyReject,
] as const;

interface TriggerControlsProps {
  scope: ScopeState;
  actions: ScopeActions;
}

export function TriggerControls({ scope, actions }: TriggerControlsProps) {
  const sweepSelect = (
    <select
      value={scope.trigger.sweep}
      onChange={(event: ChangeEvent<HTMLSelectElement>) => {
        void actions.setTriggerSweep(Number(event.target.value) as TriggerSweep);
      }}
    >
      {SWEEPS.map((sweep) => <option value={sweep} key={sweep}>{SWEEP_LABELS[sweep]}</option>)}
    </select>
  );

  if (scope.trigger.type !== TriggerType.Edge) {
    return (
      <section className="panel">
        <h2>Trigger</h2>
        <div className="control-row">
          <label>Sweep{sweepSelect}</label>
        </div>
        <dl className="compact-details">
          <div><dt>Type</dt><dd>{TYPE_LABELS[scope.trigger.type]}</dd></div>
        </dl>
        <button type="button" onClick={() => { void actions.setTriggerType(TriggerType.Edge); }}>
          Switch to Edge
        </button>
      </section>
    );
  }

  return (
    <section className="panel">
      <h2>Trigger</h2>
      <div className="control-row">
        <label>
          Source
          <select
            value={scope.trigger.source}
            onChange={(event: ChangeEvent<HTMLSelectElement>) => {
              void actions.setTriggerSource(Number(event.target.value) as Channel);
            }}
          >
            {[Channel.Ch1, Channel.Ch2, Channel.Ch3, Channel.Ch4].map((channel) => (
              <option value={channel} key={channel}>CH{channel}</option>
            ))}
          </select>
        </label>
        <label>
          Slope
          <select
            value={scope.trigger.slope}
            onChange={(event: ChangeEvent<HTMLSelectElement>) => {
              void actions.setTriggerSlope(Number(event.target.value) as EdgeSlope);
            }}
          >
            {[EdgeSlope.Rising, EdgeSlope.Falling, EdgeSlope.Either].map((slope) => (
              <option value={slope} key={slope}>{SLOPE_LABELS[slope]}</option>
            ))}
          </select>
        </label>
        <label>
          Level
          <EditableNumberInput
            value={scope.trigger.level}
            ariaLabel="Trigger level"
            onCommit={(value) => { void actions.setTriggerLevel(value); }}
          />
        </label>
        <label>Sweep{sweepSelect}</label>
        <label>
          Coupling
          <select
            value={scope.trigger.coupling}
            onChange={(event: ChangeEvent<HTMLSelectElement>) => {
              void actions.setTriggerCoupling(Number(event.target.value) as TriggerCoupling);
            }}
          >
            {COUPLINGS.map((coupling) => (
              <option value={coupling} key={coupling}>{COUPLING_LABELS[coupling]}</option>
            ))}
          </select>
        </label>
      </div>
      <dl className="compact-details horizontal-details">
        <div><dt>Type</dt><dd>Edge</dd></div>
      </dl>
    </section>
  );
}
