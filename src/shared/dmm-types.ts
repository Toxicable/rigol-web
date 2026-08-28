export enum DmmMeasurementFunction {
  DcVoltage = 1,
  AcVoltage = 2,
  DcCurrent = 3,
  AcCurrent = 4,
  Resistance2Wire = 5,
  Resistance4Wire = 6,
  Continuity = 7,
  Diode = 8,
  Frequency = 9,
  Period = 10,
  Capacitance = 11,
  Temperature = 12,
}

export enum DmmRangeMode {
  Auto = 1,
  Fixed = 2,
}

export type DmmRange =
  | {
      mode: DmmRangeMode.Auto;
    }
  | {
      mode: DmmRangeMode.Fixed;
      value: number;
    };

export enum DmmAcquisitionRate {
  Slow = 1,
  Medium = 2,
  Fast = 3,
}

export enum DmmUnit {
  Volts = 1,
  Amps = 2,
  Ohms = 3,
  Hertz = 4,
  Seconds = 5,
  Farads = 6,
  Celsius = 7,
  Unitless = 8,
}

export function dmmUnitForFunction(value: DmmMeasurementFunction): DmmUnit {
  switch (value) {
    case DmmMeasurementFunction.DcVoltage:
    case DmmMeasurementFunction.AcVoltage:
    case DmmMeasurementFunction.Diode:
      return DmmUnit.Volts;
    case DmmMeasurementFunction.DcCurrent:
    case DmmMeasurementFunction.AcCurrent:
      return DmmUnit.Amps;
    case DmmMeasurementFunction.Resistance2Wire:
    case DmmMeasurementFunction.Resistance4Wire:
    case DmmMeasurementFunction.Continuity:
      return DmmUnit.Ohms;
    case DmmMeasurementFunction.Frequency:
      return DmmUnit.Hertz;
    case DmmMeasurementFunction.Period:
      return DmmUnit.Seconds;
    case DmmMeasurementFunction.Capacitance:
      return DmmUnit.Farads;
    case DmmMeasurementFunction.Temperature:
      return DmmUnit.Celsius;
  }
}

export interface DmmInfo {
  manufacturer: string;
  model: string;
  serialNumber: string;
  firmwareVersion: string;
}

export interface DmmState {
  function: DmmMeasurementFunction;
  range: DmmRange | null;
  acquisitionRate: DmmAcquisitionRate | null;
}

export enum DmmReadingKind {
  Value = 1,
  Overload = 2,
  Unavailable = 3,
}

export enum DmmReadingUnavailableReason {
  NoData = 1,
  UnclassifiedSentinel = 2,
  ConfigurationChanged = 3,
}

export type DmmReadingSnapshot =
  | {
      kind: DmmReadingKind.Value;
      function: DmmMeasurementFunction;
      value: number;
      unit: DmmUnit;
    }
  | {
      kind: DmmReadingKind.Overload;
      function: DmmMeasurementFunction;
      unit: DmmUnit;
    }
  | {
      kind: DmmReadingKind.Unavailable;
      function: DmmMeasurementFunction;
      unit: DmmUnit;
      reason: DmmReadingUnavailableReason;
    };

export enum DmmControlKind {
  Function = 1,
  Range = 2,
  AcquisitionRate = 3,
}

export type DmmControlChange =
  | {
      kind: DmmControlKind.Function;
      value: DmmMeasurementFunction;
    }
  | {
      kind: DmmControlKind.Range;
      function: DmmMeasurementFunction;
      value: DmmRange;
    }
  | {
      kind: DmmControlKind.AcquisitionRate;
      function: DmmMeasurementFunction;
      value: DmmAcquisitionRate;
    };
