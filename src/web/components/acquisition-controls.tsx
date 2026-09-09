import type { ChangeEvent } from "react";

import { AcquisitionType, type ScopeState } from "../../shared/scope-types.js";
import { formatSampleRate, formatSamples } from "../format-value.js";
import type { ScopeActions } from "../scope-actions.js";

const TYPE_LABELS: Record<AcquisitionType, string> = {
  [AcquisitionType.Normal]: "Normal",
  [AcquisitionType.Peak]: "Peak",
  [AcquisitionType.Average]: "Average",
  [AcquisitionType.Ultra]: "Ultra",
};
const TYPES = [
  AcquisitionType.Normal,
  AcquisitionType.Peak,
  AcquisitionType.Average,
  AcquisitionType.Ultra,
] as const;
const AVERAGES = Array.from({ length: 16 }, (_, index) => 2 ** (index + 1));
const MEMORY_DEPTHS = [1_000, 10_000, 100_000, 1_000_000, 5_000_000, 10_000_000, 25_000_000] as const;

interface AcquisitionControlsProps {
  scope: ScopeState;
  actions: ScopeActions;
}

export function AcquisitionControls({ scope, actions }: AcquisitionControlsProps) {
  const enabledChannels = scope.channels.filter((channel) => channel.enabled).length;
  const maxDepth = enabledChannels <= 1 ? 25_000_000 : enabledChannels === 2 ? 10_000_000 : 5_000_000;
  const memoryDepths = MEMORY_DEPTHS.filter((depth) => depth <= maxDepth);
  const knownDepth = memoryDepths.some((depth) => depth === scope.acquisition.memoryDepth);

  return (
    <section className="panel">
      <h2>Acquisition</h2>
      <div className="control-row">
        <label>
          Mode
          <select
            value={scope.acquisition.type}
            onChange={(event: ChangeEvent<HTMLSelectElement>) => {
              void actions.setAcquisitionType(Number(event.target.value) as AcquisitionType);
            }}
          >
            {TYPES.map((type) => <option value={type} key={type}>{TYPE_LABELS[type]}</option>)}
          </select>
        </label>
        <label>
          Averages
          <select
            value={scope.acquisition.averages}
            disabled={scope.acquisition.type !== AcquisitionType.Average}
            onChange={(event: ChangeEvent<HTMLSelectElement>) => {
              void actions.setAcquisitionAverages(Number(event.target.value));
            }}
          >
            {AVERAGES.map((count) => <option value={count} key={count}>{count}</option>)}
          </select>
        </label>
        <label>
          Memory
          <select
            value={scope.acquisition.memoryDepth}
            onChange={(event: ChangeEvent<HTMLSelectElement>) => {
              void actions.setAcquisitionMemoryDepth(Number(event.target.value));
            }}
          >
            {!knownDepth ? (
              <option value={scope.acquisition.memoryDepth}>{formatSamples(scope.acquisition.memoryDepth)}</option>
            ) : null}
            {memoryDepths.map((depth) => (
              <option value={depth} key={depth}>{formatSamples(depth)}</option>
            ))}
          </select>
        </label>
      </div>
      <dl className="compact-details horizontal-details">
        <div><dt>Sample rate</dt><dd>{formatSampleRate(scope.acquisition.sampleRate)}</dd></div>
      </dl>
    </section>
  );
}
