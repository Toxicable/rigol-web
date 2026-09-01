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
import type { Dho804Waveform } from "../scope/dho804-driver.js";
import { LiveWaveformService, type LiveWaveformDriver } from "./live-waveform-service.js";

function createState(runState = ScopeRunState.Running): ScopeState {
  return {
    channels: [Channel.Ch1, Channel.Ch2, Channel.Ch3, Channel.Ch4].map((channel) => ({
      channel,
      enabled: channel === Channel.Ch1 || channel === Channel.Ch3,
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
      memoryDepth: 1_000,
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

function waveform(channel: Channel): Dho804Waveform {
  return {
    channel,
    unit: ChannelUnit.Volts,
    samples: new Float32Array([1, 2, 3]),
    xIncrement: 1e-6,
    xOrigin: 0,
    xReference: 0,
  };
}

class FakeDriver implements LiveWaveformDriver {
  public readonly calls: Channel[] = [];
  public readonly pointCounts: number[] = [];

  public async readLiveWaveform(channel: Channel, pointCount: number): Promise<Dho804Waveform> {
    this.calls.push(channel);
    this.pointCounts.push(pointCount);
    return waveform(channel);
  }
}

function frameSequence(frame: Uint8Array): number {
  return new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(8, true);
}

describe("LiveWaveformService", () => {
  it("reads enabled channels as separate fixed 999-point driver calls", async () => {
    const driver = new FakeDriver();
    const frames: Uint8Array[] = [];
    const service = new LiveWaveformService({
      driver,
      getScopeState: createState,
      publishFrame: (frame) => {
        frames.push(frame);
        if (frames.length === 2) {
          service.stop();
        }
      },
    });
    service.start();
    await service.waitForIdle();
    expect(driver.calls).toEqual([Channel.Ch1, Channel.Ch3]);
    expect(driver.pointCounts).toEqual([999, 999]);
    expect(frames).toHaveLength(2);
  });

  it("stays idle while stopped or when no channels are enabled", async () => {
    const driver = new FakeDriver();
    const stopped = new LiveWaveformService({
      driver,
      getScopeState: () => createState(ScopeRunState.Stopped),
      publishFrame: () => undefined,
    });
    stopped.start();
    await stopped.waitForIdle();
    expect(driver.calls).toEqual([]);
    stopped.stop();

    const noChannels = createState();
    noChannels.channels = noChannels.channels.map((channel) => ({ ...channel, enabled: false })) as ScopeState["channels"];
    const empty = new LiveWaveformService({
      driver,
      getScopeState: () => noChannels,
      publishFrame: () => undefined,
    });
    empty.start();
    await empty.waitForIdle();
    expect(driver.calls).toEqual([]);
    empty.stop();
  });

  it("increments live sequence independently per channel", async () => {
    const driver = new FakeDriver();
    const sequences = new Map<Channel, number[]>();
    let frameCount = 0;
    const service = new LiveWaveformService({
      driver,
      getScopeState: createState,
      publishFrame: (frame) => {
        const channel = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint8(6) as Channel;
        const list = sequences.get(channel) ?? [];
        list.push(frameSequence(frame));
        sequences.set(channel, list);
        frameCount += 1;
        if (frameCount === 4) {
          service.stop();
        }
      },
    });
    service.start();
    await service.waitForIdle();
    expect(sequences.get(Channel.Ch1)).toEqual([1, 2]);
    expect(sequences.get(Channel.Ch3)).toEqual([1, 2]);
    expect(driver.calls).toEqual([
      Channel.Ch1,
      Channel.Ch3,
      Channel.Ch1,
      Channel.Ch3,
    ]);
  });

  it("reports a failed live read and retries the cycle", async () => {
    const failure = new Error("live read failed");
    let attempts = 0;
    const driver: LiveWaveformDriver = {
      readLiveWaveform: async (channel) => {
        attempts += 1;
        if (attempts === 1) {
          throw failure;
        }
        return waveform(channel);
      },
    };
    const errors: unknown[] = [];
    const frames: Uint8Array[] = [];
    const service = new LiveWaveformService({
      driver,
      getScopeState: () => {
        const state = createState();
        state.channels = state.channels.map((channel) => ({
          ...channel,
          enabled: channel.channel === Channel.Ch1,
        })) as ScopeState["channels"];
        return state;
      },
      publishFrame: (frame) => {
        frames.push(frame);
        service.stop();
      },
      reportError: (error) => errors.push(error),
    });

    service.start();
    await service.waitForIdle();

    expect(errors).toEqual([failure]);
    expect(attempts).toBe(2);
    expect(frames).toHaveLength(1);
  });

  it("does not publish a read that completes after the service is stopped", async () => {
    let resolveRead: ((value: Dho804Waveform) => void) | null = null;
    const driver: LiveWaveformDriver = {
      readLiveWaveform: async () => new Promise<Dho804Waveform>((resolve) => {
        resolveRead = resolve;
      }),
    };
    const frames: Uint8Array[] = [];
    const service = new LiveWaveformService({
      driver,
      getScopeState: () => {
        const state = createState();
        state.channels = state.channels.map((channel) => ({
          ...channel,
          enabled: channel.channel === Channel.Ch1,
        })) as ScopeState["channels"];
        return state;
      },
      publishFrame: (frame) => frames.push(frame),
    });

    service.start();
    await Promise.resolve();
    expect(resolveRead).not.toBeNull();
    service.stop();
    resolveRead!(waveform(Channel.Ch1));
    await service.waitForIdle();

    expect(frames).toEqual([]);
  });

  it("collapses repeated freshness requests while one read is in flight", async () => {
    let resolveFirst: ((value: Dho804Waveform) => void) | null = null;
    let activeReads = 0;
    let maxActiveReads = 0;
    const calls: Channel[] = [];
    const driver: LiveWaveformDriver = {
      readLiveWaveform: async (channel) => {
        calls.push(channel);
        activeReads += 1;
        maxActiveReads = Math.max(maxActiveReads, activeReads);
        if (calls.length === 1) {
          const result = await new Promise<Dho804Waveform>((resolve) => {
            resolveFirst = resolve;
          });
          activeReads -= 1;
          return result;
        }
        activeReads -= 1;
        return waveform(channel);
      },
    };
    const service = new LiveWaveformService({
      driver,
      getScopeState: createState,
      publishFrame: () => {
        if (calls.length >= 2) {
          service.stop();
        }
      },
    });
    service.start();
    await Promise.resolve();
    service.requestFresh();
    service.requestFresh();
    service.requestFresh();
    expect(calls).toEqual([Channel.Ch1]);
    expect(resolveFirst).not.toBeNull();
    resolveFirst!(waveform(Channel.Ch1));
    await service.waitForIdle();
    expect(maxActiveReads).toBe(1);
    expect(calls).toEqual([Channel.Ch1, Channel.Ch3]);
  });
});
