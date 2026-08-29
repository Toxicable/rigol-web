import { describe, expect, it } from "vitest";

import {
  DmmMeasurementFunction,
  DmmReadingKind,
  DmmReadingUnavailableReason,
  DmmUnit,
} from "../../shared/dmm-types.js";
import { formatDmmRange, formatDmmReading, formatDmmValue } from "./dmm-format.js";

describe("DMM value formatting", () => {
  it("uses engineering prefixes while retaining fixed significant precision", () => {
    expect(formatDmmValue(0.012345678, DmmUnit.Volts)).toEqual({
      value: "12.345678",
      unit: "mV",
    });
    expect(formatDmmValue(12_345_678, DmmUnit.Ohms)).toEqual({
      value: "12.345678",
      unit: "MΩ",
    });
    expect(formatDmmValue(-0.00012345678, DmmUnit.Amps)).toEqual({
      value: "-123.45678",
      unit: "µA",
    });
  });

  it("keeps very small and very large values deterministic in exponent form", () => {
    expect(formatDmmValue(1e-20, DmmUnit.Volts)).toEqual({
      value: "1.0000000e-8",
      unit: "pV",
    });
    expect(formatDmmValue(1e20, DmmUnit.Ohms)).toEqual({
      value: "1.0000000e+11",
      unit: "GΩ",
    });
  });

  it("uses compact engineering labels for fixed ranges", () => {
    expect(formatDmmRange(1e-4, DmmUnit.Amps)).toBe("100 µA");
    expect(formatDmmRange(50_000_000, DmmUnit.Ohms)).toBe("50 MΩ");
    expect(formatDmmRange(1e-9, DmmUnit.Farads)).toBe("1 nF");
  });

  it("does not scale temperature", () => {
    expect(formatDmmValue(23.5, DmmUnit.Celsius)).toEqual({
      value: "23.500000",
      unit: "°C",
    });
  });

  it("replaces numeric presentation for unavailable snapshots", () => {
    expect(formatDmmReading({
      kind: DmmReadingKind.Unavailable,
      function: DmmMeasurementFunction.DcVoltage,
      unit: DmmUnit.Volts,
      reason: DmmReadingUnavailableReason.ConfigurationChanged,
    })).toEqual({
      value: "—",
      unit: "V",
      detail: "Configuration changed",
      numeric: false,
    });
  });
});
