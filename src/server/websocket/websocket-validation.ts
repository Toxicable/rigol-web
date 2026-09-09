import { SupportedInstrument, type ScpiInstrument } from "../../shared/instrument-types.js";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readRequestId(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new Error("requestId must be a non-negative integer");
  }
  return value as number;
}

export function tryReadRequestId(value: unknown): number | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  try {
    return readRequestId(value.requestId);
  } catch {
    return undefined;
  }
}

export function readFiniteNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${name} must be finite`);
  }
  return value;
}

export function readPositiveFiniteNumber(value: unknown, name: string): number {
  const parsed = readFiniteNumber(value, name);
  if (parsed <= 0) {
    throw new Error(`${name} must be positive`);
  }
  return parsed;
}

export function readNonNegativeInteger(value: unknown, name: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value as number;
}

export function readPositiveInteger(value: unknown, name: string): number {
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value as number;
}

export function readInstrument(value: unknown): SupportedInstrument {
  switch (value) {
    case SupportedInstrument.Dho804:
    case SupportedInstrument.Dm858e:
    case SupportedInstrument.Ppk2:
      return value;
    default:
      throw new Error("Unsupported instrument");
  }
}

export function readScpiInstrument(value: unknown): ScpiInstrument {
  switch (value) {
    case SupportedInstrument.Dho804:
    case SupportedInstrument.Dm858e:
      return value;
    case SupportedInstrument.Ppk2:
      throw new Error("PPK2 does not support SCPI");
    default:
      throw new Error("Unsupported SCPI instrument");
  }
}
