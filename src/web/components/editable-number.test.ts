import { describe, expect, it } from "vitest";

import { formatEditableNumber, parseEditableNumber } from "./editable-number.js";

describe("editable numeric controls", () => {
  it("keeps displayed values concise", () => {
    expect(formatEditableNumber(0.10492281293927253)).toBe("0.104923");
    expect(formatEditableNumber(18.580165123)).toBe("18.5802");
    expect(formatEditableNumber(-3.890695)).toBe("-3.8907");
    expect(formatEditableNumber(2e-8)).toBe("2e-8");
  });

  it("allows an empty draft while editing but does not commit it as zero", () => {
    expect(parseEditableNumber("")).toBeNull();
    expect(parseEditableNumber("   ")).toBeNull();
  });

  it("accepts normal decimal and scientific notation", () => {
    expect(parseEditableNumber("-1.25")).toBe(-1.25);
    expect(parseEditableNumber("2e-3")).toBe(0.002);
    expect(parseEditableNumber("wat")).toBeNull();
  });
});
