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

export interface DmmInfo {
  manufacturer: string;
  model: string;
  serialNumber: string;
  firmwareVersion: string;
}

export interface DmmState {
  function: DmmMeasurementFunction;
  range: DmmRange;
  acquisitionRate: DmmAcquisitionRate;
}

export enum DmmReadingKind {
  Value = 1,
  Overload = 2,
}

export type DmmPrimaryReading =
  | {
      kind: DmmReadingKind.Value;
      sequence: number;
      value: number;
      unit: DmmUnit;
    }
  | {
      kind: DmmReadingKind.Overload;
      sequence: number;
      unit: DmmUnit;
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
      value: DmmRange;
    }
  | {
      kind: DmmControlKind.AcquisitionRate;
      value: DmmAcquisitionRate;
    };
