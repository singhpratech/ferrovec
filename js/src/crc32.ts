/**
 * IEEE CRC-32 (the zlib / PNG / Ethernet polynomial, reflected `0xEDB88320`).
 *
 * Used by the FVS2 snapshot framing ({@link encodeSnapshot}) to detect torn or
 * bit-rotted OPFS writes before any byte reaches the wasm core. A CRC is not a
 * cryptographic MAC — it guards against accidental corruption (a tab killed
 * mid-write, a truncated file), not against an adversary who can write OPFS.
 *
 * Table-driven, init `0xFFFFFFFF`, final xor `0xFFFFFFFF`. Streaming via
 * {@link Crc32} so the snapshot can be checksummed in two pieces (the header
 * with its own crc field skipped, then the body) without copying.
 *
 * Pure: no DOM, no Worker, no wasm.
 */

/** 256-entry lookup table for the reflected polynomial, built once at load. */
const TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

/** Incremental CRC-32: feed chunks with {@link update}, read with {@link digest}. */
export class Crc32 {
  #crc = 0xffffffff;

  /** Fold `chunk` into the running checksum. Returns `this` for chaining. */
  update(chunk: Uint8Array): this {
    let c = this.#crc;
    for (let i = 0; i < chunk.length; i++) {
      c = TABLE[(c ^ chunk[i]!) & 0xff]! ^ (c >>> 8);
    }
    this.#crc = c;
    return this;
  }

  /** The CRC-32 of everything fed so far, as an unsigned 32-bit integer. */
  digest(): number {
    return (this.#crc ^ 0xffffffff) >>> 0;
  }
}

/** One-shot CRC-32 of `bytes`. */
export function crc32(bytes: Uint8Array): number {
  return new Crc32().update(bytes).digest();
}
