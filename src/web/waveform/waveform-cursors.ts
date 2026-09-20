import type { ChannelUnit, WaveformSource } from "../../shared/scope-types.js";
import type { DecodedWaveformFrame } from "./waveform-frame-decoder.js";

export type WaveformCursorSlot = "A" | "B";

export interface WaveformCursorMarker {
  source: WaveformSource;
  unit: ChannelUnit;
  x: number;
  y: number;
}

export interface WaveformCursorState {
  armed: boolean;
  markerA: WaveformCursorMarker | null;
  markerB: WaveformCursorMarker | null;
  nextSlot: WaveformCursorSlot;
}

export type WaveformCursorAction =
  | { type: "toggle-armed" }
  | { type: "set-armed"; value: boolean }
  | { type: "place"; marker: WaveformCursorMarker }
  | { type: "move"; slot: WaveformCursorSlot; marker: WaveformCursorMarker }
  | { type: "clear" }
  | { type: "reset" };

export const initialWaveformCursorState: WaveformCursorState = {
  armed: false,
  markerA: null,
  markerB: null,
  nextSlot: "A",
};

export function waveformCursorReducer(
  state: WaveformCursorState,
  action: WaveformCursorAction,
): WaveformCursorState {
  switch (action.type) {
    case "toggle-armed":
      return { ...state, armed: !state.armed };
    case "set-armed":
      return { ...state, armed: action.value };
    case "place":
      return actionMarker(state, state.nextSlot, action.marker, state.nextSlot === "A" ? "B" : "A");
    case "move":
      return actionMarker(state, action.slot, action.marker, state.nextSlot);
    case "clear":
      return { ...state, markerA: null, markerB: null, nextSlot: "A" };
    case "reset":
      return initialWaveformCursorState;
  }
}

function actionMarker(
  state: WaveformCursorState,
  slot: WaveformCursorSlot,
  marker: WaveformCursorMarker,
  nextSlot: WaveformCursorSlot,
): WaveformCursorState {
  return slot === "A"
    ? { ...state, markerA: marker, nextSlot }
    : { ...state, markerB: marker, nextSlot };
}

export function waveformCursorMarkerCount(state: WaveformCursorState): number {
  return Number(state.markerA !== null) + Number(state.markerB !== null);
}

export function nearestWaveformPoint(
  frame: DecodedWaveformFrame,
  x: number,
): { x: number; y: number } | null {
  if (
    frame.sampleIndices.length === 0 ||
    frame.values.length === 0 ||
    frame.sampleIndices.length !== frame.values.length ||
    !Number.isFinite(x) ||
    !Number.isFinite(frame.xIncrement) ||
    !(frame.xIncrement > 0)
  ) return null;

  const targetSample = frame.xReference + (x - frame.xOrigin) / frame.xIncrement;
  let low = 0;
  let high = frame.sampleIndices.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    const sample = frame.sampleIndices[middle];
    if (sample === undefined) return null;
    if (sample < targetSample) low = middle + 1;
    else high = middle;
  }

  const right = Math.min(frame.sampleIndices.length - 1, low);
  const left = Math.max(0, right - 1);
  const leftSample = frame.sampleIndices[left];
  const rightSample = frame.sampleIndices[right];
  if (leftSample === undefined || rightSample === undefined) return null;
  const index = Math.abs(leftSample - targetSample) <= Math.abs(rightSample - targetSample)
    ? left
    : right;
  const sampleIndex = frame.sampleIndices[index];
  const y = frame.values[index];
  if (sampleIndex === undefined || y === undefined || !Number.isFinite(y)) return null;
  return {
    x: frame.xOrigin + (sampleIndex - frame.xReference) * frame.xIncrement,
    y,
  };
}
