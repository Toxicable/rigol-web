import { describe, expect, it, vi } from "vitest";

import { Channel, ChannelUnit } from "../../shared/scope-types.js";
import { WaveformKind, type DeepCaptureChannelInfo } from "../../shared/websocket-protocol.js";
import type { DecodedWaveformFrame } from "./waveform-frame-decoder.js";
import {
  WaveformController,
  WaveformDisplayMode,
  timeRangeToSampleRange,
} from "./waveform-controller.js";

function frame(
  channel: Channel,
  kind: WaveformKind,
  sequence: number,
  captureId = 0,
  start = 0,
  end = 100,
): DecodedWaveformFrame {
  return {
    kind,
    channel,
    unit: ChannelUnit.Volts,
    sequence,
    captureId,
    sourceStartSample: start,
    sourceEndSample: end,
    xIncrement: 1e-6,
    xOrigin: 0,
    xReference: 0,
    sampleIndices: new Uint32Array([start, end - 1]),
    values: new Float32Array([1, 2]),
  };
}

const INFO: DeepCaptureChannelInfo = {
  channel: Channel.Ch1,
  unit: ChannelUnit.Volts,
  sampleCount: 1000,
  xIncrement: 1e-6,
  xOrigin: 0,
  xReference: 0,
};

const ALL_ENABLED = [Channel.Ch1, Channel.Ch2, Channel.Ch3, Channel.Ch4].map(
  (channel) => ({ channel, enabled: true }),
);

describe("waveform controller", () => {
  it("ignores stale live sequences independently per channel", () => {
    const controller = new WaveformController(() => 0);
    expect(controller.acceptFrame(frame(Channel.Ch1, WaveformKind.Live, 5))).toBe(true);
    expect(controller.acceptFrame(frame(Channel.Ch2, WaveformKind.Live, 2))).toBe(true);
    expect(controller.acceptFrame(frame(Channel.Ch1, WaveformKind.Live, 4))).toBe(false);
    expect(controller.getFrame(Channel.Ch1)?.sequence).toBe(5);
    expect(controller.getFrame(Channel.Ch2)?.sequence).toBe(2);
  });

  it("clears disabled live channels and ignores late frames until re-enabled", () => {
    const controller = new WaveformController(() => 0);
    controller.acceptFrame(frame(Channel.Ch1, WaveformKind.Live, 5));

    controller.setLiveChannels(
      ALL_ENABLED.map((channel) =>
        channel.channel === Channel.Ch1 ? { ...channel, enabled: false } : channel,
      ),
    );
    expect(controller.getFrame(Channel.Ch1)).toBeUndefined();
    expect(controller.acceptFrame(frame(Channel.Ch1, WaveformKind.Live, 6))).toBe(false);

    controller.setLiveChannels(ALL_ENABLED);
    expect(controller.getFrame(Channel.Ch1)).toBeUndefined();
    expect(controller.acceptFrame(frame(Channel.Ch1, WaveformKind.Live, 7))).toBe(true);
    expect(controller.getFrame(Channel.Ch1)?.sequence).toBe(7);
  });

  it("uses cached deep overscan for a small pan and requests near a boundary", () => {
    const request = vi.fn(() => 1);
    const controller = new WaveformController(request);
    controller.setDeepCapture(12);
    controller.acceptFrame(frame(Channel.Ch1, WaveformKind.DeepViewport, 1, 12, 100, 500));

    controller.setDesiredDeepTimeRange(12, Channel.Ch1, 0.0002, 0.0003, 800, INFO);
    expect(request).not.toHaveBeenCalled();

    controller.setDesiredDeepTimeRange(12, Channel.Ch1, 0.00011, 0.00025, 800, INFO);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]?.[0]).toMatchObject({
      captureId: 12,
      channel: Channel.Ch1,
      startSample: 110,
      endSample: 251,
    });
  });

  it("ignores deep responses that do not cover the newer desired viewport", () => {
    const controller = new WaveformController(() => 0);
    controller.setDeepCapture(7);
    controller.setDesiredDeepTimeRange(7, Channel.Ch1, 0.0004, 0.0005, 700, INFO);
    expect(controller.acceptFrame(frame(Channel.Ch1, WaveformKind.DeepViewport, 1, 7, 100, 350))).toBe(false);
    expect(controller.acceptFrame(frame(Channel.Ch1, WaveformKind.DeepViewport, 2, 7, 350, 600))).toBe(true);
  });

  it("keeps only one deep viewport request in flight while the desired view moves", () => {
    const request = vi.fn(() => 1);
    const controller = new WaveformController(request);
    controller.setDeepCapture(4);
    controller.setDesiredDeepTimeRange(4, Channel.Ch1, 0.0001, 0.0002, 800, INFO);
    controller.setDesiredDeepTimeRange(4, Channel.Ch1, 0.00011, 0.00021, 800, INFO);
    controller.setDesiredDeepTimeRange(4, Channel.Ch1, 0.00012, 0.00022, 800, INFO);
    expect(request).toHaveBeenCalledTimes(1);

    expect(controller.acceptFrame(frame(Channel.Ch1, WaveformKind.DeepViewport, 1, 4, 90, 205))).toBe(false);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("retires deep mode and ignores later viewport work for the retired capture", () => {
    const request = vi.fn(() => 1);
    const controller = new WaveformController(request);
    controller.setDeepCapture(8);
    controller.acceptFrame(frame(Channel.Ch1, WaveformKind.DeepViewport, 1, 8));

    controller.retireDeepCapture();
    expect(controller.getDisplayMode()).toBe(WaveformDisplayMode.Live);
    expect(controller.getFrame(Channel.Ch1)).toBeUndefined();

    controller.setDesiredDeepTimeRange(8, Channel.Ch1, 0, 0.0001, 800, INFO);
    expect(request).not.toHaveBeenCalled();
    expect(controller.acceptFrame(frame(Channel.Ch1, WaveformKind.DeepViewport, 2, 8))).toBe(false);
  });

  it("clears live and deep buffers at a new scope session boundary", () => {
    const controller = new WaveformController(() => 0);
    controller.acceptFrame(frame(Channel.Ch1, WaveformKind.Live, 5));
    controller.setDeepCapture(6);
    controller.acceptFrame(frame(Channel.Ch2, WaveformKind.DeepViewport, 1, 6));

    controller.resetSession();
    expect(controller.getDisplayMode()).toBe(WaveformDisplayMode.Live);
    expect(controller.getFrame(Channel.Ch1)).toBeUndefined();
    expect(controller.getFrame(Channel.Ch2)).toBeUndefined();
  });

  it("converts time ranges to half-open sample ranges", () => {
    expect(timeRangeToSampleRange(10.2e-6, 20.1e-6, INFO)).toEqual({
      startSample: 10,
      endSample: 21,
    });
  });

  it("returns live or deep data according to explicit display mode", () => {
    const controller = new WaveformController(() => 0);
    controller.acceptFrame(frame(Channel.Ch1, WaveformKind.Live, 1));
    expect(controller.getPlotData()[1][1][0]).toBe(1);
    controller.setDeepCapture(3);
    controller.acceptFrame(frame(Channel.Ch1, WaveformKind.DeepViewport, 1, 3));
    expect(controller.getDisplayMode()).toBe(WaveformDisplayMode.Deep);
    expect(controller.getPlotData()[1][1][0]).toBe(1);
  });
});
