import {
  Dm858eReadingResolutionSource,
  dm858eCapacitanceResolutionRatio,
  dm858eFixedRanges,
  dm858eReadingResolutionSource,
} from "../../shared/dm858e-capabilities.js";
import {
  DmmAcquisitionRate,
  DmmMeasurementFunction,
  DmmRangeMode,
  DmmReadingKind,
  DmmReadingUnavailableReason,
  dmmUnitForFunction,
  type DmmInfo,
  type DmmRange,
  type DmmReadingSnapshot,
  type DmmState,
} from "../../shared/dmm-types.js";
import {
  ScpiProgramMessageKind,
  classifyScpiProgramMessage,
} from "../scpi/scpi-program-message.js";
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
  readonly range: DmmRange | null;
  readonly effectiveRange?: number;
}

interface ParsedLastReading {
  readonly value: number;
  readonly functionToken: string;
}

type TemperatureUnit = "C" | "F" | "K";

const noDataSentinel = 9.9e37;
const operationConfigurationChanged = 256;
const rangeStabilityObservationLimit = 3;

export class Dm858eDriver {
  private temperatureUnit: TemperatureUnit = "C";
  private readonly learnedReadingFunctionTokens = new Map<string, DmmMeasurementFunction>();

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
    priority: ScpiPriority = ScpiPriority.Normal,
  ): Promise<DmmState> {
    return this.scheduler.schedule({
      priority,
      kind: ScpiOperationKind.StateRead,
      execute: async (transport) => {
        const configuration = parseConfiguration(await transport.queryText("CONFigure?"));
        const rangeResult = await readRangeObservation(transport, configuration.function);
        const acquisitionRate = await readAcquisitionRate(
          transport,
          configuration,
          rangeResult.effectiveRange,
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

    if (range.mode === DmmRangeMode.Fixed) {
      requireSupportedRange(measurementFunction, range.value, spec.values);
    }

    await this.scheduler.scheduleImmediate(
      ScpiOperationKind.Write,
      null,
      async (transport) => {
        await requireCurrentFunction(transport, measurementFunction);
        if (range.mode === DmmRangeMode.Auto) {
          await transport.command(`${spec.command}:AUTO ON`);
          return;
        }
        await transport.command(`${spec.command} ${range.value}`);
      },
    );
  }

  public async setAcquisitionRate(
    measurementFunction: DmmMeasurementFunction,
    rate: DmmAcquisitionRate,
  ): Promise<void> {
    const nplcCommand = nplcCommandFor(measurementFunction);
    if (
      nplcCommand === null &&
      measurementFunction !== DmmMeasurementFunction.AcVoltage &&
      measurementFunction !== DmmMeasurementFunction.AcCurrent
    ) {
      throw new Error(
        `${functionName(measurementFunction)} does not expose programmable measurement speed`,
      );
    }

    const spec = rangeSpec(measurementFunction);
    if (nplcCommand === null && spec === null) {
      throw new Error("Missing range specification for AC measurement function");
    }

    await this.scheduler.scheduleImmediate(
      ScpiOperationKind.Write,
      null,
      async (transport) => {
        await requireCurrentFunction(transport, measurementFunction);

        if (nplcCommand !== null) {
          await transport.command(`${nplcCommand} ${plcForRate(rate)}`);
          return;
        }

        if (spec === null) {
          throw new Error("Missing range specification for AC measurement function");
        }

        const physicalRange = await readStableRange(transport, measurementFunction);
        if (physicalRange.range === null || physicalRange.effectiveRange === undefined) {
          throw new Error("Missing physical range for AC measurement function");
        }
        const resolution = physicalRange.effectiveRange * resolutionRatioForRate(rate);
        const rangeToken = physicalRange.range.mode === DmmRangeMode.Auto
          ? "AUTO"
          : String(physicalRange.range.value);
        await requireCurrentFunction(transport, measurementFunction);
        await transport.command(
          `${configureCommandFor(measurementFunction)} ${rangeToken},${resolution}`,
        );
      },
    );
  }

  public async readPrimarySnapshot(
    measurementFunction: DmmMeasurementFunction,
    priority: ScpiPriority = ScpiPriority.Normal,
  ): Promise<DmmReadingSnapshot | null> {
    return this.scheduler.schedule({
      priority,
      kind: ScpiOperationKind.Measurement,
      execute: async (transport) => {
        const operationBefore = parseNonNegativeInteger(
          await transport.queryText("STATus:OPERation:CONDition?"),
          "DM858E operation status",
        );
        const configurationTextBefore = (await transport.queryText("CONFigure?")).trim();
        const configurationBefore = parseConfiguration(configurationTextBefore);
        const resolutionBefore = await readSnapshotResolutionObservation(
          transport,
          configurationBefore,
        );
        const functionBefore = parseFunctionToken(
          await transport.queryText("SENSe:FUNCtion?"),
        );
        const response = (await transport.queryText("DATA:LAST?")).trim();
        const functionAfter = parseFunctionToken(
          await transport.queryText("SENSe:FUNCtion?"),
        );
        const configurationTextAfter = (await transport.queryText("CONFigure?")).trim();
        const configurationAfter = parseConfiguration(configurationTextAfter);
        const resolutionAfter = await readSnapshotResolutionObservation(
          transport,
          configurationAfter,
        );

        let readingTemperatureUnit = this.temperatureUnit;
        if (functionAfter === DmmMeasurementFunction.Temperature) {
          readingTemperatureUnit = parseTemperatureUnit(
            await transport.queryText("UNIT:TEMPerature?"),
          );
          this.temperatureUnit = readingTemperatureUnit;
        }

        const operationAfter = parseNonNegativeInteger(
          await transport.queryText("STATus:OPERation:CONDition?"),
          "DM858E operation status",
        );

        if (
          functionBefore !== functionAfter ||
          functionAfter !== measurementFunction ||
          configurationBefore.function !== functionBefore ||
          configurationAfter.function !== functionAfter ||
          configurationTextBefore !== configurationTextAfter ||
          !sameResolutionObservation(resolutionBefore, resolutionAfter)
        ) {
          return null;
        }

        const unit = dmmUnitForFunction(functionAfter);
        if (((operationBefore | operationAfter) & operationConfigurationChanged) !== 0) {
          return {
            kind: DmmReadingKind.Unavailable,
            function: functionAfter,
            unit,
            reason: DmmReadingUnavailableReason.ConfigurationChanged,
          };
        }

        const parsed = parseLastReadingResponse(response);
        if (parsed === null) {
          return {
            kind: DmmReadingKind.Unavailable,
            function: functionAfter,
            unit,
            reason: DmmReadingUnavailableReason.NoData,
          };
        }
        if (!this.readingFunctionTokenMatches(parsed.functionToken, functionAfter)) {
          return null;
        }

        if (Math.abs(parsed.value) >= noDataSentinel) {
          return {
            kind: DmmReadingKind.Unavailable,
            function: functionAfter,
            unit,
            reason: DmmReadingUnavailableReason.UnclassifiedSentinel,
          };
        }

        const value = functionAfter === DmmMeasurementFunction.Temperature
          ? temperatureToCelsius(parsed.value, readingTemperatureUnit)
          : parsed.value;
        if (resolutionAfter === null) {
          return {
            kind: DmmReadingKind.Unavailable,
            function: functionAfter,
            unit,
            reason: DmmReadingUnavailableReason.ResolutionUnavailable,
          };
        }

        return {
          kind: DmmReadingKind.Value,
          function: functionAfter,
          value,
          resolution: resolutionAfter,
          unit,
        };
      },
    });
  }

  public async executeRawScpi(command: string): Promise<string> {
    const kind = classifyScpiProgramMessage(command);
    if (kind === ScpiProgramMessageKind.Query) {
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

  private readingFunctionTokenMatches(
    token: string,
    measurementFunction: DmmMeasurementFunction,
  ): boolean {
    const normalized = token.trim().toUpperCase();

    if (normalized === "VDC") {
      return measurementFunction === DmmMeasurementFunction.DcVoltage;
    }

    const learned = this.learnedReadingFunctionTokens.get(normalized);
    if (learned === undefined) {
      this.learnedReadingFunctionTokens.set(normalized, measurementFunction);
      return true;
    }
    return learned === measurementFunction;
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

async function requireCurrentFunction(
  transport: ScpiTransport,
  expected: DmmMeasurementFunction,
): Promise<void> {
  const actual = parseFunctionToken(await transport.queryText("SENSe:FUNCtion?"));
  if (actual !== expected) {
    throw new Error(
      `Stale DMM control: expected ${functionName(expected)}, current function is ${functionName(actual)}`,
    );
  }
}

async function readRangeObservation(
  transport: ScpiTransport,
  measurementFunction: DmmMeasurementFunction,
): Promise<ReadRangeResult> {
  const spec = rangeSpec(measurementFunction);
  if (spec === null) {
    return { range: null };
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

async function readStableRange(
  transport: ScpiTransport,
  measurementFunction: DmmMeasurementFunction,
): Promise<ReadRangeResult> {
  let previous = await readRangeObservation(transport, measurementFunction);

  for (let observation = 1; observation < rangeStabilityObservationLimit; observation += 1) {
    const current = await readRangeObservation(transport, measurementFunction);
    if (sameRangeObservation(previous, current)) {
      return current;
    }
    previous = current;
  }

  throw new Error(
    `Unstable ${functionName(measurementFunction)} range while applying acquisition rate`,
  );
}

function sameRangeObservation(left: ReadRangeResult, right: ReadRangeResult): boolean {
  if (left.range === null || right.range === null) {
    return left.range === right.range;
  }
  if (left.range.mode !== right.range.mode) {
    return false;
  }
  if (left.effectiveRange === undefined || right.effectiveRange === undefined) {
    return false;
  }
  return nearlyEqual(left.effectiveRange, right.effectiveRange);
}

async function readAcquisitionRate(
  transport: ScpiTransport,
  configuration: ParsedConfiguration,
  effectiveRange: number | undefined,
): Promise<DmmAcquisitionRate | null> {
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

  return null;
}

async function readSnapshotResolutionObservation(
  transport: ScpiTransport,
  configuration: ParsedConfiguration,
): Promise<number | null> {
  switch (dm858eReadingResolutionSource(configuration.function)) {
    case Dm858eReadingResolutionSource.Configure:
      return configuration.resolution ?? null;
    case Dm858eReadingResolutionSource.CapacitanceRange: {
      const effectiveRange = parsePositiveNumber(
        await transport.queryText("SENSe:CAPacitance:RANGe?"),
        "capacitance range",
      );
      return effectiveRange * dm858eCapacitanceResolutionRatio;
    }
    case Dm858eReadingResolutionSource.Unverified:
      return null;
  }
}

function sameResolutionObservation(left: number | null, right: number | null): boolean {
  if (left === null || right === null) {
    return left === right;
  }
  return nearlyEqual(left, right);
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
  const values = dm858eFixedRanges(value);
  switch (value) {
    case DmmMeasurementFunction.DcVoltage:
      return { command: "SENSe:VOLTage:DC:RANGe", values };
    case DmmMeasurementFunction.AcVoltage:
      return { command: "SENSe:VOLTage:AC:RANGe", values };
    case DmmMeasurementFunction.DcCurrent:
      return { command: "SENSe:CURRent:DC:RANGe", values };
    case DmmMeasurementFunction.AcCurrent:
      return { command: "SENSe:CURRent:AC:RANGe", values };
    case DmmMeasurementFunction.Resistance2Wire:
      return { command: "SENSe:RESistance:RANGe", values };
    case DmmMeasurementFunction.Resistance4Wire:
      return { command: "SENSe:FRESistance:RANGe", values };
    case DmmMeasurementFunction.Frequency:
      return { command: "SENSe:FREQuency:VOLTage:RANGe", values };
    case DmmMeasurementFunction.Period:
      return { command: "SENSe:PERiod:VOLTage:RANGe", values };
    case DmmMeasurementFunction.Capacitance:
      return { command: "SENSe:CAPacitance:RANGe", values };
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

function parseNonNegativeInteger(value: string, name: string): number {
  const parsed = Number(value.trim());
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid ${name}: ${value}`);
  }
  return parsed;
}

function parseLastReadingResponse(value: string): ParsedLastReading | null {
  if (isBareNoDataResponse(value)) {
    return null;
  }

  const match = /^\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[Ee][+-]?\d+)?)\s+(.+?)\s*$/.exec(value);
  if (match === null || match[1] === undefined || match[2] === undefined) {
    throw new Error(`Invalid DM858E DATA:LAST? response: ${value}`);
  }

  const parsed = Number(match[1]);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid DM858E DATA:LAST? value: ${value}`);
  }

  const functionToken = match[2].trim();
  if (functionToken.length === 0) {
    throw new Error(`Missing DM858E DATA:LAST? measurement function: ${value}`);
  }
  return { value: parsed, functionToken };
}

function isBareNoDataResponse(value: string): boolean {
  const trimmed = value.trim();
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[Ee][+-]?\d+)?$/.test(trimmed)) {
    return false;
  }
  return Number(trimmed) === noDataSentinel;
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
