import {
  DmmAcquisitionRate,
  DmmMeasurementFunction,
} from "./dmm-types.js";

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

/**
 * Maximum significant digits shown by the browser for one DM858E reading.
 *
 * Variable-rate functions use the instrument's Slow/Medium/Fast digit class.
 * Fixed-resolution functions follow the DM858 Series User Guide section 5.2:
 * temperature and frequency/period are 5.5 digit, continuity/diode are 4.5
 * digit, and capacitance is 3.5 digit. The returned integer is the matching
 * significant-digit ceiling (6/5/4), not permission to add trailing zeroes.
 */
export function dm858eMaximumSignificantDigits(
  measurementFunction: DmmMeasurementFunction,
  acquisitionRate: DmmAcquisitionRate | null,
): number {
  switch (measurementFunction) {
    case DmmMeasurementFunction.Continuity:
    case DmmMeasurementFunction.Diode:
      return 5;
    case DmmMeasurementFunction.Frequency:
    case DmmMeasurementFunction.Period:
    case DmmMeasurementFunction.Temperature:
      return 6;
    case DmmMeasurementFunction.Capacitance:
      return 4;
    case DmmMeasurementFunction.DcVoltage:
    case DmmMeasurementFunction.AcVoltage:
    case DmmMeasurementFunction.DcCurrent:
    case DmmMeasurementFunction.AcCurrent:
    case DmmMeasurementFunction.Resistance2Wire:
    case DmmMeasurementFunction.Resistance4Wire:
      if (acquisitionRate === null) {
        throw new Error("Variable-rate DM858E function is missing acquisition-rate state");
      }
      return acquisitionRate === DmmAcquisitionRate.Slow ? 6 : 5;
  }
}
