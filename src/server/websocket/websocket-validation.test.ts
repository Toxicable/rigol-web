import { describe, expect, it } from "vitest";

import { SupportedInstrument } from "../../shared/instrument-types.js";
import { readScpiInstrument } from "./websocket-validation.js";

describe("WebSocket SCPI target validation", () => {
  it("accepts only the two SCPI instruments", () => {
    expect(readScpiInstrument(SupportedInstrument.Dho804)).toBe(SupportedInstrument.Dho804);
    expect(readScpiInstrument(SupportedInstrument.Dm858e)).toBe(SupportedInstrument.Dm858e);
  });

  it("rejects PPK2 as a SCPI target", () => {
    expect(() => readScpiInstrument(SupportedInstrument.Ppk2))
      .toThrow("PPK2 does not support SCPI");
  });
});
