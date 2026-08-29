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
