import { Channel } from "../../shared/scope-types.js";
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
];

type Listener = () => void;

interface DesiredViewport extends DeepViewportRequest {
  visibleStartSample: number;
  visibleEndSample: number;
}

const ALL_CHANNELS = [Channel.Ch1, Channel.Ch2, Channel.Ch3, Channel.Ch4] as const;

function isNewerSequence(next: number, current: number): boolean {
  const difference = (next - current) >>> 0;
  return difference !== 0 && difference < 0x80000000;
}

function xValues(frame: DecodedWaveformFrame): Float64Array {
  const result = new Float64Array(frame.sampleIndices.length);
  for (let index = 0; index < frame.sampleIndices.length; index += 1) {
    const sampleIndex = frame.sampleIndices[index];
    if (sampleIndex === undefined) {
      throw new Error("Missing waveform sample index");
    }
    result[index] =
      frame.xOrigin + (sampleIndex - frame.xReference) * frame.xIncrement;
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
  const endSample = Math.max(
    startSample + 1,
    Math.min(info.sampleCount, Math.ceil(rawEnd)),
  );

  return { startSample, endSample };
}

export class WaveformController {
  private readonly liveFrames = new Map<Channel, DecodedWaveformFrame>();
  private readonly enabledLiveChannels = new Set<Channel>(ALL_CHANNELS);
  private readonly deepFrames = new Map<Channel, DecodedWaveformFrame>();
  private readonly desiredViewports = new Map<Channel, DesiredViewport>();
  private readonly pendingViewports = new Map<Channel, { requestId: number }>();
  private readonly listeners = new Set<Listener>();
  private displayMode = WaveformDisplayMode.Live;
  private captureId = 0;

  public constructor(
    private readonly requestViewport: (request: DeepViewportRequest) => number,
  ) {}

  public subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public getDisplayMode(): WaveformDisplayMode {
    return this.displayMode;
  }

  public setDisplayMode(mode: WaveformDisplayMode): void {
    if (this.displayMode === mode) {
      return;
    }
    this.displayMode = mode;
    this.notify();
  }

  public setLiveChannels(channels: readonly { channel: Channel; enabled: boolean }[]): void {
    const nextEnabled = new Set<Channel>();
    for (const channel of channels) {
      if (channel.enabled) {
        nextEnabled.add(channel.channel);
      }
    }

    let dataChanged = false;
    for (const channel of ALL_CHANNELS) {
      if (!nextEnabled.has(channel) && this.liveFrames.delete(channel)) {
        dataChanged = true;
      }
    }

    this.enabledLiveChannels.clear();
    for (const channel of nextEnabled) {
      this.enabledLiveChannels.add(channel);
    }

    if (dataChanged && this.displayMode === WaveformDisplayMode.Live) {
      this.notify();
    }
  }

  public setDeepCapture(captureId: number): void {
    if (!(captureId > 0)) {
      throw new Error("Deep capture ID must be positive");
    }
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

    if (changed) {
      this.notify();
    }
  }

  public resetSession(): void {
    const hadLiveFrames = this.liveFrames.size !== 0;
    this.liveFrames.clear();
    this.enabledLiveChannels.clear();
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

    if (hadLiveFrames || hadDeepState) {
      this.notify();
    }
  }

  public acceptFrame(frame: DecodedWaveformFrame): boolean {
    if (frame.kind === WaveformKind.Live) {
      if (!this.enabledLiveChannels.has(frame.channel)) {
        return false;
      }
      const current = this.liveFrames.get(frame.channel);
      if (current !== undefined && !isNewerSequence(frame.sequence, current.sequence)) {
        return false;
      }
      this.liveFrames.set(frame.channel, frame);
      if (this.displayMode === WaveformDisplayMode.Live) {
        this.notify();
      }
      return true;
    }

    if (frame.captureId !== this.captureId) {
      return false;
    }

    const desired = this.desiredViewports.get(frame.channel);
    this.pendingViewports.delete(frame.channel);
    if (
      desired !== undefined &&
      (desired.captureId !== frame.captureId ||
        frame.sourceStartSample > desired.visibleStartSample ||
        frame.sourceEndSample < desired.visibleEndSample)
    ) {
      this.requestDesiredViewport(desired);
      return false;
    }

    this.deepFrames.set(frame.channel, frame);
    if (this.displayMode === WaveformDisplayMode.Deep) {
      this.notify();
    }
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
    if (captureId !== this.captureId || this.displayMode !== WaveformDisplayMode.Deep) {
      return;
    }
    if (!(pixelWidth > 0)) {
      throw new Error("Viewport pixel width must be positive");
    }

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
      if (leftOverscan >= comfort && rightOverscan >= comfort) {
        return;
      }
    }

    if (this.pendingViewports.has(channel)) {
      return;
    }

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
    const source =
      this.displayMode === WaveformDisplayMode.Live ? this.liveFrames : this.deepFrames;

    const series = (channel: Channel): PlotSeriesData => {
      const frame = source.get(channel);
      if (frame === undefined) {
        return emptySeries();
      }
      return [xValues(frame), frame.values];
    };

    return [
      null,
      series(Channel.Ch1),
      series(Channel.Ch2),
      series(Channel.Ch3),
      series(Channel.Ch4),
    ];
  }

  public getFrame(channel: Channel): DecodedWaveformFrame | undefined {
    return this.displayMode === WaveformDisplayMode.Live
      ? this.liveFrames.get(channel)
      : this.deepFrames.get(channel);
  }

  private requestDesiredViewport(desired: DesiredViewport): void {
    const requestId = this.requestViewport(desired);
    this.pendingViewports.set(desired.channel, { requestId });
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}
