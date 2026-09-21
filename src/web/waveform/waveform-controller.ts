import {
  Channel,
  WaveformSource,
  channelForWaveformSource,
  waveformSourceForChannel,
  waveformSourceForMath,
  type ChannelState,
  type MathState,
} from "../../shared/scope-types.js";
import type { DeepCaptureChannelInfo } from "../../shared/websocket-protocol.js";
import { WaveformKind } from "../../shared/websocket-protocol.js";
import type { DecodedWaveformFrame } from "./waveform-frame-decoder.js";

export enum WaveformDisplayMode {
  Live = 1,
  Deep = 2,
}

export interface DeepViewportRequest {
  captureId: number;
  channel: Channel;
  startSample: number;
  endSample: number;
  pixelWidth: number;
}

export type PlotSeriesData = readonly [Float64Array, Float32Array];
export type WaveformPlotData = readonly [
  null,
  PlotSeriesData,
  PlotSeriesData,
  PlotSeriesData,
  PlotSeriesData,
  PlotSeriesData,
  PlotSeriesData,
  PlotSeriesData,
  PlotSeriesData,
];

type Listener = () => void;

interface DesiredViewport extends DeepViewportRequest {
  visibleStartSample: number;
  visibleEndSample: number;
}

const ALL_SOURCES = [
  WaveformSource.Ch1,
  WaveformSource.Ch2,
  WaveformSource.Ch3,
  WaveformSource.Ch4,
  WaveformSource.Math1,
  WaveformSource.Math2,
  WaveformSource.Math3,
  WaveformSource.Math4,
] as const;

function isNewerSequence(next: number, current: number): boolean {
  const difference = (next - current) >>> 0;
  return difference !== 0 && difference < 0x80000000;
}

function xValues(frame: DecodedWaveformFrame): Float64Array {
  const result = new Float64Array(frame.sampleIndices.length);
  for (let index = 0; index < frame.sampleIndices.length; index += 1) {
    const sampleIndex = frame.sampleIndices[index];
    if (sampleIndex === undefined) throw new Error("Missing waveform sample index");
    result[index] = frame.xOrigin + (sampleIndex - frame.xReference) * frame.xIncrement;
  }
  return result;
}

function emptySeries(): PlotSeriesData {
  return [new Float64Array(0), new Float32Array(0)];
}

export function timeRangeToSampleRange(
  xMin: number,
  xMax: number,
  info: DeepCaptureChannelInfo,
): { startSample: number; endSample: number } {
  if (!(info.sampleCount > 0) || !(info.xIncrement > 0)) {
    throw new Error("Invalid deep capture metadata");
  }
  const lower = Math.min(xMin, xMax);
  const upper = Math.max(xMin, xMax);
  const rawStart = (lower - info.xOrigin) / info.xIncrement + info.xReference;
  const rawEnd = (upper - info.xOrigin) / info.xIncrement + info.xReference;
  const startSample = Math.max(0, Math.min(info.sampleCount - 1, Math.floor(rawStart)));
  const endSample = Math.max(startSample + 1, Math.min(info.sampleCount, Math.ceil(rawEnd)));
  return { startSample, endSample };
}

export class WaveformController {
  private readonly liveFrames = new Map<WaveformSource, DecodedWaveformFrame>();
  private readonly enabledLiveSources = new Set<WaveformSource>(ALL_SOURCES);
  private readonly deepFrames = new Map<Channel, DecodedWaveformFrame>();
  private readonly desiredViewports = new Map<Channel, DesiredViewport>();
  private readonly pendingViewports = new Map<Channel, { requestId: number }>();
  private readonly listeners = new Set<Listener>();
  private displayMode = WaveformDisplayMode.Live;
  private captureId = 0;

  public constructor(private readonly requestViewport: (request: DeepViewportRequest) => number) {}

  public subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public getDisplayMode(): WaveformDisplayMode {
    return this.displayMode;
  }

  public setDisplayMode(mode: WaveformDisplayMode): void {
    if (this.displayMode === mode) return;
    this.displayMode = mode;
    this.notify();
  }

  public setLiveSources(channels: readonly ChannelState[], math: readonly MathState[]): void {
    const nextEnabled = new Set<WaveformSource>();
    for (const channel of channels) {
      if (channel.enabled) nextEnabled.add(waveformSourceForChannel(channel.channel));
    }
    for (const mathState of math) {
      if (mathState.enabled) nextEnabled.add(waveformSourceForMath(mathState.math));
    }

    let dataChanged = false;
    for (const source of ALL_SOURCES) {
      if (!nextEnabled.has(source) && this.liveFrames.delete(source)) dataChanged = true;
    }
    this.enabledLiveSources.clear();
    for (const source of nextEnabled) this.enabledLiveSources.add(source);
    if (dataChanged && this.displayMode === WaveformDisplayMode.Live) this.notify();
  }

  public setDeepCapture(captureId: number): void {
    if (!(captureId > 0)) throw new Error("Deep capture ID must be positive");
    this.captureId = captureId;
    this.deepFrames.clear();
    this.desiredViewports.clear();
    this.pendingViewports.clear();
    this.displayMode = WaveformDisplayMode.Deep;
    this.notify();
  }

