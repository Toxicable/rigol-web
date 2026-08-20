import { Channel, ChannelUnit } from "../../shared/scope-types.js";
import { WaveformKind } from "../../shared/websocket-protocol.js";
import {
  WAVEFORM_FRAME_VERSION,
  WAVEFORM_HEADER_BYTES,
  WAVEFORM_MAGIC,
  WAVEFORM_POINT_BYTES,
  WaveformEncoding,
} from "../../shared/waveform-protocol.js";

export interface DecodedWaveformFrame {
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

function validChannel(value: number): value is Channel {
  return value >= Channel.Ch1 && value <= Channel.Ch4;
}

function validUnit(value: number): value is ChannelUnit {
  return value >= ChannelUnit.Volts && value <= ChannelUnit.Unknown;
}

function validKind(value: number): value is WaveformKind {
  return value === WaveformKind.Live || value === WaveformKind.DeepViewport;
}

export function decodeWaveformFrame(buffer: ArrayBuffer): DecodedWaveformFrame {
  if (buffer.byteLength < WAVEFORM_HEADER_BYTES) {
    throw new Error("Waveform frame is shorter than the v1 header");
  }

  const view = new DataView(buffer);
  const magic = view.getUint32(0, true);
  const version = view.getUint8(4);
  const kind = view.getUint8(5);
  const channel = view.getUint8(6);
  const encoding = view.getUint8(7);
  const sequence = view.getUint32(8, true);
  const captureId = view.getUint32(12, true);
  const sourceStartSample = view.getUint32(16, true);
  const sourceEndSample = view.getUint32(20, true);
  const pointCount = view.getUint32(24, true);
  const headerBytes = view.getUint32(28, true);
  const xIncrement = view.getFloat64(32, true);
  const xOrigin = view.getFloat64(40, true);
  const xReference = view.getFloat64(48, true);
  const unit = view.getUint8(56);

  if (magic !== WAVEFORM_MAGIC) {
    throw new Error("Invalid waveform magic");
  }
  if (version !== WAVEFORM_FRAME_VERSION) {
    throw new Error(`Unsupported waveform version ${version}`);
  }
  if (headerBytes !== WAVEFORM_HEADER_BYTES) {
    throw new Error(`Unsupported waveform header size ${headerBytes}`);
  }
  if (!validKind(kind)) {
    throw new Error(`Unsupported waveform kind ${kind}`);
  }
  if (!validChannel(channel)) {
    throw new Error(`Invalid waveform channel ${channel}`);
  }
  if (encoding !== WaveformEncoding.IndexedFloat32) {
    throw new Error(`Unsupported waveform encoding ${encoding}`);
  }
  if (!validUnit(unit)) {
    throw new Error(`Unsupported waveform unit ${unit}`);
  }
  if (!(sourceEndSample > sourceStartSample)) {
    throw new Error("Invalid represented source range");
  }
  if (
    !Number.isFinite(xIncrement) ||
    !Number.isFinite(xOrigin) ||
    !Number.isFinite(xReference)
  ) {
    throw new Error("Waveform X metadata must be finite");
  }
  if (!(xIncrement > 0)) {
    throw new Error("Waveform X increment must be positive");
  }

  for (let offset = 57; offset < WAVEFORM_HEADER_BYTES; offset += 1) {
    if (view.getUint8(offset) !== 0) {
      throw new Error("Waveform v1 reserved header bytes must be zero");
    }
  }

  const expectedBytes = WAVEFORM_HEADER_BYTES + pointCount * WAVEFORM_POINT_BYTES;
  if (buffer.byteLength !== expectedBytes) {
    throw new Error(
      `Waveform frame length mismatch: expected ${expectedBytes}, got ${buffer.byteLength}`,
    );
  }

  const sampleIndices = new Uint32Array(pointCount);
  const values = new Float32Array(pointCount);
  let previousIndex = -1;

  for (let index = 0; index < pointCount; index += 1) {
    const offset = WAVEFORM_HEADER_BYTES + index * WAVEFORM_POINT_BYTES;
    const sourceIndex = view.getUint32(offset, true);
    const value = view.getFloat32(offset + 4, true);

    if (sourceIndex < sourceStartSample || sourceIndex >= sourceEndSample) {
      throw new Error(`Waveform source index ${sourceIndex} is outside represented range`);
    }
    if (sourceIndex < previousIndex) {
      throw new Error("Waveform source indices must be ordered");
    }
    if (!Number.isFinite(value)) {
      throw new Error("Waveform amplitude must be finite");
    }

    sampleIndices[index] = sourceIndex;
    values[index] = value;
    previousIndex = sourceIndex;
  }

  if (kind === WaveformKind.Live && captureId !== 0) {
    throw new Error("Live waveform frame must use captureId 0");
  }
  if (kind === WaveformKind.DeepViewport && captureId === 0) {
    throw new Error("Deep waveform frame must use a positive captureId");
  }

  return {
    kind,
    channel,
    unit,
    sequence,
    captureId,
    sourceStartSample,
    sourceEndSample,
    xIncrement,
    xOrigin,
    xReference,
    sampleIndices,
    values,
  };
}
