import { Channel, ChannelUnit } from "../../shared/scope-types.js";
import {
  WaveformKind,
} from "../../shared/websocket-protocol.js";
import {
  WAVEFORM_FRAME_VERSION,
  WAVEFORM_HEADER_BYTES,
  WAVEFORM_MAGIC,
  WAVEFORM_POINT_BYTES,
  WaveformEncoding,
} from "../../shared/waveform-protocol.js";

export interface WaveformFrameInput {
  kind: WaveformKind;
  channel: Channel;
  unit: ChannelUnit;
  sequence: number;
  captureId: number;
  sourceStartSample: number;
  sourceEndSample: number;
  xIncrement: number;
  xOrigin: number;
  xReference: number;
  sampleIndices: Uint32Array;
  values: Float32Array;
}

const UINT32_MAX = 0xffff_ffff;

function requireUint32(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0 || value > UINT32_MAX) {
    throw new Error(`${name} must be a uint32`);
  }
}

function requireFinite(value: number, name: string): void {
  if (!Number.isFinite(value)) {
    throw new Error(`${name} must be finite`);
  }
}

function requireChannel(channel: Channel): void {
  if (channel < Channel.Ch1 || channel > Channel.Ch4) {
    throw new Error(`Unsupported waveform channel: ${channel}`);
  }
}

function requireUnit(unit: ChannelUnit): void {
  if (unit < ChannelUnit.Volts || unit > ChannelUnit.Unknown) {
    throw new Error(`Unsupported waveform unit: ${unit}`);
  }
}

export function encodeWaveformFrame(input: WaveformFrameInput): Uint8Array {
  if (input.kind !== WaveformKind.Live && input.kind !== WaveformKind.DeepViewport) {
    throw new Error(`Unsupported waveform kind: ${input.kind}`);
  }
  requireChannel(input.channel);
  requireUnit(input.unit);
  requireUint32(input.sequence, "sequence");
  requireUint32(input.captureId, "captureId");
  requireUint32(input.sourceStartSample, "sourceStartSample");
  requireUint32(input.sourceEndSample, "sourceEndSample");
  if (input.sourceEndSample <= input.sourceStartSample) {
    throw new Error("sourceEndSample must be greater than sourceStartSample");
  }
  if (input.kind === WaveformKind.Live && input.captureId !== 0) {
    throw new Error("Live waveform frames must use captureId 0");
  }
  if (input.kind === WaveformKind.DeepViewport && input.captureId === 0) {
    throw new Error("Deep waveform frames must use a positive captureId");
  }
  if (input.sampleIndices.length !== input.values.length) {
    throw new Error("Waveform sample index/value lengths must match");
  }
  requireUint32(input.sampleIndices.length, "pointCount");
  requireFinite(input.xIncrement, "xIncrement");
  requireFinite(input.xOrigin, "xOrigin");
  requireFinite(input.xReference, "xReference");

  for (let index = 0; index < input.values.length; index += 1) {
    const sampleIndex = input.sampleIndices[index];
    const value = input.values[index];
    if (sampleIndex === undefined || value === undefined) {
      throw new Error("Waveform payload is incomplete");
    }
    if (sampleIndex < input.sourceStartSample || sampleIndex >= input.sourceEndSample) {
      throw new Error(`Waveform sample index ${sampleIndex} is outside the represented source range`);
    }
    requireFinite(value, `values[${index}]`);
  }

  const output = new Uint8Array(
    WAVEFORM_HEADER_BYTES + input.values.length * WAVEFORM_POINT_BYTES,
  );
  const view = new DataView(output.buffer, output.byteOffset, output.byteLength);

  view.setUint32(0, WAVEFORM_MAGIC, true);
  view.setUint8(4, WAVEFORM_FRAME_VERSION);
  view.setUint8(5, input.kind);
  view.setUint8(6, input.channel);
  view.setUint8(7, WaveformEncoding.IndexedFloat32);
  view.setUint32(8, input.sequence, true);
  view.setUint32(12, input.captureId, true);
  view.setUint32(16, input.sourceStartSample, true);
  view.setUint32(20, input.sourceEndSample, true);
  view.setUint32(24, input.values.length, true);
  view.setUint32(28, WAVEFORM_HEADER_BYTES, true);
  view.setFloat64(32, input.xIncrement, true);
  view.setFloat64(40, input.xOrigin, true);
  view.setFloat64(48, input.xReference, true);
  view.setUint8(56, input.unit);

  for (let index = 0; index < input.values.length; index += 1) {
    const offset = WAVEFORM_HEADER_BYTES + index * WAVEFORM_POINT_BYTES;
    view.setUint32(offset, input.sampleIndices[index]!, true);
    view.setFloat32(offset + 4, input.values[index]!, true);
  }

  return output;
}
