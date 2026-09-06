export type MarkerOffscreenDirection = "above" | "below" | null;

export interface WaveformMarkerPlacement {
  readonly top: number;
  readonly domainY: number;
  readonly offscreen: MarkerOffscreenDirection;
}

const DEFAULT_MARKER_HEIGHT = 24;

export function waveformMarkerPlacement(
  value: number,
  scaleMin: number,
  scaleMax: number,
  plotTop: number,
  plotHeight: number,
  markerHeight = DEFAULT_MARKER_HEIGHT,
): WaveformMarkerPlacement {
  if (
    !Number.isFinite(value) ||
    !Number.isFinite(scaleMin) ||
    !Number.isFinite(scaleMax) ||
    !Number.isFinite(plotTop) ||
    !(scaleMax > scaleMin) ||
    !(plotHeight > 0) ||
    !(markerHeight > 0)
  ) {
    throw new Error("Invalid waveform marker geometry");
  }

  const rawY = ((scaleMax - value) / (scaleMax - scaleMin)) * plotHeight;
  const offscreen: MarkerOffscreenDirection = rawY < 0
    ? "above"
    : rawY > plotHeight
      ? "below"
      : null;
  const domainY = Math.max(0, Math.min(plotHeight, rawY));
  const inset = Math.min(markerHeight / 2, plotHeight / 2);
  const visibleY = Math.max(inset, Math.min(plotHeight - inset, rawY));

  return {
    top: plotTop + visibleY,
    domainY,
    offscreen,
  };
}
