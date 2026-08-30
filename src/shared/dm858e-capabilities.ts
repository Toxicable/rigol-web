import { DmmMeasurementFunction } from "./dmm-types.js";

export const dm858eDcVoltageRanges = [0.1, 1, 10, 100, 1_000] as const;
export const dm858eAcVoltageRanges = [0.1, 1, 10, 100, 750] as const;
export const dm858eCurrentRanges = [1e-4, 1e-3, 1e-2, 1e-1, 1, 3] as const;
export const dm858eResistanceRanges = [
  100,
  1_000,
  10_000,
  100_000,
  1_000_000,
  10_000_000,
  50_000_000,
] as const;
export const dm858eCapacitanceRanges = [
  1e-9,
  1e-8,
  1e-7,
  1e-6,
  1e-5,
  1e-4,
  1e-3,
] as const;
export const dm858eFrequencyVoltageRanges = [0.1, 1, 10, 100, 750] as const;

/**
 * Resolution source for the primary numeric display.
 *
 * Configure means CONFigure? reports a measurement resolution for the function.
 * CapacitanceRange means the User Guide's capacitance range table defines a
 * 3.5-digit display quantum of 1e-3 x the effective capacitance range.
 * Unverified means no authoritative numeric quantum has been established yet;
 * the backend must publish ResolutionUnavailable rather than infer one.
 */
export enum Dm858eReadingResolutionSource {
  Configure = 1,
  CapacitanceRange = 2,
  Unverified = 3,
}

export const dm858eCapacitanceResolutionRatio = 1e-3;

export function dm858eReadingResolutionSource(
  measurementFunction: DmmMeasurementFunction,
): Dm858eReadingResolutionSource {
  switch (measurementFunction) {
    case DmmMeasurementFunction.DcVoltage:
    case DmmMeasurementFunction.AcVoltage:
    case DmmMeasurementFunction.DcCurrent:
    case DmmMeasurementFunction.AcCurrent:
    case DmmMeasurementFunction.Resistance2Wire:
    case DmmMeasurementFunction.Resistance4Wire:
      return Dm858eReadingResolutionSource.Configure;
    case DmmMeasurementFunction.Capacitance:
      return Dm858eReadingResolutionSource.CapacitanceRange;
    case DmmMeasurementFunction.Continuity:
    case DmmMeasurementFunction.Diode:
    case DmmMeasurementFunction.Frequency:
    case DmmMeasurementFunction.Period:
    case DmmMeasurementFunction.Temperature:
      return Dm858eReadingResolutionSource.Unverified;
  }
}

export function dm858eFixedRanges(
  measurementFunction: DmmMeasurementFunction,
): readonly number[] {
  switch (measurementFunction) {
    case DmmMeasurementFunction.DcVoltage:
      return dm858eDcVoltageRanges;
    case DmmMeasurementFunction.AcVoltage:
      return dm858eAcVoltageRanges;
    case DmmMeasurementFunction.DcCurrent:
    case DmmMeasurementFunction.AcCurrent:
      return dm858eCurrentRanges;
    case DmmMeasurementFunction.Resistance2Wire:
    case DmmMeasurementFunction.Resistance4Wire:
      return dm858eResistanceRanges;
    case DmmMeasurementFunction.Frequency:
    case DmmMeasurementFunction.Period:
      return dm858eFrequencyVoltageRanges;
    case DmmMeasurementFunction.Capacitance:
      return dm858eCapacitanceRanges;
    case DmmMeasurementFunction.Continuity:
    case DmmMeasurementFunction.Diode:
    case DmmMeasurementFunction.Temperature:
      return [];
  }
}
