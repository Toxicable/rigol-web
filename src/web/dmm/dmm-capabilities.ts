import {
  DmmAcquisitionRate,
  DmmMeasurementFunction,
  DmmUnit,
} from "../../shared/dmm-types.js";

export interface DmmFunctionOption {
  readonly value: DmmMeasurementFunction;
  readonly label: string;
  readonly shortLabel: string;
}

export const dmmFunctionOptions: readonly DmmFunctionOption[] = [
  { value: DmmMeasurementFunction.DcVoltage, label: "DC voltage", shortLabel: "DC V" },
  { value: DmmMeasurementFunction.AcVoltage, label: "AC voltage", shortLabel: "AC V" },
  { value: DmmMeasurementFunction.DcCurrent, label: "DC current", shortLabel: "DC A" },
  { value: DmmMeasurementFunction.AcCurrent, label: "AC current", shortLabel: "AC A" },
  { value: DmmMeasurementFunction.Resistance2Wire, label: "2-wire resistance", shortLabel: "2W Ω" },
  { value: DmmMeasurementFunction.Resistance4Wire, label: "4-wire resistance", shortLabel: "4W Ω" },
  { value: DmmMeasurementFunction.Continuity, label: "Continuity", shortLabel: "Cont" },
  { value: DmmMeasurementFunction.Diode, label: "Diode", shortLabel: "Diode" },
  { value: DmmMeasurementFunction.Frequency, label: "Frequency", shortLabel: "Freq" },
  { value: DmmMeasurementFunction.Period, label: "Period", shortLabel: "Period" },
  { value: DmmMeasurementFunction.Capacitance, label: "Capacitance", shortLabel: "Cap" },
  { value: DmmMeasurementFunction.Temperature, label: "Temperature", shortLabel: "Temp" },
];

const dcVoltageRanges = [0.1, 1, 10, 100, 1_000] as const;
const acVoltageRanges = [0.1, 1, 10, 100, 750] as const;
const currentRanges = [1e-4, 1e-3, 1e-2, 1e-1, 1, 3] as const;
const resistanceRanges = [100, 1_000, 10_000, 100_000, 1_000_000, 10_000_000, 50_000_000] as const;
const frequencyVoltageRanges = [0.1, 1, 10, 100, 750] as const;
const capacitanceRanges = [1e-9, 1e-8, 1e-7, 1e-6, 1e-5, 1e-4, 1e-3] as const;

export function dmmFunctionLabel(value: DmmMeasurementFunction): string {
  const option = dmmFunctionOptions.find((candidate) => candidate.value === value);
  if (option === undefined) {
    throw new Error(`Unknown DMM measurement function ${value}`);
  }
  return option.label;
}

export function dmmFixedRanges(value: DmmMeasurementFunction): readonly number[] {
  switch (value) {
    case DmmMeasurementFunction.DcVoltage:
      return dcVoltageRanges;
    case DmmMeasurementFunction.AcVoltage:
      return acVoltageRanges;
    case DmmMeasurementFunction.DcCurrent:
    case DmmMeasurementFunction.AcCurrent:
      return currentRanges;
    case DmmMeasurementFunction.Resistance2Wire:
    case DmmMeasurementFunction.Resistance4Wire:
      return resistanceRanges;
    case DmmMeasurementFunction.Frequency:
    case DmmMeasurementFunction.Period:
      return frequencyVoltageRanges;
    case DmmMeasurementFunction.Capacitance:
      return capacitanceRanges;
    case DmmMeasurementFunction.Continuity:
    case DmmMeasurementFunction.Diode:
    case DmmMeasurementFunction.Temperature:
      return [];
  }
}

export function dmmRangeUnit(value: DmmMeasurementFunction): DmmUnit | null {
  switch (value) {
    case DmmMeasurementFunction.DcVoltage:
    case DmmMeasurementFunction.AcVoltage:
    case DmmMeasurementFunction.Frequency:
    case DmmMeasurementFunction.Period:
      return DmmUnit.Volts;
    case DmmMeasurementFunction.DcCurrent:
    case DmmMeasurementFunction.AcCurrent:
      return DmmUnit.Amps;
    case DmmMeasurementFunction.Resistance2Wire:
    case DmmMeasurementFunction.Resistance4Wire:
      return DmmUnit.Ohms;
    case DmmMeasurementFunction.Capacitance:
      return DmmUnit.Farads;
    case DmmMeasurementFunction.Continuity:
    case DmmMeasurementFunction.Diode:
    case DmmMeasurementFunction.Temperature:
      return null;
  }
}

export function dmmRangeLabel(value: DmmMeasurementFunction): string {
  switch (value) {
    case DmmMeasurementFunction.Frequency:
    case DmmMeasurementFunction.Period:
      return "Input range";
    default:
      return "Range";
  }
}

export function dmmAcquisitionRateLabel(value: DmmAcquisitionRate): string {
  switch (value) {
    case DmmAcquisitionRate.Slow:
      return "Slow · 5.5 digit";
    case DmmAcquisitionRate.Medium:
      return "Medium · 4.5 digit";
    case DmmAcquisitionRate.Fast:
      return "Fast · 4.5 digit";
  }
}
