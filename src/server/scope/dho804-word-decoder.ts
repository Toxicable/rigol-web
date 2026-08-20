/**
 * Decode native DHO804 WORD samples as unsigned little-endian 16-bit values.
 *
 * This matches current DHO-capable scopehal behaviour and is intentionally
 * isolated because the DHO800 programming guide does not fully specify native
 * WORD byte ordering. Real DHO804 verification is still required.
 */
export function decodeDho804WordSamples(payload: Uint8Array): Uint16Array {
  if (payload.byteLength % 2 !== 0) {
    throw new Error("DHO804 WORD payload length must be even");
  }

  const output = new Uint16Array(payload.byteLength / 2);
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  for (let index = 0; index < output.length; index += 1) {
    output[index] = view.getUint16(index * 2, true);
  }
  return output;
}
