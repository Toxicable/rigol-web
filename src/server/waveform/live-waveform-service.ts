import { Channel, ScopeRunState, type ScopeState } from "../../shared/scope-types.js";
import { WaveformKind } from "../../shared/websocket-protocol.js";
import type { Dho804Waveform } from "../scope/dho804-driver.js";
import { encodeWaveformFrame } from "./waveform-frame-encoder.js";

export interface LiveWaveformDriver {
  readLiveWaveform(channel: Channel, pointCount: number): Promise<Dho804Waveform>;
}

export interface LiveWaveformServiceOptions {
  driver: LiveWaveformDriver;
  getScopeState: () => ScopeState;
  publishFrame: (frame: Uint8Array) => void;
  reportError?: (error: unknown) => void;
}

// The DHO804 firmware returns 999 samples when NORMAL/BYTE mode is asked for
// 1000 points. Lower NORMAL point counts crop the visible waveform span rather
// than decimating the whole screen, so live acquisition always uses 999 points.
const LIVE_POINT_COUNT = 999;
const RESUME_SETTLE_DELAY_MS = 200;

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
  private readonly sequences = new Uint32Array(5);
  private liveWanted = false;
  private paused = false;
  private freshWanted = false;
  private loopPromise: Promise<void> | null = null;
  private resumeTimer: ReturnType<typeof setTimeout> | null = null;

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
    if (this.resumeTimer !== null) {
      clearTimeout(this.resumeTimer);
      this.resumeTimer = null;
    }
  }

  public pause(): void {
    this.paused = true;
    this.freshWanted = false;
  }

  public resume(): void {
    this.paused = false;
    if (this.resumeTimer !== null) {
      clearTimeout(this.resumeTimer);
    }
    this.resumeTimer = setTimeout(() => {
      this.resumeTimer = null;
      this.requestFresh();
    }, RESUME_SETTLE_DELAY_MS);
  }

  public requestFresh(): void {
    if (!this.liveWanted || this.paused) {
      return;
    }
    this.freshWanted = true;
    this.ensureLoop();
  }

  public async waitForIdle(): Promise<void> {
    while (this.loopPromise !== null) {
      await this.loopPromise;
    }
  }

  private ensureLoop(): void {
    if (this.loopPromise !== null) {
      return;
    }
    this.loopPromise = this.runLoop().finally(() => {
      this.loopPromise = null;
      if (this.liveWanted && this.freshWanted) {
        this.ensureLoop();
      }
    });
  }

  private async runLoop(): Promise<void> {
    while (this.liveWanted && this.freshWanted) {
      this.freshWanted = false;
      let shouldContinue: boolean;
      try {
        shouldContinue = await this.acquireCycle();
      } catch (error) {
        this.reportError(error);
        shouldContinue = true;
      }

      if (!shouldContinue) {
        return;
      }
      if (this.liveWanted && !this.paused) {
        this.freshWanted = true;
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    }
  }

  private async acquireCycle(): Promise<boolean> {
    const state = this.getScopeState();
    if (state.runState === ScopeRunState.Stopped) {
      return false;
    }

    const enabledChannels = state.channels
      .filter((channelState) => channelState.enabled)
      .map((channelState) => channelState.channel);
    if (enabledChannels.length === 0) {
      return false;
    }

    for (const channel of enabledChannels) {
      if (!this.liveWanted || this.paused) {
        return false;
      }
      const waveform = await this.driver.readLiveWaveform(channel, LIVE_POINT_COUNT);
      if (!this.liveWanted || this.paused) {
        return false;
      }
      if (waveform.channel !== channel) {
        throw new Error(`Driver returned CH${waveform.channel} while reading CH${channel}`);
      }
      this.publishWaveform(waveform);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    return true;
  }

  private publishWaveform(waveform: Dho804Waveform): void {
    const sampleIndices = new Uint32Array(waveform.samples.length);
    for (let index = 0; index < sampleIndices.length; index += 1) {
      sampleIndices[index] = index;
    }
    const sequence = nextUint32(this.sequences[waveform.channel]!);
    const frame = encodeWaveformFrame({
      kind: WaveformKind.Live,
      channel: waveform.channel,
      unit: waveform.unit,
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
    this.sequences[waveform.channel] = sequence;
  }
}
