import { Buffer } from "node:buffer";

import { describe, expect, it } from "vitest";

import {
  PPK2_BRIDGE_HEADER_BYTES,
  PPK2_BRIDGE_PROTOCOL_VERSION,
  Ppk2BridgeFrameParser,
  Ppk2BridgeFrameType,
} from "./ppk2-bridge-protocol.js";

function frame(
  type: Ppk2BridgeFrameType,
  sourceSessionId: number,
  streamOffset: number,
  payload = Buffer.alloc(0),
): Buffer {
  const result = Buffer.alloc(PPK2_BRIDGE_HEADER_BYTES + payload.length);
  result.write("TBP2", 0, "ascii");
  result.writeUInt8(PPK2_BRIDGE_PROTOCOL_VERSION, 4);
  result.writeUInt8(type, 5);
  result.writeUInt16LE(0, 6);
  result.writeUInt32LE(sourceSessionId, 8);
  result.writeBigUInt64LE(BigInt(streamOffset), 12);
  result.writeUInt32LE(payload.length, 20);
  payload.copy(result, PPK2_BRIDGE_HEADER_BYTES);
  return result;
}

describe("Ppk2BridgeFrameParser", () => {
  it("reassembles a fragmented data frame without changing payload bytes", () => {
    const parser = new Ppk2BridgeFrameParser();
    const encoded = frame(
      Ppk2BridgeFrameType.Data,
      0x12345678,
      99,
      Buffer.from([0x00, 0xff, 0x13, 0x37]),
    );

    expect(parser.push(encoded.subarray(0, 7))).toEqual([]);
    expect(parser.push(encoded.subarray(7, 25))).toEqual([]);
    expect(parser.push(encoded.subarray(25))).toEqual([{
      type: Ppk2BridgeFrameType.Data,
      sourceSessionId: 0x12345678,
      streamOffset: 99,
      payload: Buffer.from([0x00, 0xff, 0x13, 0x37]),
    }]);
  });

  it("parses status and data frames from one TCP chunk", () => {
    const parser = new Ppk2BridgeFrameParser();
    const encoded = Buffer.concat([
      frame(Ppk2BridgeFrameType.UsbConnected, 7, 1234),
      frame(Ppk2BridgeFrameType.Data, 7, 1234, Buffer.from([1, 2, 3, 4])),
    ]);

    expect(parser.push(encoded)).toEqual([
      {
        type: Ppk2BridgeFrameType.UsbConnected,
        sourceSessionId: 7,
        streamOffset: 1234,
        payload: Buffer.alloc(0),
      },
      {
        type: Ppk2BridgeFrameType.Data,
        sourceSessionId: 7,
        streamOffset: 1234,
        payload: Buffer.from([1, 2, 3, 4]),
      },
    ]);
  });

  it("rejects malformed framing instead of attempting resynchronization", () => {
    const badMagic = frame(Ppk2BridgeFrameType.UsbConnected, 1, 0);
    badMagic[0] = 0;
    expect(() => new Ppk2BridgeFrameParser().push(badMagic)).toThrow("magic");

    const badVersion = frame(Ppk2BridgeFrameType.UsbConnected, 1, 0);
    badVersion[4] = PPK2_BRIDGE_PROTOCOL_VERSION + 1;
    expect(() => new Ppk2BridgeFrameParser().push(badVersion)).toThrow("protocol version");

    const badReserved = frame(Ppk2BridgeFrameType.UsbConnected, 1, 0);
    badReserved.writeUInt16LE(1, 6);
    expect(() => new Ppk2BridgeFrameParser().push(badReserved)).toThrow("reserved");

    const zeroSession = frame(Ppk2BridgeFrameType.UsbConnected, 1, 0);
    zeroSession.writeUInt32LE(0, 8);
    expect(() => new Ppk2BridgeFrameParser().push(zeroSession)).toThrow("sourceSessionId");
  });

  it("rejects payload on status frames", () => {
    const encoded = frame(
      Ppk2BridgeFrameType.UsbDisconnected,
      1,
      20,
      Buffer.from([1]),
    );
    expect(() => new Ppk2BridgeFrameParser().push(encoded)).toThrow("status frames");
  });
});
