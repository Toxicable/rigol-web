import { describe, expect, it } from "vitest";

import {
  AcquisitionType,
  Channel,
  ChannelBandwidthLimit,
  ChannelCoupling,
  ChannelUnit,
  EdgeSlope,
  MathChannel,
  MathOperator,
  MathSource,
  ScopeRunState,
  TimebaseMode,
  TriggerCoupling,
  TriggerSweep,
  TriggerType,
  WaveformSource,
  waveformSourceForChannel,
  waveformSourceForMath,
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
      bandwidthLimit: ChannelBandwidthLimit.Off,
      unit: ChannelUnit.Volts,
      scale: 1,
      offset: 0,
      probeRatio: 1,
    })) as ScopeState["channels"],
    math: [MathChannel.Math1, MathChannel.Math2, MathChannel.Math3, MathChannel.Math4].map((math) => ({
      math,
      enabled: false,
      operator: MathOperator.Add,
      source1: MathSource.Ch1,
      source2: MathSource.Ch2,
      scale: 1,
      offset: 0,
    })) as ScopeState["math"],
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

function waveform(source: WaveformSource): Dho804Waveform {
  return {
    source,
    unit: ChannelUnit.Volts,
    samples: new Float32Array([1, 2, 3]),
    xIncrement: 1e-6,
    xOrigin: 0,
    xReference: 0,
  };
}

class FakeDriver implements LiveWaveformDriver {
  public readonly calls: WaveformSource[] = [];
  public readonly pointCounts: number[] = [];

  public async readLiveWaveform(source: WaveformSource, pointCount: number): Promise<Dho804Waveform> {
    this.calls.push(source);
    this.pointCounts.push(pointCount);
    return waveform(source);
  }
}

function frameSequence(frame: Uint8Array): number {
  return new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(8, true);
}

function frameSource(frame: Uint8Array): WaveformSource {
  return new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint8(6) as WaveformSource;
}

