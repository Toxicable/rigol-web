import { describe, expect, it } from "vitest";

import {
  PPK2_AMPERE_MODE,
  Ppk2Command,
  Ppk2CurrentConverter,
  encodePpk2RegulatorCommand,
  encodePpk2UserGainCommand,
  parsePpk2Metadata,
  requireSafePpk2UserGains,
} from "./ppk2-protocol.js";

function metadataText(overrides: Record<string, string> = {}): string {
  const values: Record<string, string> = {
    vdd: "3300",
    mode: String(PPK2_AMPERE_MODE),
    hw: "2.0.1",
    calibrated: "2026-01-02",
  };
  for (const prefix of ["r", "gs", "gi", "o", "s", "i", "ug"]) {
    for (let range = 0; range < 5; range += 1) {
      values[`${prefix}${range}`] = prefix === "r" || prefix === "gi" || prefix === "ug"
        ? "1"
        : "0";
    }
  }
  Object.assign(values, overrides);
  return `${Object.entries(values).map(([key, value]) => `${key}: ${value}`).join("\n")}\nEND\n`;
}

describe("PPK2 protocol", () => {
  it("parses the complete calibration metadata needed for Ampere conversion", () => {
    const metadata = parsePpk2Metadata(metadataText());

    expect(metadata).toMatchObject({
      vddMv: 3300,
      mode: PPK2_AMPERE_MODE,
      hardwareRevision: "2.0.1",
      calibrated: "2026-01-02",
    });
    expect(metadata.r).toEqual([1, 1, 1, 1, 1]);
    expect(metadata.ug).toEqual([1, 1, 1, 1, 1]);
  });

  it("rejects incomplete, duplicated and unsafe metadata", () => {
    expect(() => parsePpk2Metadata(metadataText().replace("r3: 1\n", "")))
      .toThrow("r3");
    expect(() => parsePpk2Metadata(`${metadataText().replace("END\n", "")}vdd: 3300\nEND\n`))
      .toThrow("Duplicate");
    expect(() => parsePpk2Metadata(metadataText({ vdd: "700" })))
      .toThrow("outside 800..5000");
    expect(() => parsePpk2Metadata(metadataText().replace("END\n", "")))
      .toThrow("terminator END");
  });

  it("encodes regulator and user-gain commands exactly", () => {
    expect([...encodePpk2RegulatorCommand(3300)]).toEqual([
      Ppk2Command.RegulatorSet,
      0x0c,
      0xe4,
    ]);
    const gain = encodePpk2UserGainCommand(2, 1.05);
    expect(gain[0]).toBe(Ppk2Command.SetUserGains);
    expect(gain[1]).toBe(2);
    expect(gain.readFloatLE(2)).toBeCloseTo(1.05);
  });

  it("decodes the packed word fields and applies calibration", () => {
    const metadata = parsePpk2Metadata(metadataText());
    const converter = new Ppk2CurrentConverter(metadata);
    const adc = 1000;
    const range = 2;
    const counter = 17;
    const logic = 0xa5;
    const rawWord = adc | (range << 14) | (counter << 18) | (logic << 24);

    const sample = converter.decode(rawWord >>> 0);

    expect(sample).toMatchObject({ rawWord: rawWord >>> 0, range, counter, logic });
    expect(sample.currentUa).toBeCloseTo(43_945.3125);
  });

  it("replaces unsafe persisted user gains with unity", () => {
    const metadata = parsePpk2Metadata(metadataText({ ug2: "1.25", ug4: "0.7" }));
    expect(requireSafePpk2UserGains(metadata)).toEqual([1, 1, 1, 1, 1]);
  });
});
