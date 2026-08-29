import { describe, expect, it } from "vitest";

import {
  ScpiProgramMessageKind,
  classifyScpiProgramMessage,
} from "./scpi-program-message.js";

describe("classifyScpiProgramMessage", () => {
  it("classifies commands and queries", () => {
    expect(classifyScpiProgramMessage("*CLS")).toBe(ScpiProgramMessageKind.Command);
    expect(classifyScpiProgramMessage("*IDN?")).toBe(ScpiProgramMessageKind.Query);
    expect(classifyScpiProgramMessage(":SYSTem:BEEPer?;*OPC?")).toBe(ScpiProgramMessageKind.Query);
  });

  it("ignores question marks inside quoted strings", () => {
    expect(classifyScpiProgramMessage('SYSTem:LABel "what?"')).toBe(
      ScpiProgramMessageKind.Command,
    );
    expect(classifyScpiProgramMessage("SYSTem:LABel 'what?'")).toBe(
      ScpiProgramMessageKind.Command,
    );
  });

  it("handles doubled quote characters inside strings", () => {
    expect(classifyScpiProgramMessage('SYSTem:LABel "what?? ""really?"""')).toBe(
      ScpiProgramMessageKind.Command,
    );
    expect(classifyScpiProgramMessage('SYSTem:LABel "value";*IDN?')).toBe(
      ScpiProgramMessageKind.Query,
    );
  });

  it("rejects empty and multi-line messages", () => {
    expect(() => classifyScpiProgramMessage("   ")).toThrow(/must not be empty/);
    expect(() => classifyScpiProgramMessage("*IDN?\n*OPT?")).toThrow(/exactly one program message/);
    expect(() => classifyScpiProgramMessage("*IDN?\r*OPT?")).toThrow(/exactly one program message/);
  });
});
