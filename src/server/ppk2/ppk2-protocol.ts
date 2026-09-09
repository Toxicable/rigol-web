import { Buffer } from "node:buffer";

export enum Ppk2Command {
  AverageStart = 0x06,
  AverageStop = 0x07,
  DeviceRunningSet = 0x0c,
  RegulatorSet = 0x0d,
  SetPowerMode = 0x11,
  GetMetadata = 0x19,
  SetUserGains = 0x25,
}

export const PPK2_AMPERE_MODE = 1;
export const PPK2_SAMPLE_BYTES = 4;
export const PPK2_COUNTER_MODULUS = 64;
const ADC_MULTIPLIER = 1.8 / 163_840;
const RANGE_COUNT = 5;

export interface Ppk2CalibrationMetadata {
  vddMv: number;
  mode: number;
  hardwareRevision: string | null;
  calibrated: string | null;
  r: readonly number[];
  gs: readonly number[];
  gi: readonly number[];
  o: readonly number[];
  s: readonly number[];
  i: readonly number[];
  ug: readonly number[];
}

export interface Ppk2RawSample {
  rawWord: number;
  counter: number;
  range: number;
  logic: number;
  currentUa: number;
}

export function parsePpk2Metadata(text: string): Ppk2CalibrationMetadata {
  const endIndex = text.indexOf("END");
  if (endIndex < 0) {
    throw new Error("PPK2 metadata terminator END was not received");
  }

  const values = new Map<string, string>();
  for (const rawLine of text.slice(0, endIndex).split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const separator = line.indexOf(":");
    if (separator <= 0) {
      throw new Error(`Malformed PPK2 metadata line: ${line}`);
    }
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (value.length === 0) {
      throw new Error(`Empty PPK2 metadata value for ${key}`);
    }
    if (values.has(key)) {
      throw new Error(`Duplicate PPK2 metadata key ${key}`);
    }
    values.set(key, value);
  }

  const vddMv = readMetadataNumber(values, "vdd");
  if (vddMv < 800 || vddMv > 5_000) {
    throw new Error(`PPK2 metadata VDD ${vddMv} mV is outside 800..5000 mV`);
  }

  return {
    vddMv,
    mode: readMetadataNumber(values, "mode"),
    hardwareRevision: values.get("hw") ?? null,
    calibrated: values.get("calibrated") ?? null,
    r: readCoefficientArray(values, "r"),
    gs: readCoefficientArray(values, "gs"),
    gi: readCoefficientArray(values, "gi"),
    o: readCoefficientArray(values, "o"),
    s: readCoefficientArray(values, "s"),
    i: readCoefficientArray(values, "i"),
    ug: readCoefficientArray(values, "ug"),
  };
}

export function encodePpk2RegulatorCommand(vddMv: number): Buffer {
  if (!Number.isInteger(vddMv) || vddMv < 800 || vddMv > 5_000) {
    throw new Error("PPK2 regulator voltage must be an integer from 800 through 5000 mV");
  }
  return Buffer.from([Ppk2Command.RegulatorSet, vddMv >> 8, vddMv & 0xff]);
}

export function encodePpk2UserGainCommand(range: number, gain: number): Buffer {
  if (!Number.isInteger(range) || range < 0 || range >= RANGE_COUNT) {
    throw new Error("PPK2 user-gain range must be 0 through 4");
  }
  if (!Number.isFinite(gain) || gain <= 0) {
    throw new Error("PPK2 user gain must be positive and finite");
  }
  const buffer = Buffer.alloc(6);
  buffer[0] = Ppk2Command.SetUserGains;
  buffer[1] = range;
  buffer.writeFloatLE(gain, 2);
  return buffer;
}

export class Ppk2CurrentConverter {
  private rollingAverage: number | undefined;
  private rollingAverageRange4: number | undefined;
  private previousRange: number | undefined;
  private afterSpike = 0;
  private consecutiveRangeSamples = 0;

  public constructor(
    private readonly calibration: Ppk2CalibrationMetadata,
    private readonly userGains: readonly number[] = calibration.ug,
  ) {
    if (userGains.length !== RANGE_COUNT) {
      throw new Error("PPK2 user-gain array must contain five ranges");
    }
  }

