import { describe, expect, it } from "vitest";

import {
  channelOffsetFromDrag,
  horizontalPositionFromDrag,
  horizontalRangeFromDrag,
  triggerLevelFromDrag,
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

  it("converts vertical channel drag using eight divisions", () => {
    expect(channelOffsetFromDrag(0, -100, 800, 2)).toBeCloseTo(2);
    expect(channelOffsetFromDrag(0, 100, 800, 2)).toBeCloseTo(-2);
  });

  it("uses the same vertical sign and division scaling for trigger level", () => {
    expect(triggerLevelFromDrag(1, -50, 400, 0.5)).toBeCloseTo(1.5);
  });
});
