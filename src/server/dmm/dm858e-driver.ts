import {
  DmmAcquisitionRate,
  DmmMeasurementFunction,
  DmmRangeMode,
  DmmReadingKind,
  DmmUnit,
  type DmmInfo,
  type DmmPrimaryReading,
  type DmmRange,
  type DmmState,
} from "../../shared/dmm-types.js";
import {
  ScpiOperationKind,
  ScpiPriority,
  type ScpiScheduler,
} from "../scpi/scpi-scheduler.js";
import {
  ScpiResponseKind,
  type ScpiTransport,
} from "../scpi/scpi-transport.js";

interface RangeSpec {
  readonly command: string;
  readonly values: readonly number[];
}

interface ParsedConfiguration {
  readonly function: DmmMeasurementFunction;
  readonly range?: number;
  readonly resolution?: number;
}

interface ReadRangeResult {
  readonly range: DmmRange;
  readonly effectiveRange?: number;
}

type TemperatureUnit = "C" | "F" | "K";

const dcVoltageRanges = [0.1, 1, 10, 100, 1_000] as const;
const acVoltageRanges = [0.1, 1, 10, 100, 750] as const;
const currentRanges = [1e-4, 1e-3, 1e-2, 1e-1, 1, 3] as const;
const resistanceRanges = [100, 1_000, 10_000, 100_000, 1_000_000, 10_000_000, 50_000_000] as const;
const capacitanceRanges = [1e-9, 1e-8, 1e-7, 1e-6, 1e-5, 1e-4, 1e-3] as const;
const frequencyVoltageRanges = [0.1, 1, 10, 100, 750] as const;
const noDataSentinel = 9.9e37;

export class Dm858eDriver {
  private temperatureUnit: TemperatureUnit = "C";

  public constructor(private readonly scheduler: ScpiScheduler) {}

  public async identify(): Promise<DmmInfo> {
    const response = await this.queryText(
      "*IDN?",
      ScpiPriority.Normal,
      ScpiOperationKind.Identity,
    );
    const parts = response.split(",").map((part) => part.trim());
    if (parts.length !== 4) {
      throw new Error(`Malformed DM858E identification response: ${response}`);
    }

    const [manufacturer, model, serialNumber, firmwareVersion] = parts;
    if (
      manufacturer === undefined ||
      model === undefined ||
      serialNumber === undefined ||
      firmwareVersion === undefined
    ) {
      throw new Error(`Malformed DM858E identification response: ${response}`);
    }
    if (model.toUpperCase() !== "DM858E") {
      throw new Error(`Unsupported multimeter model: ${model}`);
    }

    return { manufacturer, model, serialNumber, firmwareVersion };
  }

  public async readDmmState(
    previousRate: DmmAcquisitionRate = DmmAcquisitionRate.Slow,
    priority: ScpiPriority = ScpiPriority.Normal,
  ): Promise<DmmState> {
    return this.scheduler.schedule({
      priority,
      kind: ScpiOperationKind.StateRead,
      execute: async (transport) => {
        const configuration = parseConfiguration(await transport.queryText("CONFigure?"));
        const rangeResult = await readRange(transport, configuration.function);
        const acquisitionRate = await readAcquisitionRate(
          transport,
          configuration,
          rangeResult.effectiveRange,
          previousRate,
        );

        if (configuration.function === DmmMeasurementFunction.Temperature) {
          this.temperatureUnit = parseTemperatureUnit(
            await transport.queryText("UNIT:TEMPerature?"),
          );
        }

        return {
          function: configuration.function,
          range: rangeResult.range,
          acquisitionRate,
        };
      },
    });
  }

  public async setFunction(value: DmmMeasurementFunction): Promise<void> {
    await this.command(
      `SENSe:FUNCtion "${functionSetToken(value)}"`,
      ScpiPriority.Immediate,
    );
  }

  public async setRange(
    measurementFunction: DmmMeasurementFunction,
    range: DmmRange,
  ): Promise<void> {
    const spec = rangeSpec(measurementFunction);
    if (spec === null) {
      throw new Error(`${functionName(measurementFunction)} does not expose a programmable range`);
    }

    if (range.mode === DmmRangeMode.Auto) {
      await this.command(`${spec.command}:AUTO ON`, ScpiPriority.Immediate);
      return;
    }

    requireSupportedRange(measurementFunction, range.value, spec.values);
    await this.command(`${spec.command} ${range.value}`, ScpiPriority.Immediate);
  }