  public retireDeepCapture(): void {
    const changed =
      this.displayMode !== WaveformDisplayMode.Live ||
      this.captureId !== 0 ||
      this.deepFrames.size !== 0 ||
      this.desiredViewports.size !== 0 ||
      this.pendingViewports.size !== 0;
    this.displayMode = WaveformDisplayMode.Live;
    this.captureId = 0;
    this.deepFrames.clear();
    this.desiredViewports.clear();
    this.pendingViewports.clear();
    if (changed) this.notify();
  }

  public resetSession(): void {
    const hadLiveFrames = this.liveFrames.size !== 0;
    this.liveFrames.clear();
    this.enabledLiveSources.clear();
    const hadDeepState =
      this.displayMode !== WaveformDisplayMode.Live ||
      this.captureId !== 0 ||
      this.deepFrames.size !== 0 ||
      this.desiredViewports.size !== 0 ||
      this.pendingViewports.size !== 0;
    this.displayMode = WaveformDisplayMode.Live;
    this.captureId = 0;
    this.deepFrames.clear();
    this.desiredViewports.clear();
    this.pendingViewports.clear();
    if (hadLiveFrames || hadDeepState) this.notify();
  }

  public acceptFrame(frame: DecodedWaveformFrame): boolean {
    if (frame.kind === WaveformKind.Live) {
      if (!this.enabledLiveSources.has(frame.source)) return false;
      const current = this.liveFrames.get(frame.source);
      if (current !== undefined && !isNewerSequence(frame.sequence, current.sequence)) return false;
      this.liveFrames.set(frame.source, frame);
      if (this.displayMode === WaveformDisplayMode.Live) this.notify();
      return true;
    }

    if (frame.captureId !== this.captureId) return false;
    const channel = channelForWaveformSource(frame.source);
    if (channel === null) return false;
    const desired = this.desiredViewports.get(channel);
    this.pendingViewports.delete(channel);
    if (
      desired !== undefined &&
      (desired.captureId !== frame.captureId ||
        frame.sourceStartSample > desired.visibleStartSample ||
        frame.sourceEndSample < desired.visibleEndSample)
    ) {
      this.requestDesiredViewport(desired);
      return false;
    }
    this.deepFrames.set(channel, frame);
    if (this.displayMode === WaveformDisplayMode.Deep) this.notify();
    return true;
  }

  public setDesiredDeepTimeRange(
    captureId: number,
    channel: Channel,
    xMin: number,
    xMax: number,
    pixelWidth: number,
    info: DeepCaptureChannelInfo,
  ): void {
    if (captureId !== this.captureId || this.displayMode !== WaveformDisplayMode.Deep) return;
    if (!(pixelWidth > 0)) throw new Error("Viewport pixel width must be positive");
    const { startSample, endSample } = timeRangeToSampleRange(xMin, xMax, info);
    const desiredSpan = endSample - startSample;
    const desired: DesiredViewport = {
      captureId,
      channel,
      startSample,
      endSample,
      visibleStartSample: startSample,
      visibleEndSample: endSample,
      pixelWidth: Math.max(1, Math.round(pixelWidth)),
    };
    this.desiredViewports.set(channel, desired);
    const cached = this.deepFrames.get(channel);
    if (cached !== undefined && cached.captureId === captureId) {
      const leftOverscan = startSample - cached.sourceStartSample;
      const rightOverscan = cached.sourceEndSample - endSample;
      const comfort = Math.max(1, Math.floor(desiredSpan * 0.2));
      if (leftOverscan >= comfort && rightOverscan >= comfort) return;
    }
    if (this.pendingViewports.has(channel)) return;
    this.requestDesiredViewport(desired);
  }

  public viewportRequestFailed(requestId: number): void {
    for (const [channel, pending] of this.pendingViewports) {
      if (pending.requestId === requestId) {
        this.pendingViewports.delete(channel);
        return;
      }
    }
  }

  public getPlotData(): WaveformPlotData {
    const liveSeries = (source: WaveformSource): PlotSeriesData => {
      const frame = this.liveFrames.get(source);
      return frame === undefined ? emptySeries() : [xValues(frame), frame.values];
    };
    const deepSeries = (channel: Channel): PlotSeriesData => {
      const frame = this.deepFrames.get(channel);
      return frame === undefined ? emptySeries() : [xValues(frame), frame.values];
    };
    if (this.displayMode === WaveformDisplayMode.Deep) {
      return [
        null,
        deepSeries(Channel.Ch1),
        deepSeries(Channel.Ch2),
        deepSeries(Channel.Ch3),
        deepSeries(Channel.Ch4),
        emptySeries(),
        emptySeries(),
        emptySeries(),
        emptySeries(),
      ];
    }
    return [
      null,
      ...ALL_SOURCES.map((source) => liveSeries(source)),
    ] as unknown as WaveformPlotData;
  }

  public getFrame(source: WaveformSource): DecodedWaveformFrame | undefined {
    if (this.displayMode === WaveformDisplayMode.Live) return this.liveFrames.get(source);
    const channel = channelForWaveformSource(source);
    return channel === null ? undefined : this.deepFrames.get(channel);
  }

  private requestDesiredViewport(desired: DesiredViewport): void {
    const requestId = this.requestViewport(desired);
    this.pendingViewports.set(desired.channel, { requestId });
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}
