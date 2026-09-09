import { Buffer } from "node:buffer";

export const PPK2_BRIDGE_PROTOCOL_VERSION = 1;
export const PPK2_BRIDGE_HEADER_BYTES = 24;
export const PPK2_BRIDGE_MAX_PAYLOAD_BYTES = 65_536;
const MAGIC = Buffer.from("TBP2", "ascii");

export enum Ppk2BridgeFrameType {
  Data = 1,
  UsbConnected = 2,
  UsbDisconnected = 3,
}

export interface Ppk2BridgeFrame {
  type: Ppk2BridgeFrameType;
  sourceSessionId: number;
  streamOffset: number;
  payload: Buffer;
}

export class Ppk2BridgeFrameParser {
  private remainder = Buffer.alloc(0);

  public push(data: Buffer): readonly Ppk2BridgeFrame[] {
    if (data.length === 0) {
      return [];
    }

    this.remainder = this.remainder.length === 0
      ? data
      : Buffer.concat([this.remainder, data]);

    const frames: Ppk2BridgeFrame[] = [];
    let offset = 0;
    while (this.remainder.length - offset >= PPK2_BRIDGE_HEADER_BYTES) {
      const header = this.remainder.subarray(offset, offset + PPK2_BRIDGE_HEADER_BYTES);
      requireMagic(header);
      const version = header.readUInt8(4);
      if (version !== PPK2_BRIDGE_PROTOCOL_VERSION) {
        throw new Error(`Unsupported PPK2 bridge protocol version ${version}`);
      }
      const type = readFrameType(header.readUInt8(5));
      if (header.readUInt16LE(6) !== 0) {
        throw new Error("PPK2 bridge reserved header field must be zero");
      }
      const sourceSessionId = header.readUInt32LE(8);
      if (sourceSessionId === 0) {
        throw new Error("PPK2 bridge sourceSessionId must be non-zero");
      }
      const streamOffsetBig = header.readBigUInt64LE(12);
      if (streamOffsetBig > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error("PPK2 bridge streamOffset exceeds JavaScript safe integer range");
      }
      const streamOffset = Number(streamOffsetBig);
      const payloadLength = header.readUInt32LE(20);
      validateLength(type, payloadLength);
      const frameBytes = PPK2_BRIDGE_HEADER_BYTES + payloadLength;
      if (this.remainder.length - offset < frameBytes) {
        break;
      }

      const payload = Buffer.from(
        this.remainder.subarray(
          offset + PPK2_BRIDGE_HEADER_BYTES,
          offset + frameBytes,
        ),
      );
      frames.push({ type, sourceSessionId, streamOffset, payload });
      offset += frameBytes;
    }

    if (offset > 0) {
      this.remainder = Buffer.from(this.remainder.subarray(offset));
    }
    return frames;
  }

  public clear(): void {
    this.remainder = Buffer.alloc(0);
  }
}

function requireMagic(header: Buffer): void {
  for (let index = 0; index < MAGIC.length; index += 1) {
    if (header[index] !== MAGIC[index]) {
      throw new Error("Invalid PPK2 bridge frame magic");
    }
  }
}

function readFrameType(value: number): Ppk2BridgeFrameType {
  switch (value) {
    case Ppk2BridgeFrameType.Data:
    case Ppk2BridgeFrameType.UsbConnected:
    case Ppk2BridgeFrameType.UsbDisconnected:
      return value;
    default:
      throw new Error(`Unknown PPK2 bridge frame type ${value}`);
  }
}

function validateLength(type: Ppk2BridgeFrameType, payloadLength: number): void {
  switch (type) {
    case Ppk2BridgeFrameType.Data:
      if (payloadLength < 1 || payloadLength > PPK2_BRIDGE_MAX_PAYLOAD_BYTES) {
        throw new Error("PPK2 bridge data payload length is invalid");
      }
      return;
    case Ppk2BridgeFrameType.UsbConnected:
    case Ppk2BridgeFrameType.UsbDisconnected:
      if (payloadLength !== 0) {
        throw new Error("PPK2 bridge status frames must not carry payload bytes");
      }
      return;
  }
}