  public async setAcquisitionRate(
    measurementFunction: DmmMeasurementFunction,
    range: DmmRange,
    rate: DmmAcquisitionRate,
  ): Promise<void> {
    const nplcCommand = nplcCommandFor(measurementFunction);
    if (nplcCommand !== null) {
      await this.command(
        `${nplcCommand} ${plcForRate(rate)}`,
        ScpiPriority.Immediate,
      );
      return;
    }

    if (
      measurementFunction !== DmmMeasurementFunction.AcVoltage &&
      measurementFunction !== DmmMeasurementFunction.AcCurrent
    ) {
      throw new Error(
        `${functionName(measurementFunction)} does not expose programmable measurement speed`,
      );
    }

    const spec = rangeSpec(measurementFunction);
    if (spec === null) {
      throw new Error("Missing range specification for AC measurement function");
    }

    const effectiveRange = range.mode === DmmRangeMode.Fixed
      ? range.value
      : parsePositiveNumber(
          await this.queryText(`${spec.command}?`, ScpiPriority.Immediate),
          "effective AC range",
        );
    const resolution = effectiveRange * resolutionRatioForRate(rate);
    const rangeToken = range.mode === DmmRangeMode.Auto ? "AUTO" : String(range.value);

    await this.command(
      `${configureCommandFor(measurementFunction)} ${rangeToken},${resolution}`,
      ScpiPriority.Immediate,
    );
  }

  public async readPrimaryReading(
    measurementFunction: DmmMeasurementFunction,
    sequence: number,
    priority: ScpiPriority = ScpiPriority.Normal,
  ): Promise<DmmPrimaryReading | null> {
    if (!Number.isSafeInteger(sequence) || sequence < 0) {
      throw new Error("DMM reading sequence must be a non-negative safe integer");
    }

    const response = await this.queryText(
      "DATA:LAST?",
      priority,
      ScpiOperationKind.Measurement,
    );
    const value = parseLeadingFiniteNumber(response, "DM858E primary reading");

    if (isBareNoDataResponse(response)) {
      return null;
    }

    const unit = unitForFunction(measurementFunction);
    if (Math.abs(value) >= noDataSentinel) {
      return {
        kind: DmmReadingKind.Overload,
        sequence,
        unit,
      };
    }

    return {
      kind: DmmReadingKind.Value,
      sequence,
      value: measurementFunction === DmmMeasurementFunction.Temperature
        ? temperatureToCelsius(value, this.temperatureUnit)
        : value,
      unit,
    };
  }

  public async executeRawScpi(command: string): Promise<string> {
    validateRawProgramMessage(command);
    if (hasUnquotedQueryMarker(command)) {
      return this.scheduler.schedule({
        priority: ScpiPriority.Normal,
        kind: ScpiOperationKind.RawScpi,
        execute: async (transport, recorder) => {
          const response = await transport.query(command);
          if (response.kind === ScpiResponseKind.Binary) {
            recorder.addBinaryBytes(response.value.byteLength);
            throw new Error("Binary SCPI console responses are not supported");
          }
          return response.value;
        },
      });
    }

    await this.scheduler.schedule({
      priority: ScpiPriority.Normal,
      kind: ScpiOperationKind.RawScpi,
      execute: async (transport) => {
        await transport.command(command);
      },
    });
    return "";
  }

  private async queryText(
    command: string,
    priority: ScpiPriority,
    kind = ScpiOperationKind.StateRead,
  ): Promise<string> {
    return this.scheduler.schedule({
      priority,
      kind,
      execute: (transport) => transport.queryText(command),
    });
  }

  private async command(command: string, priority: ScpiPriority): Promise<void> {
    const execute = async (transport: ScpiTransport): Promise<void> => {
      await transport.command(command);
    };

    if (priority === ScpiPriority.Immediate) {
      await this.scheduler.scheduleImmediate(ScpiOperationKind.Write, null, execute);
      return;
    }

    await this.scheduler.schedule({
      priority,
      kind: ScpiOperationKind.Write,
      execute,
    });
  }
}

