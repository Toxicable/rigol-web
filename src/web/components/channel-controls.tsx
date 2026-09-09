import type { ChangeEvent } from "react";

import {
  ChannelBandwidthLimit,
  ChannelCoupling,
  type ChannelState,
} from "../../shared/scope-types.js";
import { channelUnitSymbol, formatAmplitude } from "../format-value.js";
import type { ScopeActions } from "../scope-actions.js";
import { EditableNumberInput } from "./editable-number.js";

const COUPLING_LABELS: Record<ChannelCoupling, string> = {
  [ChannelCoupling.Ac]: "AC",
  [ChannelCoupling.Dc]: "DC",
  [ChannelCoupling.Ground]: "GND",
};
const COUPLINGS = [ChannelCoupling.Ac, ChannelCoupling.Dc, ChannelCoupling.Ground] as const;
const BANDWIDTH_LABELS: Record<ChannelBandwidthLimit, string> = {
  [ChannelBandwidthLimit.Off]: "Full",
  [ChannelBandwidthLimit.Mhz20]: "20 MHz",
};
const BANDWIDTH_LIMITS = [ChannelBandwidthLimit.Off, ChannelBandwidthLimit.Mhz20] as const;
const PROBE_RATIOS = [1, 10] as const;

interface ChannelControlsProps {
  channels: readonly ChannelState[];
  actions: ScopeActions;
}

export function ChannelControls({ channels, actions }: ChannelControlsProps) {
  return (
    <section className="panel">
      <h2>Channels</h2>
      <div className="channel-grid">
        {channels.map((channel) => {
          const knownProbeRatio = PROBE_RATIOS.some((ratio) => ratio === channel.probeRatio);
          return (
            <div className={`channel-card ch${channel.channel}`} key={channel.channel}>
              <label className="channel-heading">
                <input
                  type="checkbox"
                  checked={channel.enabled}
                  onChange={(event: ChangeEvent<HTMLInputElement>) => {
                    void actions.setChannelEnabled(channel.channel, event.target.checked);
                  }}
                />
                CH{channel.channel}
              </label>
              <label>
                Scale
                <EditableNumberInput
                  value={channel.scale}
                  validate={(value) => value > 0}
                  ariaLabel={`CH${channel.channel} scale`}
                  onCommit={(value) => {
                    void actions.setChannelScale(channel.channel, value);
                  }}
                />
                <span>{channelUnitSymbol(channel.unit)}/div</span>
              </label>
              <label>
                Offset
                <EditableNumberInput
                  value={channel.offset}
                  ariaLabel={`CH${channel.channel} offset`}
                  onCommit={(value) => {
                    void actions.setChannelOffset(channel.channel, value);
                  }}
                />
                <span>{channelUnitSymbol(channel.unit)}</span>
              </label>
              <label>
                Coupling
                <select
                  value={channel.coupling}
                  onChange={(event: ChangeEvent<HTMLSelectElement>) => {
                    void actions.setChannelCoupling(
                      channel.channel,
                      Number(event.target.value) as ChannelCoupling,
                    );
                  }}
                >
                  {COUPLINGS.map((coupling) => (
                    <option value={coupling} key={coupling}>{COUPLING_LABELS[coupling]}</option>
                  ))}
                </select>
              </label>
              <label>
                BW limit
                <select
                  value={channel.bandwidthLimit}
                  onChange={(event: ChangeEvent<HTMLSelectElement>) => {
                    void actions.setChannelBandwidthLimit(
                      channel.channel,
                      Number(event.target.value) as ChannelBandwidthLimit,
                    );
                  }}
                >
                  {BANDWIDTH_LIMITS.map((limit) => (
                    <option value={limit} key={limit}>{BANDWIDTH_LABELS[limit]}</option>
                  ))}
                </select>
              </label>
              <label>
                Probe
                <select
                  value={channel.probeRatio}
                  onChange={(event: ChangeEvent<HTMLSelectElement>) => {
                    void actions.setChannelProbeRatio(channel.channel, Number(event.target.value));
                  }}
                >
                  {!knownProbeRatio ? (
                    <option value={channel.probeRatio}>{channel.probeRatio}×</option>
                  ) : null}
                  {PROBE_RATIOS.map((ratio) => (
                    <option value={ratio} key={ratio}>{ratio}×</option>
                  ))}
                </select>
              </label>
              <dl className="compact-details">
                <div><dt>Range</dt><dd>{formatAmplitude(channel.scale * 8, channel.unit)}</dd></div>
              </dl>
            </div>
          );
        })}
      </div>
    </section>
  );
}
