import { describe, expect, it } from "vitest";

import {
  AcquisitionType,
  Channel,
  ChannelCoupling,
  ChannelUnit,
  EdgeSlope,
  ScopeRunState,
  TimebaseMode,
  TriggerCoupling,
  TriggerSweep,
  TriggerType,
  type ScopeState,
} from "../../shared/scope-types.js";
import { WaveformKind } from "../../shared/websocket-protocol.js";
import { ScpiPriority } from "../scpi/scpi-scheduler.js";
import type { Dho804Waveform } from "../scope/dho804-driver.js";
import { DeepCaptureService, type DeepCaptureDriver } from "./deep-capture-service.js";

function createState(runState = ScopeRunState.Stopped): ScopeState {
  return {
    channels: [Channel.Ch1, Channel.Ch2, Channel.Ch3, Channel.Ch4].map((channel) => ({
      channel,
      enabled: channel === Channel.Ch1 || channel === Channel.Ch2,
      coupling: ChannelCoupling.Dc,
      unit: ChannelUnit.Volts,
      scale: 1,
      offset: 0,
      probeRatio: 1,
    })) as ScopeState["channels"],
    horizontal: { mode: TimebaseMode.Main, scale: 1e-3, position: 0 },
    acquisition: {
      type: AcquisitionType.Normal,
      averages: 2,
      memoryDepth: 100,
      sampleRate: 1_000_000,
    },
    runState,
    trigger: {
      type: TriggerType.Edge,
      sweep: TriggerSweep.Auto,
      source: Channel.Ch1,
      slope: EdgeSlope.Rising,
      level: 0,
      coupling: TriggerCoupling.Dc,
    },
  };
}

function waveform(channel: Channel, samples = 100): Dho804Waveform {
  return {
    channel,
    unit: ChannelUnit.Volts,
    samples: Float32Array.from({ length: samples }, (_, index) => index),
    xIncrement: 1e-6,
    xOrigin: -50e-6,
    xReference: 0,
  };
}

class FakeDriver implements DeepCaptureDriver {
  public state = createState();
  public failChannel: Channel | null = null;
  public readonly calls: string[] = [];

  public async readScopeState(priority: ScpiPriority): Promise<ScopeState> {
    this.calls.push(`state:${priority}`);
    return this.state;
  }

  public async readRawWaveform(channel: Channel, sampleCount: number): Promise<Dho804Waveform> {
    this.calls.push(`raw:${channel}:${sampleCount}`);
    if (this.failChannel === channel) {
      throw new Error("raw failed");
    }
    return waveform(channel, sampleCount);
  }
}

function header(frame: Uint8Array): DataView {
  return new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
}

describe("DeepCaptureService", () => {
  it("reads fresh state then captures every enabled channel sequentially", async () => {
    const driver = new FakeDriver();
    const service = new DeepCaptureService(driver);
    const info = await service.capture();
    expect(info.captureId).toBe(1);
    expect(info.channels.map((item) => item.channel)).toEqual([Channel.Ch1, Channel.Ch2]);
    expect(driver.calls).toEqual(["state:2", "raw:1:100", "raw:2:100"]);
  });

  it("rejects running scopes and scopes with no enabled channels", async () => {
    const running = new FakeDriver();
    running.state = createState(ScopeRunState.Running);
    await expect(new DeepCaptureService(running).capture()).rejects.toThrow(/stopped/);

    const empty = new FakeDriver();
    const state = createState();
    empty.state = { ...state, channels: state.channels.map((channel) => ({ ...channel, enabled: false })) as ScopeState["channels"] };
    await expect(new DeepCaptureService(empty).capture()).rejects.toThrow(/enabled channel/);
  });

  it("keeps the previous completed capture when a replacement fails", async () => {
    const driver = new FakeDriver();
    const service = new DeepCaptureService(driver);
    const first = await service.capture();
    driver.failChannel = Channel.Ch2;
    await expect(service.capture()).rejects.toThrow("raw failed");
    expect(() => service.getViewport({
      captureId: first.captureId,
      channel: Channel.Ch1,
      startSample: 10,
      endSample: 20,
      pixelWidth: 10,
    })).not.toThrow();
  });

  it("invalidates the old capture ID after a successful replacement", async () => {
    const driver = new FakeDriver();
    const service = new DeepCaptureService(driver);
    const first = await service.capture();
    const second = await service.capture();
    expect(second.captureId).toBe(2);
    expect(() => service.getViewport({
      captureId: first.captureId,
      channel: Channel.Ch1,
      startSample: 0,
      endSample: 10,
      pixelWidth: 10,
    })).toThrow(/not the retained capture/);
  });

  it("encodes an overscanned viewport with proportional output density", async () => {
    const driver = new FakeDriver();
    const service = new DeepCaptureService(driver);
    const info = await service.capture();
    const frame = service.getViewport({
      captureId: info.captureId,
      channel: Channel.Ch1,
      startSample: 30,
      endSample: 50,
      pixelWidth: 5,
    });
    const view = header(frame);
    expect(view.getUint8(5)).toBe(WaveformKind.DeepViewport);
    expect(view.getUint32(12, true)).toBe(info.captureId);
    expect(view.getUint32(16, true)).toBe(20);
    expect(view.getUint32(20, true)).toBe(60);
    expect(view.getUint32(24, true)).toBeLessThanOrEqual(20);
    expect(view.getUint32(24, true)).toBeGreaterThan(0);
  });
});
