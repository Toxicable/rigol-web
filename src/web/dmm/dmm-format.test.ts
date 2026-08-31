import { describe, expect, it } from "vitest";

import {
  DmmMeasurementFunction,
  DmmReadingKind,
  DmmReadingUnavailableReason,
  DmmUnit,
} from "../../shared/dmm-types.js";
import {
  formatDmmRange,
  formatDmmReading,
  formatDmmValue,
} from "./dmm-format.js";

describe("DMM value formatting", () => {
  it("uses engineering prefixes without padding synthetic trailing digits", () => {
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
    expect(formatDmmValue(12.34, DmmUnit.Volts)).toEqual({
      value: "12.34",
      unit: "V",
    });
  });

  it("rounds the primary value to the authoritative snapshot resolution", () => {
    expect(formatDmmReading({
      kind: DmmReadingKind.Value,
      function: DmmMeasurementFunction.AcVoltage,
      value: 12.345678,
      resolution: 0.1,
      unit: DmmUnit.Volts,
    })).toEqual({
      value: "12.3",
      unit: "V",
      detail: null,
      numeric: true,
    });

    expect(formatDmmReading({
      kind: DmmReadingKind.Value,
      function: DmmMeasurementFunction.DcVoltage,
      value: 0.012345678,
      resolution: 1e-6,
      unit: DmmUnit.Volts,
    }).value).toBe("12.346");
  });

  it("does not add trailing zeroes when the value already carries less precision", () => {
    expect(formatDmmReading({
      kind: DmmReadingKind.Value,
      function: DmmMeasurementFunction.DcVoltage,
      value: 12.34,
      resolution: 0.001,
      unit: DmmUnit.Volts,
    }).value).toBe("12.34");
  });

  it("uses the authoritative capacitance range quantum", () => {
    expect(formatDmmReading({
      kind: DmmReadingKind.Value,
      function: DmmMeasurementFunction.Capacitance,
      value: 1.23456789e-6,
      resolution: 1e-9,
      unit: DmmUnit.Farads,
    }).value).toBe("1.235");
  });

  it("keeps very small and very large values deterministic", () => {
    expect(formatDmmValue(1e-20, DmmUnit.Volts)).toEqual({
      value: "1e-8",
      unit: "pV",
    });
    expect(formatDmmValue(1e20, DmmUnit.Ohms)).toEqual({
      value: "100000000000",
      unit: "GΩ",
    });
  });

  it("uses compact engineering labels for fixed ranges", () => {
    expect(formatDmmRange(1e-4, DmmUnit.Amps)).toBe("100 µA");
    expect(formatDmmRange(50_000_000, DmmUnit.Ohms)).toBe("50 MΩ");
    expect(formatDmmRange(1e-9, DmmUnit.Farads)).toBe("1 nF");
  });

  it("does not scale or pad temperature", () => {
    expect(formatDmmValue(23.5, DmmUnit.Celsius)).toEqual({
      value: "23.5",
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

    expect(formatDmmReading({
      kind: DmmReadingKind.Unavailable,
      function: DmmMeasurementFunction.Temperature,
      unit: DmmUnit.Celsius,
      reason: DmmReadingUnavailableReason.ResolutionUnavailable,
    }).detail).toBe("Measurement resolution unavailable");
  });
});
