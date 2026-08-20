import {
  Channel,
  ScopeRunState,
  type ScopeState,
} from "../../shared/scope-types.js";
import {
  WaveformKind,
  type DeepCaptureChannelInfo,
  type NonEmptyArray,
} from "../../shared/websocket-protocol.js";
import { ScpiPriority } from "../scpi/scpi-scheduler.js";
import type { Dho804Waveform } from "../scope/dho804-driver.js";
import { downsampleWaveform } from "./downsample.js";
import { encodeWaveformFrame } from "./waveform-frame-encoder.js";

export interface DeepCaptureDriver {
  readScopeState(priority: ScpiPriority): Promise<ScopeState>;
  readRawWaveform(channel: Channel, sampleCount: number): Promise<Dho804Waveform>;
}

export interface DeepCaptureInfo {
  captureId: number;
  channels: NonEmptyArray<DeepCaptureChannelInfo>;
}

export interface DeepViewportRequest {
  captureId: number;
  channel: Channel;
  startSample: number;
  endSample: number;
  pixelWidth: number;
}

interface DeepChannelCapture extends Dho804Waveform {}

interface DeepCapture {
  id: number;
  channels: NonEmptyArray<DeepChannelCapture>;
}

const UINT32_MAX = 0xffff_ffff;

function nextPositiveUint32(value: number): number {
  return value >= UINT32_MAX ? 1 : value + 1;
}

function nextUint32(value: number): number {
  return (value + 1) >>> 0;
}

function requirePositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
}

export class DeepCaptureService {
  private retainedCapture: DeepCapture | null = null;
  private lastCaptureId = 0;
  private frameSequence = 0;

  public constructor(private readonly driver: DeepCaptureDriver) {}

  public async capture(): Promise<DeepCaptureInfo> {
    const state = await this.driver.readScopeState(ScpiPriority.Normal);
    if (state.runState !== ScopeRunState.Stopped) {
      throw new Error("Deep capture requires the scope to be stopped");
    }

    const enabledChannels = state.channels
      .filter((channelState) => channelState.enabled)
      .map((channelState) => channelState.channel);
    if (enabledChannels.length === 0) {
      throw new Error("Deep capture requires at least one enabled channel");
    }
    requirePositiveInteger(state.acquisition.memoryDepth, "Scope memory depth");

    const channels: DeepChannelCapture[] = [];
    for (const channel of enabledChannels) {
      const waveform = await this.driver.readRawWaveform(channel, state.acquisition.memoryDepth);
      if (waveform.channel !== channel) {
        throw new Error(`Driver returned CH${waveform.channel} while reading CH${channel}`);
      }
      if (waveform.samples.length !== state.acquisition.memoryDepth) {
        throw new Error(
          `Deep waveform CH${channel} returned ${waveform.samples.length} samples instead of ${state.acquisition.memoryDepth}`,
        );
      }
      channels.push(waveform);
    }

    const captureId = nextPositiveUint32(this.lastCaptureId);
    const completed: DeepCapture = {
      id: captureId,
      channels: channels as NonEmptyArray<DeepChannelCapture>,
    };
    this.retainedCapture = completed;
    this.lastCaptureId = captureId;

    return {
      captureId,
      channels: completed.channels.map((channelCapture) => ({
        channel: channelCapture.channel,
        unit: channelCapture.unit,
        sampleCount: channelCapture.samples.length,
        xIncrement: channelCapture.xIncrement,
        xOrigin: channelCapture.xOrigin,
        xReference: channelCapture.xReference,
      })) as NonEmptyArray<DeepCaptureChannelInfo>,
    };
  }

  public getViewport(request: DeepViewportRequest): Uint8Array {
    const capture = this.retainedCapture;
    if (capture === null || request.captureId !== capture.id) {
      throw new Error(`Deep capture ${request.captureId} is not the retained capture`);
    }
    const channelCapture = capture.channels.find((item) => item.channel === request.channel);
    if (channelCapture === undefined) {
      throw new Error(`Deep capture ${capture.id} does not contain CH${request.channel}`);
    }
    if (!Number.isInteger(request.startSample)
      || !Number.isInteger(request.endSample)
      || request.startSample < 0
      || request.endSample <= request.startSample
      || request.endSample > channelCapture.samples.length) {
      throw new Error("Deep viewport source range is invalid");
    }
    requirePositiveInteger(request.pixelWidth, "Deep viewport pixelWidth");

    const visibleWidth = request.endSample - request.startSample;
    const wantedWidth = Math.min(channelCapture.samples.length, visibleWidth * 2);
    const initialLeft = Math.floor((wantedWidth - visibleWidth) / 2);
    let expandedStart = Math.max(0, request.startSample - initialLeft);
    let expandedEnd = Math.min(channelCapture.samples.length, expandedStart + wantedWidth);
    if (expandedEnd - expandedStart < wantedWidth) {
      expandedStart = Math.max(0, expandedEnd - wantedWidth);
    }
    expandedEnd = Math.min(channelCapture.samples.length, expandedStart + wantedWidth);

    const expandedWidth = expandedEnd - expandedStart;
    const effectivePixels = Math.ceil(
      request.pixelWidth * expandedWidth / visibleWidth,
    );
    const downsampled = downsampleWaveform(
      channelCapture.samples,
      expandedStart,
      expandedEnd,
      effectivePixels,
    );

    this.frameSequence = nextUint32(this.frameSequence);
    return encodeWaveformFrame({
      kind: WaveformKind.DeepViewport,
      channel: channelCapture.channel,
      unit: channelCapture.unit,
      sequence: this.frameSequence,
      captureId: capture.id,
      sourceStartSample: expandedStart,
      sourceEndSample: expandedEnd,
      xIncrement: channelCapture.xIncrement,
      xOrigin: channelCapture.xOrigin,
      xReference: channelCapture.xReference,
      sampleIndices: downsampled.sampleIndices,
      values: downsampled.values,
    });
  }
}
