import { create } from "zustand";

import { WaveformSource } from "../shared/scope-types.js";

const STORAGE_KEY = "rigol-web.focused-waveform-source.v1";
const ALL_SOURCES = new Set<number>([
  WaveformSource.Ch1,
  WaveformSource.Ch2,
  WaveformSource.Ch3,
  WaveformSource.Ch4,
  WaveformSource.Math1,
  WaveformSource.Math2,
  WaveformSource.Math3,
  WaveformSource.Math4,
]);

function readFocusedSource(): WaveformSource | null {
  if (typeof window === "undefined") return null;
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "null");
    return typeof value === "number" && ALL_SOURCES.has(value)
      ? value as WaveformSource
      : null;
  } catch {
    return null;
  }
}

function saveFocusedSource(source: WaveformSource | null): void {
  if (typeof window === "undefined") return;
  try {
    if (source === null) window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, JSON.stringify(source));
  } catch {
    // Focus remains available for the current page session if storage is unavailable.
  }
}

interface WaveformFocusState {
  focusedSource: WaveformSource | null;
  setFocusedSource(source: WaveformSource | null): void;
}

export const useWaveformFocusStore = create<WaveformFocusState>((set) => ({
  focusedSource: readFocusedSource(),
  setFocusedSource: (focusedSource) => {
    saveFocusedSource(focusedSource);
    set({ focusedSource });
  },
}));
