import { create } from "zustand";

import { WaveformSource } from "../shared/scope-types.js";

const STORAGE_KEY = "rigol-web.waveform-hidden-sources.v1";
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

interface WaveformVisibilityState {
  hiddenSources: WaveformSource[];
  soloSource: WaveformSource | null;
  toggleVisibility(source: WaveformSource): void;
  toggleSolo(source: WaveformSource): void;
}

function readHiddenSources(): WaveformSource[] {
  if (typeof window === "undefined") return [];
  try {
    const stored: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "[]");
    if (!Array.isArray(stored)) return [];
    return [...new Set(stored.filter(
      (source): source is WaveformSource =>
        typeof source === "number" && ALL_SOURCES.has(source),
    ))];
  } catch {
    return [];
  }
}

function saveHiddenSources(sources: readonly WaveformSource[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(sources));
  } catch {
    // Visibility still works for this page session if storage is unavailable.
  }
}

export function isWaveformSourceVisible(
  source: WaveformSource,
  hiddenSources: readonly WaveformSource[],
  soloSource: WaveformSource | null,
): boolean {
  if (soloSource !== null) return soloSource === source;
  return !hiddenSources.includes(source);
}

export const useWaveformVisibilityStore = create<WaveformVisibilityState>((set) => ({
  hiddenSources: readHiddenSources(),
  soloSource: null,
  toggleVisibility: (source) => set((state) => {
    const hiddenSources = state.hiddenSources.includes(source)
      ? state.hiddenSources.filter((item) => item !== source)
      : [...state.hiddenSources, source];
    saveHiddenSources(hiddenSources);
    return {
      hiddenSources,
      soloSource: state.soloSource === source ? null : state.soloSource,
    };
  }),
  toggleSolo: (source) => set((state) => ({
    soloSource: state.soloSource === source ? null : source,
  })),
}));
