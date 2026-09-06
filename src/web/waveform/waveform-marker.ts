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
    // Marker state is UI decoration and can briefly be incomplete while the
    // scope state or plot layout is being initialized. Never let that take
    // down the waveform/value renderer.
    return {
      top: Number.isFinite(plotTop) ? plotTop : 0,
      domainY: 0,
      offscreen: null,
    };
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
