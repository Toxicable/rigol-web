import {
  WaveformSource,
} from "../../shared/scope-types.js";
import { waveformSourceLabel } from "../waveform-source-style.js";
import {
  useWaveformVisibilityStore,
} from "../waveform-visibility-store.js";
import { useWaveformFocusStore } from "../waveform-focus-store.js";

interface TraceVisibilityControlsProps {
  source: WaveformSource;
  enabled: boolean;
}

export function TraceVisibilityControls({ source, enabled }: TraceVisibilityControlsProps) {
  const hiddenSources = useWaveformVisibilityStore((state) => state.hiddenSources);
  const soloSource = useWaveformVisibilityStore((state) => state.soloSource);
  const toggleVisibility = useWaveformVisibilityStore((state) => state.toggleVisibility);
  const toggleSolo = useWaveformVisibilityStore((state) => state.toggleSolo);
  const focusedSource = useWaveformFocusStore((state) => state.focusedSource);
  const setFocusedSource = useWaveformFocusStore((state) => state.setFocusedSource);
  const label = waveformSourceLabel(source);
  const visible = !hiddenSources.includes(source);
  const isSolo = soloSource === source;
  const isFocused = focusedSource === source;
  const title = soloSource !== null && soloSource !== source
    ? `${label} is hidden while another trace is soloed; ${visible ? "hide" : "show"} it outside solo mode`
    : `${visible ? "Hide" : "Show"} ${label} trace`;

  return (
    <span className="trace-visibility-controls">
      <button
        type="button"
        className={`trace-focus-button${isFocused ? " is-active" : ""}`}
        aria-label={isFocused ? `${label} is focused` : `Focus ${label}`}
        aria-pressed={isFocused}
        title={isFocused ? `${label} is the focused source` : `Use ${label} for cursors and source-based tools`}
        disabled={!enabled}
        onClick={() => setFocusedSource(source)}
      >
        {isFocused ? "Focused" : "Focus"}
      </button>
      <button
        type="button"
        className="trace-visibility-button"
        aria-label={`${visible ? "Hide" : "Show"} ${label} trace`}
        aria-pressed={visible}
        title={title}
        onClick={() => toggleVisibility(source)}
      >
        {visible ? "◉" : "○"}
      </button>
      <button
        type="button"
        className={`trace-solo-button${isSolo ? " is-active" : ""}`}
        aria-label={isSolo ? "Show all traces" : `Solo ${label}`}
        aria-pressed={isSolo}
        disabled={!enabled}
        onClick={() => toggleSolo(source)}
      >
        {isSolo ? "All" : "Solo"}
      </button>
    </span>
  );
}