describe("LiveWaveformService", () => {
  it("reads enabled physical channels as separate fixed 999-point driver calls", async () => {
    const driver = new FakeDriver();
    const frames: Uint8Array[] = [];
    const service = new LiveWaveformService({
      driver,
      getScopeState: createState,
      publishFrame: (frame) => {
        frames.push(frame);
        if (frames.length === 2) service.stop();
      },
    });
    service.start();
    await service.waitForIdle();
    expect(driver.calls).toEqual([
      waveformSourceForChannel(Channel.Ch1),
      waveformSourceForChannel(Channel.Ch3),
    ]);
    expect(driver.pointCounts).toEqual([999, 999]);
    expect(frames).toHaveLength(2);
  });


  it("adds enabled native math traces to the live round-robin", async () => {
    const state = createState();
    state.math = state.math.map((mathState) => ({
      ...mathState,
      enabled: mathState.math === MathChannel.Math1,
    })) as ScopeState["math"];
    const driver = new FakeDriver();
    const frames: Uint8Array[] = [];
    const service = new LiveWaveformService({
      driver,
      getScopeState: () => state,
      publishFrame: (frame) => {
        frames.push(frame);
        if (frames.length === 3) service.stop();
      },
    });
    service.start();
    await service.waitForIdle();
    expect(driver.calls).toEqual([
      waveformSourceForChannel(Channel.Ch1),
      waveformSourceForChannel(Channel.Ch3),
      waveformSourceForMath(MathChannel.Math1),
    ]);
    expect(frameSource(frames[2]!)).toBe(WaveformSource.Math1);
  });

  it("stays idle while stopped, in XY mode, or when no sources are enabled", async () => {
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

    const rollState = createState();
    rollState.horizontal = { ...rollState.horizontal, mode: TimebaseMode.Roll };
    const rollDriver = new FakeDriver();
    const roll = new LiveWaveformService({
      driver: rollDriver,
      getScopeState: () => rollState,
      publishFrame: () => roll.stop(),
    });
    roll.start();
    await roll.waitForIdle();
    expect(rollDriver.calls).toEqual([WaveformSource.Ch1]);
    roll.stop();

    const xyState = createState();
    xyState.horizontal = { ...xyState.horizontal, mode: TimebaseMode.Xy };
    const xy = new LiveWaveformService({
      driver,
      getScopeState: () => xyState,
      publishFrame: () => undefined,
    });
    xy.start();
    await xy.waitForIdle();
    expect(driver.calls).toEqual([]);
    xy.stop();

    const noSources = createState();
    noSources.channels = noSources.channels.map((channel) => ({ ...channel, enabled: false })) as ScopeState["channels"];
    noSources.math = noSources.math.map((mathState) => ({ ...mathState, enabled: false })) as ScopeState["math"];
    const empty = new LiveWaveformService({
      driver,
      getScopeState: () => noSources,
      publishFrame: () => undefined,
    });
    empty.start();
    await empty.waitForIdle();
    expect(driver.calls).toEqual([]);
    empty.stop();
  });

  it("increments live sequence independently per source", async () => {
    const driver = new FakeDriver();
    const sequences = new Map<WaveformSource, number[]>();
    let frameCount = 0;
    const service = new LiveWaveformService({
      driver,
      getScopeState: createState,
      publishFrame: (frame) => {
        const source = frameSource(frame);
        const list = sequences.get(source) ?? [];
        list.push(frameSequence(frame));
        sequences.set(source, list);
        frameCount += 1;
        if (frameCount === 4) service.stop();
      },
    });
    service.start();
    await service.waitForIdle();
    expect(sequences.get(WaveformSource.Ch1)).toEqual([1, 2]);
    expect(sequences.get(WaveformSource.Ch3)).toEqual([1, 2]);
    expect(driver.calls).toEqual([
      WaveformSource.Ch1,
      WaveformSource.Ch3,
      WaveformSource.Ch1,
      WaveformSource.Ch3,
    ]);
  });

  it("reports a failed live read and retries the cycle", async () => {
    const failure = new Error("live read failed");
    let attempts = 0;
    const driver: LiveWaveformDriver = {
      readLiveWaveform: async (source) => {
        attempts += 1;
        if (attempts === 1) throw failure;
        return waveform(source);
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

  it("does not report an in-flight read failure after live acquisition is paused", async () => {
    let rejectRead: ((error: Error) => void) | null = null;
    const failure = new Error("transient waveform failure");
    const driver: LiveWaveformDriver = {
      readLiveWaveform: async () => new Promise<Dho804Waveform>((_resolve, reject) => {
        rejectRead = reject;
      }),
    };
    const errors: unknown[] = [];
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
      publishFrame: () => undefined,
      reportError: (error) => errors.push(error),
    });

    service.start();
    await Promise.resolve();
    void service.pause();
    rejectRead!(failure);
    await service.waitForIdle();
    expect(errors).toEqual([]);
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
    resolveRead!(waveform(WaveformSource.Ch1));
    await service.waitForIdle();
    expect(frames).toEqual([]);
  });

  it("collapses repeated freshness requests while one read is in flight", async () => {
    let resolveFirst: ((value: Dho804Waveform) => void) | null = null;
    let activeReads = 0;
    let maxActiveReads = 0;
    const calls: WaveformSource[] = [];
    const driver: LiveWaveformDriver = {
      readLiveWaveform: async (source) => {
        calls.push(source);
        activeReads += 1;
        maxActiveReads = Math.max(maxActiveReads, activeReads);
        if (calls.length === 1) {
          const result = await new Promise<Dho804Waveform>((resolve) => { resolveFirst = resolve; });
          activeReads -= 1;
          return result;
        }
        activeReads -= 1;
        return waveform(source);
      },
    };
    const service = new LiveWaveformService({
      driver,
      getScopeState: createState,
      publishFrame: () => {
        if (calls.length >= 2) service.stop();
      },
    });
    service.start();
    await Promise.resolve();
    service.requestFresh();
    service.requestFresh();
    service.requestFresh();
    expect(calls).toEqual([WaveformSource.Ch1]);
    expect(resolveFirst).not.toBeNull();
    resolveFirst!(waveform(WaveformSource.Ch1));
    await service.waitForIdle();
    expect(maxActiveReads).toBe(1);
    expect(calls).toEqual([WaveformSource.Ch1, WaveformSource.Ch3]);
  });
});
