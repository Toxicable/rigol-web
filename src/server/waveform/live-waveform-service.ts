import {
  ScopeRunState,
  TimebaseMode,
  waveformSourceForChannel,
  waveformSourceForMath,
  waveformSourceUnit,
  type ScopeState,
  type WaveformSource,
} from "../../shared/scope-types.js";
import { WaveformKind } from "../../shared/websocket-protocol.js";
import type { Dho804Waveform } from "../scope/dho804-driver.js";
import { encodeWaveformFrame } from "./waveform-frame-encoder.js";

export interface LiveWaveformDriver {
  readLiveWaveform(source: WaveformSource, pointCount: number): Promise<Dho804Waveform>;
}

export interface LiveWaveformServiceOptions {
  driver: LiveWaveformDriver;
  getScopeState: () => ScopeState;
  publishFrame: (frame: Uint8Array) => void;
  reportError?: (error: unknown) => void;
}

// The DHO804's native normal-mode live response is 999 BYTE samples.
const LIVE_POINT_COUNT = 999;
// Keep a small floor so a very short timebase does not turn into a busy loop.
const LIVE_POLL_MIN_INTERVAL_MS = 100;
const LIVE_POLL_MARGIN_MS = 50;

function nextUint32(value: number): number {
  return (value + 1) >>> 0;
}

function defaultReportError(error: unknown): void {
  console.error("Live waveform acquisition failed", error);
}

export class LiveWaveformService {
  private readonly driver: LiveWaveformDriver;
  private readonly getScopeState: () => ScopeState;
  private readonly publishFrame: (frame: Uint8Array) => void;
  private readonly reportError: (error: unknown) => void;
  private readonly sequences = new Uint32Array(9);
  private liveWanted = false;
  private paused = false;
  private freshWanted = false;
  private loopPromise: Promise<void> | null = null;
  private nextPollDelayMs = LIVE_POLL_MIN_INTERVAL_MS;

  public constructor(options: LiveWaveformServiceOptions) {
    this.driver = options.driver;
    this.getScopeState = options.getScopeState;
    this.publishFrame = options.publishFrame;
    this.reportError = options.reportError ?? defaultReportError;
  }

  public start(): void {
    this.liveWanted = true;
    this.requestFresh();
  }

  public stop(): void {
    this.liveWanted = false;
    this.freshWanted = false;
  }

  public async pause(): Promise<void> {
    this.paused = true;
    this.freshWanted = false;
    await this.waitForIdle();
  }

  public resume(): void {
    this.paused = false;
    this.requestFresh();
  }

  public requestFresh(): void {
    if (!this.liveWanted || this.paused) return;
    this.freshWanted = true;
    this.ensureLoop();
  }

  public async waitForIdle(): Promise<void> {
    while (this.loopPromise !== null) await this.loopPromise;
  }

  private ensureLoop(): void {
    if (this.loopPromise !== null) return;
    this.loopPromise = this.runLoop().finally(() => {
      this.loopPromise = null;
      if (this.liveWanted && this.freshWanted) this.ensureLoop();
    });
  }

  private async runLoop(): Promise<void> {
    while (this.liveWanted && this.freshWanted) {
      this.freshWanted = false;
      let shouldContinue: boolean;
      try {
        shouldContinue = await this.acquireCycle();
      } catch (error) {
        if (!this.paused) this.reportError(error);
        shouldContinue = !this.paused;
      }
      if (!shouldContinue) return;
      if (this.liveWanted && !this.paused) {
        this.freshWanted = true;
        await new Promise<void>((resolve) => setTimeout(resolve, this.nextPollDelayMs));
      }
    }
  }

  private async acquireCycle(): Promise<boolean> {
    const state = this.getScopeState();
    if (state.runState === ScopeRunState.Stopped || state.horizontal.mode === TimebaseMode.Xy) {
      return false;
    }

    const sources: WaveformSource[] = [
      ...state.channels
        .filter((channelState) => channelState.enabled)
        .map((channelState) => waveformSourceForChannel(channelState.channel)),
      ...state.math
        .filter((mathState) => mathState.enabled)
        .map((mathState) => waveformSourceForMath(mathState.math)),
    ];
    if (sources.length === 0) return false;
    for (const source of sources) {
      if (!this.liveWanted || this.paused) return false;
      const waveform = await this.driver.readLiveWaveform(source, LIVE_POINT_COUNT);
      if (!this.liveWanted || this.paused) return false;
      if (waveform.source !== source) {
        throw new Error(`Driver returned waveform source ${waveform.source} while reading ${source}`);
      }
      this.nextPollDelayMs = state.horizontal.mode === TimebaseMode.Roll
        ? LIVE_POLL_MIN_INTERVAL_MS
        : Math.max(
            LIVE_POLL_MIN_INTERVAL_MS,
            waveform.xIncrement * waveform.samples.length * 1_000 + LIVE_POLL_MARGIN_MS,
          );
      this.publishWaveform(waveform, waveformSourceUnit(state, source));
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    return true;
  }

  private publishWaveform(waveform: Dho804Waveform, unit: Dho804Waveform["unit"]): void {
    const sampleIndices = new Uint32Array(waveform.samples.length);
    for (let index = 0; index < sampleIndices.length; index += 1) sampleIndices[index] = index;
    const sequence = nextUint32(this.sequences[waveform.source]!);
    const frame = encodeWaveformFrame({
      kind: WaveformKind.Live,
      source: waveform.source,
      unit,
      sequence,
      captureId: 0,
      sourceStartSample: 0,
      sourceEndSample: waveform.samples.length,
      xIncrement: waveform.xIncrement,
      xOrigin: waveform.xOrigin,
      xReference: waveform.xReference,
      sampleIndices,
      values: waveform.samples,
    });
    this.publishFrame(frame);
    this.sequences[waveform.source] = sequence;
  }
}