async function readRange(
  transport: ScpiTransport,
  measurementFunction: DmmMeasurementFunction,
): Promise<ReadRangeResult> {
  const spec = rangeSpec(measurementFunction);
  if (spec === null) {
    return { range: { mode: DmmRangeMode.Auto } };
  }

  const auto = parseBoolean(await transport.queryText(`${spec.command}:AUTO?`));
  const effectiveRange = parsePositiveNumber(
    await transport.queryText(`${spec.command}?`),
    `${functionName(measurementFunction)} range`,
  );

  if (auto) {
    return {
      range: { mode: DmmRangeMode.Auto },
      effectiveRange,
    };
  }

  return {
    range: {
      mode: DmmRangeMode.Fixed,
      value: effectiveRange,
    },
    effectiveRange,
  };
}

async function readAcquisitionRate(
  transport: ScpiTransport,
  configuration: ParsedConfiguration,
  effectiveRange: number | undefined,
  previousRate: DmmAcquisitionRate,
): Promise<DmmAcquisitionRate> {
  const nplcCommand = nplcCommandFor(configuration.function);
  if (nplcCommand !== null) {
    return rateFromPlc(
      parsePositiveNumber(
        await transport.queryText(`${nplcCommand}?`),
        `${functionName(configuration.function)} integration time`,
      ),
    );
  }

  if (
    configuration.function === DmmMeasurementFunction.AcVoltage ||
    configuration.function === DmmMeasurementFunction.AcCurrent
  ) {
    const range = configuration.range ?? effectiveRange;
    if (range !== undefined && configuration.resolution !== undefined) {
      return rateFromResolution(range, configuration.resolution);
    }
  }

  return previousRate;
}

function parseConfiguration(value: string): ParsedConfiguration {
  const trimmed = value.trim();
  const separator = trimmed.search(/\s/);
  const functionToken = separator < 0 ? trimmed : trimmed.slice(0, separator);
  const measurementFunction = parseFunctionToken(functionToken);

  if (separator < 0) {
    return { function: measurementFunction };
  }

  const parameters = trimmed.slice(separator).trim().split(",").map((part) => part.trim());
  const range = optionalPositiveNumber(parameters[0]);
  const resolution = optionalPositiveNumber(parameters[1]);

  if (range === undefined && resolution === undefined) {
    return { function: measurementFunction };
  }
  if (resolution === undefined) {
    return { function: measurementFunction, range };
  }
  if (range === undefined) {
    return { function: measurementFunction, resolution };
  }
  return { function: measurementFunction, range, resolution };
}

function parseFunctionToken(value: string): DmmMeasurementFunction {
  const token = value.trim().replace(/^"|"$/g, "").toUpperCase();
  switch (token) {
    case "VOLT":
    case "VOLT:DC": return DmmMeasurementFunction.DcVoltage;
    case "VOLT:AC": return DmmMeasurementFunction.AcVoltage;
    case "CURR":
    case "CURR:DC": return DmmMeasurementFunction.DcCurrent;
    case "CURR:AC": return DmmMeasurementFunction.AcCurrent;
    case "RES": return DmmMeasurementFunction.Resistance2Wire;
    case "FRES": return DmmMeasurementFunction.Resistance4Wire;
    case "CONT": return DmmMeasurementFunction.Continuity;
    case "DIOD": return DmmMeasurementFunction.Diode;
    case "FREQ": return DmmMeasurementFunction.Frequency;
    case "PER": return DmmMeasurementFunction.Period;
    case "CAP": return DmmMeasurementFunction.Capacitance;
    case "TEMP": return DmmMeasurementFunction.Temperature;
    default: throw new Error(`Unknown DM858E measurement function: ${value}`);
  }
}

function functionSetToken(value: DmmMeasurementFunction): string {
  switch (value) {
    case DmmMeasurementFunction.DcVoltage: return "VOLTage:DC";
    case DmmMeasurementFunction.AcVoltage: return "VOLTage:AC";
    case DmmMeasurementFunction.DcCurrent: return "CURRent:DC";
    case DmmMeasurementFunction.AcCurrent: return "CURRent:AC";
    case DmmMeasurementFunction.Resistance2Wire: return "RESistance";
    case DmmMeasurementFunction.Resistance4Wire: return "FRESistance";
    case DmmMeasurementFunction.Continuity: return "CONTinuity";
    case DmmMeasurementFunction.Diode: return "DIODe";
    case DmmMeasurementFunction.Frequency: return "FREQuency";
    case DmmMeasurementFunction.Period: return "PERiod";
    case DmmMeasurementFunction.Capacitance: return "CAPacitance";
    case DmmMeasurementFunction.Temperature: return "TEMPerature";
  }
}

