import { describe, expect, it } from "vitest";

import { ChannelUnit, WaveformSource } from "../../shared/scope-types.js";
import { WaveformKind } from "../../shared/websocket-protocol.js";
import type { DecodedWaveformFrame } from "./waveform-frame-decoder.js";
import {
  initialWaveformCursorState,
  nearestWaveformPoint,
  nearestWaveformTracePoint,
  waveformCursorMarkerCount,
  waveformCursorReducer,
} from "./waveform-cursors.js";

function marker(source: WaveformSource, x: number, y: number) {
  return { source, unit: ChannelUnit.Volts, x, y };
}

function frame(): DecodedWaveformFrame {
  return {
    kind: WaveformKind.Live,
    source: WaveformSource.Ch1,
    unit: ChannelUnit.Volts,
    sequence: 1,
    captureId: 0,
    sourceStartSample: 10,
    sourceEndSample: 51,
    xIncrement: 1e-6,
    xOrigin: 0,
    xReference: 0,
    sampleIndices: Uint32Array.from([10, 20, 50]),
    values: Float32Array.from([1, 2, 5]),
  };
}

describe("waveform cursors", () => {
  it("places A then B and cycles the next placement back to A", () => {
    const first = waveformCursorReducer(initialWaveformCursorState, {
      type: "place",
      marker: marker(WaveformSource.Ch1, 1, 2),
    });
    const second = waveformCursorReducer(first, {
      type: "place",
      marker: marker(WaveformSource.Ch2, 3, 4),
    });

    expect(first.markerA).toEqual(marker(WaveformSource.Ch1, 1, 2));
    expect(first.nextSlot).toBe("B");
    expect(second.markerB).toEqual(marker(WaveformSource.Ch2, 3, 4));
    expect(second.nextSlot).toBe("A");
    expect(waveformCursorMarkerCount(second)).toBe(2);
  });

  it("moves a stored marker without changing the next placement slot", () => {
    const withA = waveformCursorReducer(initialWaveformCursorState, {
      type: "place",
      marker: marker(WaveformSource.Ch1, 1, 2),
    });
    const moved = waveformCursorReducer(withA, {
      type: "move",
      slot: "A",
      marker: marker(WaveformSource.Math1, 5, 6),
    });

    expect(moved.markerA).toEqual(marker(WaveformSource.Math1, 5, 6));
    expect(moved.nextSlot).toBe("B");
  });

  it("clears markers but leaves cursor mode armed", () => {
    const armed = waveformCursorReducer(initialWaveformCursorState, { type: "set-armed", value: true });
    const withA = waveformCursorReducer(armed, {
      type: "place",
      marker: marker(WaveformSource.Ch1, 1, 2),
    });
    const cleared = waveformCursorReducer(withA, { type: "clear" });

    expect(cleared.armed).toBe(true);
    expect(cleared.markerA).toBeNull();
    expect(cleared.markerB).toBeNull();
    expect(cleared.nextSlot).toBe("A");
  });

  it("snaps to the nearest delivered waveform sample", () => {
    const middle = nearestWaveformPoint(frame(), 18e-6);
    const first = nearestWaveformPoint(frame(), -1);
    const last = nearestWaveformPoint(frame(), 1);

    expect(middle?.x).toBeCloseTo(20e-6);
    expect(middle?.y).toBe(2);
    expect(first?.x).toBeCloseTo(10e-6);
    expect(first?.y).toBe(1);
    expect(last?.x).toBeCloseTo(50e-6);
    expect(last?.y).toBe(5);
  });

  it("snaps onto a vertical trace segment instead of choosing an endpoint", () => {
    const vertical = {
      ...frame(),
      sampleIndices: Uint32Array.from([10, 20, 30]),
      values: Float32Array.from([1, 1, 5]),
    };

    const point = nearestWaveformTracePoint(vertical, 25e-6, 3, 1e6, 10);

    expect(point?.x).toBeCloseTo(25e-6);
    expect(point?.y).toBeCloseTo(3);
    expect(point?.distance).toBeCloseTo(0);
  });
});
