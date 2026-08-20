import type { ChangeEvent } from "react";

import {
  Channel,
  EdgeSlope,
  TriggerCoupling,
  TriggerSweep,
  TriggerType,
  type ScopeState,
} from "../../shared/scope-types.js";
import { ControlKind, type ControlChange } from "../../shared/websocket-protocol.js";
import { useScopeStore } from "../scope-store.js";
import type { ScopeWebSocketClient } from "../websocket-client.js";

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

interface TriggerControlsProps {
  scope: ScopeState;
  client: ScopeWebSocketClient;
}

export function TriggerControls({ scope, client }: TriggerControlsProps) {
  const setControl = (control: ControlChange) => {
    useScopeStore.getState().applyOptimisticControl(control);
    void client.setControl(control).catch((error: unknown) => {
      useScopeStore.getState().setError(
        error instanceof Error ? error.message : String(error),
      );
    });
  };

  if (scope.trigger.type !== TriggerType.Edge) {
    return (
      <section className="panel">
        <h2>Trigger</h2>
        <dl className="compact-details">
          <div><dt>Type</dt><dd>{TYPE_LABELS[scope.trigger.type]}</dd></div>
          <div><dt>Sweep</dt><dd>{SWEEP_LABELS[scope.trigger.sweep]}</dd></div>
        </dl>
        <button
          type="button"
          onClick={() =>
            setControl({ kind: ControlKind.TriggerType, value: TriggerType.Edge })
          }
        >
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
            onChange={(event: ChangeEvent<HTMLSelectElement>) =>
              setControl({
                kind: ControlKind.TriggerSource,
                value: Number(event.target.value) as Channel,
              })
            }
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
            onChange={(event: ChangeEvent<HTMLSelectElement>) =>
              setControl({
                kind: ControlKind.TriggerSlope,
                value: Number(event.target.value) as EdgeSlope,
              })
            }
          >
            {[EdgeSlope.Rising, EdgeSlope.Falling, EdgeSlope.Either].map((slope) => (
              <option value={slope} key={slope}>{SLOPE_LABELS[slope]}</option>
            ))}
          </select>
        </label>
        <label>
          Level
          <input
            type="number"
            step="any"
            value={scope.trigger.level}
            onChange={(event: ChangeEvent<HTMLInputElement>) => {
              const value = event.target.valueAsNumber;
              if (Number.isFinite(value)) {
                setControl({ kind: ControlKind.TriggerLevel, value });
              }
            }
            }
          />
        </label>
      </div>
      <dl className="compact-details horizontal-details">
        <div><dt>Type</dt><dd>Edge</dd></div>
        <div><dt>Sweep</dt><dd>{SWEEP_LABELS[scope.trigger.sweep]}</dd></div>
        <div><dt>Coupling</dt><dd>{COUPLING_LABELS[scope.trigger.coupling]}</dd></div>
      </dl>
    </section>
  );
}