function configureCommandFor(value: DmmMeasurementFunction): string {
  switch (value) {
    case DmmMeasurementFunction.AcVoltage: return "CONFigure:VOLTage:AC";
    case DmmMeasurementFunction.AcCurrent: return "CONFigure:CURRent:AC";
    default: throw new Error(`${functionName(value)} does not use resolution configuration`);
  }
}

function rangeSpec(value: DmmMeasurementFunction): RangeSpec | null {
  switch (value) {
    case DmmMeasurementFunction.DcVoltage:
      return { command: "SENSe:VOLTage:DC:RANGe", values: dcVoltageRanges };
    case DmmMeasurementFunction.AcVoltage:
      return { command: "SENSe:VOLTage:AC:RANGe", values: acVoltageRanges };
    case DmmMeasurementFunction.DcCurrent:
      return { command: "SENSe:CURRent:DC:RANGe", values: currentRanges };
    case DmmMeasurementFunction.AcCurrent:
      return { command: "SENSe:CURRent:AC:RANGe", values: currentRanges };
    case DmmMeasurementFunction.Resistance2Wire:
      return { command: "SENSe:RESistance:RANGe", values: resistanceRanges };
    case DmmMeasurementFunction.Resistance4Wire:
      return { command: "SENSe:FRESistance:RANGe", values: resistanceRanges };
    case DmmMeasurementFunction.Frequency:
      return { command: "SENSe:FREQuency:VOLTage:RANGe", values: frequencyVoltageRanges };
    case DmmMeasurementFunction.Period:
      return { command: "SENSe:PERiod:VOLTage:RANGe", values: frequencyVoltageRanges };
    case DmmMeasurementFunction.Capacitance:
      return { command: "SENSe:CAPacitance:RANGe", values: capacitanceRanges };
    case DmmMeasurementFunction.Continuity:
    case DmmMeasurementFunction.Diode:
    case DmmMeasurementFunction.Temperature:
      return null;
  }
}

function nplcCommandFor(value: DmmMeasurementFunction): string | null {
  switch (value) {
    case DmmMeasurementFunction.DcVoltage: return "SENSe:VOLTage:DC:NPLC";
    case DmmMeasurementFunction.DcCurrent: return "SENSe:CURRent:DC:NPLC";
    case DmmMeasurementFunction.Resistance2Wire: return "SENSe:RESistance:NPLC";
    case DmmMeasurementFunction.Resistance4Wire: return "SENSe:FRESistance:NPLC";
    case DmmMeasurementFunction.AcVoltage:
    case DmmMeasurementFunction.AcCurrent:
    case DmmMeasurementFunction.Continuity:
    case DmmMeasurementFunction.Diode:
    case DmmMeasurementFunction.Frequency:
    case DmmMeasurementFunction.Period:
    case DmmMeasurementFunction.Capacitance:
    case DmmMeasurementFunction.Temperature:
      return null;
  }
}

function functionName(value: DmmMeasurementFunction): string {
  switch (value) {
    case DmmMeasurementFunction.DcVoltage: return "DC voltage";
    case DmmMeasurementFunction.AcVoltage: return "AC voltage";
    case DmmMeasurementFunction.DcCurrent: return "DC current";
    case DmmMeasurementFunction.AcCurrent: return "AC current";
    case DmmMeasurementFunction.Resistance2Wire: return "2-wire resistance";
    case DmmMeasurementFunction.Resistance4Wire: return "4-wire resistance";
    case DmmMeasurementFunction.Continuity: return "continuity";
    case DmmMeasurementFunction.Diode: return "diode";
    case DmmMeasurementFunction.Frequency: return "frequency";
    case DmmMeasurementFunction.Period: return "period";
    case DmmMeasurementFunction.Capacitance: return "capacitance";
    case DmmMeasurementFunction.Temperature: return "temperature";
  }
}

