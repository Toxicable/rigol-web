import { describe, expect, it } from "vitest";

import {
  channelOffsetFromMarkerDrag,
  horizontalPositionFromDrag,
  horizontalRangeFromDrag,
  triggerLevelFromMarkerDrag,
} from "./interaction-math.js";

describe("interaction math", () => {
  it("converts horizontal drag pixels to scope position with grab-pan sign", () => {
    expect(horizontalPositionFromDrag(1, 100, 1000, 0.01)).toBeCloseTo(0.99);
    expect(horizontalPositionFromDrag(1, -100, 1000, 0.01)).toBeCloseTo(1.01);
  });

  it("pans a retained deep range locally with the same grab-pan sign", () => {
    expect(horizontalRangeFromDrag({ xMin: -0.05, xMax: 0.05 }, 100, 1000)).toEqual({
      xMin: -0.060000000000000005,
      xMax: 0.04,
    });
    expect(horizontalRangeFromDrag({ xMin: -0.05, xMax: 0.05 }, -100, 1000)).toEqual({
      xMin: -0.04,
      xMax: 0.060000000000000005,
    });
  });

  it("converts an in-range channel marker drag using eight divisions", () => {
    expect(channelOffsetFromMarkerDrag(0, 400, -100, 800, 2)).toBeCloseTo(2);
    expect(channelOffsetFromMarkerDrag(0, 400, 100, 800, 2)).toBeCloseTo(-2);
  });

  it("rebases a clamped offscreen channel marker onto the visible scale once dragged", () => {
    expect(channelOffsetFromMarkerDrag(-10, 800, -100, 800, 0.25)).toBeCloseTo(-0.75);
    expect(channelOffsetFromMarkerDrag(10, 0, 100, 800, 0.25)).toBeCloseTo(0.75);
  });

  it("does not rebase a clamped channel marker on click without movement", () => {
    expect(channelOffsetFromMarkerDrag(-10, 800, 0, 800, 0.25)).toBe(-10);
  });

  it("rebases trigger level from the displayed marker position once dragged", () => {
    expect(triggerLevelFromMarkerDrag(1, 100, -50, 400, 0.5, 0)).toBeCloseTo(1.5);
    expect(triggerLevelFromMarkerDrag(50, 400, -100, 400, 0.5, -10)).toBeCloseTo(9);
  });

  it("does not rebase a clamped trigger marker on click without movement", () => {
    expect(triggerLevelFromMarkerDrag(50, 400, 0, 400, 0.5, -10)).toBe(50);
  });
});