  public resetFilter(): void {
    this.rollingAverage = undefined;
    this.rollingAverageRange4 = undefined;
    this.previousRange = undefined;
    this.afterSpike = 0;
    this.consecutiveRangeSamples = 0;
  }

  public decode(rawWord: number): Ppk2RawSample {
    if (!Number.isInteger(rawWord) || rawWord < 0 || rawWord > 0xffff_ffff) {
      throw new Error("PPK2 sample word must be an unsigned 32-bit integer");
    }

    const adc = rawWord & 0x3fff;
    const range = (rawWord >>> 14) & 0x07;
    const counter = (rawWord >>> 18) & 0x3f;
    const logic = (rawWord >>> 24) & 0xff;
    if (range >= RANGE_COUNT) {
      throw new Error(`PPK2 sample reported invalid range ${range}`);
    }

    const adcResult = adc * 4;
    const resultWithoutGain =
      (adcResult - requireAt(this.calibration.o, range, "o")) *
      (ADC_MULTIPLIER / requireAt(this.calibration.r, range, "r"));
    let currentA = requireAt(this.userGains, range, "ug") * (
      resultWithoutGain * (
        requireAt(this.calibration.gs, range, "gs") * resultWithoutGain +
        requireAt(this.calibration.gi, range, "gi")
      ) + (
        requireAt(this.calibration.s, range, "s") * (this.calibration.vddMv / 1_000) +
        requireAt(this.calibration.i, range, "i")
      )
    );

    const previousRollingAverage = this.rollingAverage;
    const previousRollingAverageRange4 = this.rollingAverageRange4;
    this.rollingAverage = this.rollingAverage === undefined
      ? currentA
      : 0.18 * currentA + 0.82 * this.rollingAverage;
    this.rollingAverageRange4 = this.rollingAverageRange4 === undefined
      ? currentA
      : 0.06 * currentA + 0.94 * this.rollingAverageRange4;

    if (this.previousRange === undefined) {
      this.previousRange = range;
    }
    if (this.previousRange !== range || this.afterSpike > 0) {
      if (this.previousRange !== range) {
        this.consecutiveRangeSamples = 0;
        this.afterSpike = 3;
      } else {
        this.consecutiveRangeSamples += 1;
      }

      if (range === 4) {
        if (this.consecutiveRangeSamples < 2) {
          this.rollingAverageRange4 = previousRollingAverageRange4;
          this.rollingAverage = previousRollingAverage;
        }
        if (this.rollingAverageRange4 !== undefined) {
          currentA = this.rollingAverageRange4;
        }
      } else if (this.rollingAverage !== undefined) {
        currentA = this.rollingAverage;
      }
      this.afterSpike -= 1;
    }
    this.previousRange = range;

    return {
      rawWord,
      counter,
      range,
      logic,
      currentUa: currentA * 1_000_000,
    };
  }
}

export function requireSafePpk2UserGains(metadata: Ppk2CalibrationMetadata): readonly number[] {
  return metadata.ug.map((gain, range) => {
    if (Math.abs(gain - 1) > 0.1) {
      console.warn(`PPK2 user gain range ${range} (${gain}) is outside 0.9..1.1 and will be reset to 1.0`);
      return 1;
    }
    return gain;
  });
}

function readCoefficientArray(values: ReadonlyMap<string, string>, prefix: string): readonly number[] {
  return Array.from({ length: RANGE_COUNT }, (_unused, index) =>
    readMetadataNumber(values, `${prefix}${index}`));
}

function readMetadataNumber(values: ReadonlyMap<string, string>, key: string): number {
  const raw = values.get(key);
  if (raw === undefined) {
    throw new Error(`PPK2 metadata is missing required calibration key ${key}`);
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`PPK2 metadata ${key} must be finite`);
  }
  return value;
}

function requireAt(values: readonly number[], index: number, name: string): number {
  const value = values[index];
  if (value === undefined || !Number.isFinite(value)) {
    throw new Error(`PPK2 calibration coefficient ${name}${index} is unavailable`);
  }
  return value;
}