function unitForFunction(value: DmmMeasurementFunction): DmmUnit {
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

function plcForRate(value: DmmAcquisitionRate): number {
  switch (value) {
    case DmmAcquisitionRate.Slow: return 20;
    case DmmAcquisitionRate.Medium: return 5;
    case DmmAcquisitionRate.Fast: return 0.4;
  }
}

function resolutionRatioForRate(value: DmmAcquisitionRate): number {
  switch (value) {
    case DmmAcquisitionRate.Slow: return 1e-5;
    case DmmAcquisitionRate.Medium: return 1e-4;
    case DmmAcquisitionRate.Fast: return 1e-3;
  }
}

function rateFromPlc(value: number): DmmAcquisitionRate {
  if (nearlyEqual(value, 20)) {
    return DmmAcquisitionRate.Slow;
  }
  if (nearlyEqual(value, 5)) {
    return DmmAcquisitionRate.Medium;
  }
  if (nearlyEqual(value, 0.4)) {
    return DmmAcquisitionRate.Fast;
  }
  throw new Error(`Unsupported DM858E integration time: ${value} PLC`);
}

function rateFromResolution(range: number, resolution: number): DmmAcquisitionRate {
  if (range <= 0 || resolution <= 0) {
    throw new Error("DM858E range and resolution must be positive");
  }
  const ratio = resolution / range;
  if (nearlyEqual(ratio, 1e-5)) {
    return DmmAcquisitionRate.Slow;
  }
  if (nearlyEqual(ratio, 1e-4)) {
    return DmmAcquisitionRate.Medium;
  }
  if (nearlyEqual(ratio, 1e-3)) {
    return DmmAcquisitionRate.Fast;
  }
  throw new Error(`Unsupported DM858E resolution/range ratio: ${ratio}`);
}

function requireSupportedRange(
  measurementFunction: DmmMeasurementFunction,
  value: number,
  supported: readonly number[],
): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("DMM fixed range must be a positive finite number");
  }
  if (!supported.some((candidate) => nearlyEqual(candidate, value))) {
    throw new Error(`Unsupported ${functionName(measurementFunction)} range: ${value}`);
  }
}

function optionalPositiveNumber(value: string | undefined): number | undefined {
  if (value === undefined || value.length === 0) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return undefined;
  }
  return parsed;
}

function parsePositiveNumber(value: string, name: string): number {
  const parsed = Number(value.trim());
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${name}: ${value}`);
  }
  return parsed;
}

function parseLeadingFiniteNumber(value: string, name: string): number {
  const match = /^[\s]*([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[Ee][+-]?\d+)?)/.exec(value);
  if (match === null || match[1] === undefined) {
    throw new Error(`Invalid ${name}: ${value}`);
  }
  const parsed = Number(match[1]);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid ${name}: ${value}`);
  }
  return parsed;
}

function isBareNoDataResponse(value: string): boolean {
  const trimmed = value.trim();
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[Ee][+-]?\d+)?$/.test(trimmed)) {
    return false;
  }
  return Math.abs(Number(trimmed)) >= noDataSentinel;
}

function parseBoolean(value: string): boolean {
  switch (value.trim().toUpperCase()) {
    case "0":
    case "OFF":
      return false;
    case "1":
    case "ON":
      return true;
    default:
      throw new Error(`Invalid DM858E boolean response: ${value}`);
  }
}

function parseTemperatureUnit(value: string): TemperatureUnit {
  switch (value.trim().replace(/^"|"$/g, "").toUpperCase()) {
    case "C":
    case "CEL":
    case "CELSIUS":
      return "C";
    case "F":
    case "FAR":
    case "FAHRENHEIT":
      return "F";
    case "K":
    case "KEL":
    case "KELVIN":
      return "K";
    default:
      throw new Error(`Invalid DM858E temperature unit: ${value}`);
  }
}

function temperatureToCelsius(value: number, unit: TemperatureUnit): number {
  switch (unit) {
    case "C": return value;
    case "F": return (value - 32) * (5 / 9);
    case "K": return value - 273.15;
  }
}

function nearlyEqual(left: number, right: number): boolean {
  const scale = Math.max(Math.abs(left), Math.abs(right), Number.MIN_VALUE);
  return Math.abs(left - right) <= scale * 1e-9;
}

function validateRawProgramMessage(command: string): void {
  if (command.trim().length === 0) {
    throw new Error("Raw SCPI command must not be empty");
  }
  if (command.includes("\n") || command.includes("\r")) {
    throw new Error("Raw SCPI execution accepts exactly one program message");
  }
}

function hasUnquotedQueryMarker(command: string): boolean {
  let quote: "\"" | "'" | null = null;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (character === undefined) {
      continue;
    }
    if (quote === null && (character === "\"" || character === "'")) {
      quote = character;
      continue;
    }
    if (quote !== null && character === quote) {
      quote = null;
      continue;
    }
    if (quote === null && character === "?") {
      return true;
    }
  }
  return false;
}
