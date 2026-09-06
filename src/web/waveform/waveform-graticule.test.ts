import { describe, expect, it } from "vitest";

import {
  SCOPE_HORIZONTAL_DIVISIONS,
  SCOPE_VERTICAL_DIVISIONS,
  graticuleLinePositions,
} from "./waveform-graticule.js";

describe("scope waveform graticule", () => {
  it("creates the DHO804 10 by 8 division grid boundaries", () => {
    const vertical = graticuleLinePositions(100, 1_000, SCOPE_HORIZONTAL_DIVISIONS);
    const horizontal = graticuleLinePositions(50, 800, SCOPE_VERTICAL_DIVISIONS);

    expect(vertical).toHaveLength(11);
    expect(vertical[0]).toBe(100);
    expect(vertical[5]).toBe(600);
    expect(vertical[10]).toBe(1_100);

    expect(horizontal).toHaveLength(9);
    expect(horizontal[0]).toBe(50);
    expect(horizontal[4]).toBe(450);
    expect(horizontal[8]).toBe(850);
  });

  it("rejects invalid graticule geometry", () => {
    expect(() => graticuleLinePositions(0, 0, 10)).toThrow("positive span");
    expect(() => graticuleLinePositions(0, 100, 0)).toThrow("positive integer");
  });
});
