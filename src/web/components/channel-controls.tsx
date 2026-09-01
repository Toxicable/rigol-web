import type { ChangeEvent } from "react";

import {
  ChannelCoupling,
  type ChannelState,
} from "../../shared/scope-types.js";
import { ControlKind, type ControlChange } from "../../shared/websocket-protocol.js";
import { channelUnitSymbol, formatAmplitude } from "../format-value.js";
import { useScopeStore } from "../scope-store.js";
import type { ScopeWebSocketClient } from "../websocket-client.js";

const COUPLING_LABELS: Record<ChannelCoupling, string> = {
  [ChannelCoupling.Ac]: "AC",
  [ChannelCoupling.Dc]: "DC",
  [ChannelCoupling.Ground]: "GND",
};

interface ChannelControlsProps {
  channels: readonly ChannelState[];
  client: ScopeWebSocketClient;
}

export function ChannelControls({ channels, client }: ChannelControlsProps) {
  const setControl = (control: ControlChange) => {
    useScopeStore.getState().applyOptimisticControl(control);
    void client.setControl(control).catch((error: unknown) => {
      useScopeStore.getState().setError(
        error instanceof Error ? error.message : String(error),
      );
    });
  };

  return (
    <section className="panel">
      <h2>Channels</h2>
      <div className="channel-grid">
        {channels.map((channel) => (
          <div className={`channel-card ch${channel.channel}`} key={channel.channel}>
            <label className="channel-heading">
              <input
                type="checkbox"
                checked={channel.enabled}
                onChange={(event: ChangeEvent<HTMLInputElement>) =>
                  setControl({
                    kind: ControlKind.ChannelEnabled,
                    channel: channel.channel,
                    value: event.target.checked,
                  })
                }
              />
              CH{channel.channel}
            </label>
            <label>
              Scale
              <input
                type="number"
                min="0"
                step="any"
                value={channel.scale}
                onChange={(event: ChangeEvent<HTMLInputElement>) => {
                  const value = event.target.valueAsNumber;
                  if (Number.isFinite(value) && value > 0) {
                    setControl({
                      kind: ControlKind.ChannelScale,
                      channel: channel.channel,
                      value,
                    });
                  }
                }}
              />
              <span>{channelUnitSymbol(channel.unit)}/div</span>
            </label>
            <label>
              Offset
              <input
                type="number"
                step="any"
                value={channel.offset}
                onChange={(event: ChangeEvent<HTMLInputElement>) => {
                  const value = event.target.valueAsNumber;
                  if (Number.isFinite(value)) {
                    setControl({
                      kind: ControlKind.ChannelOffset,
                      channel: channel.channel,
                      value,
                    });
                  }
                }}
              />
              <span>{channelUnitSymbol(channel.unit)}</span>
            </label>
            <dl className="compact-details">
              <div><dt>Coupling</dt><dd>{COUPLING_LABELS[channel.coupling]}</dd></div>
              <div><dt>Probe</dt><dd>{channel.probeRatio}×</dd></div>
              <div><dt>Range</dt><dd>{formatAmplitude(channel.scale * 8, channel.unit)}</dd></div>
            </dl>
          </div>
        ))}
      </div>
    </section>
  );
}
