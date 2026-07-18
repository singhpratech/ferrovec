/**
 * The on-disk snapshot format shared by {@link Engine} (producer) and the
 * dedicated worker (consumer, on reload).
 *
 * A persisted store is a single self-describing blob so that one write /
 * truncate / flush keeps the vector index and its id→text sidecar atomically in
 * sync — there is no window where `index.bin` holds vectors without their text
 * or vice-versa.
 *
 * Layout (all integers big-endian):
 * ```
 *   [0..4)            magic  "FVS1"
 *   [4..8)            uint32 coreLen
 *   [8..8+coreLen)    core   FerrovecCore.toBytes()
 *   [8+coreLen..end)  texts  UTF-8 JSON of [id, text][] (may be empty)
 * ```
 *
 * This module is intentionally pure (no DOM, no Worker, no wasm) so it stays
 * importable from the Node-testable {@link Engine}.
 */

/** `"FVS1"` as a big-endian uint32. */
const MAGIC = 0x46565331;

/** A decoded snapshot: the raw core bytes plus the id→text sidecar. */
export interface DecodedSnapshot {
  core: Uint8Array;
  texts: Map<string, string>;
}

/** Frame `core` bytes and the `texts` sidecar into a single snapshot blob. */
export function encodeSnapshot(core: Uint8Array, texts: Map<string, string>): Uint8Array {
  const json = texts.size > 0 ? JSON.stringify([...texts.entries()]) : '';
  const textBytes = new TextEncoder().encode(json);

  const out = new Uint8Array(8 + core.length + textBytes.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, MAGIC, false);
  view.setUint32(4, core.length, false);
  out.set(core, 8);
  out.set(textBytes, 8 + core.length);
  return out;
}

/**
 * Parse a snapshot blob back into its core bytes and id→text sidecar.
 *
 * As a graceful-upgrade path, a blob without the `FVS1` magic is treated as raw
 * `FerrovecCore.toBytes()` output with no sidecar, so a store written by a
 * hypothetical core-only writer still loads (its texts are simply unknown).
 */
export function decodeSnapshot(bytes: Uint8Array): DecodedSnapshot {
  if (bytes.length < 8) {
    // Too short to be a framed snapshot; treat as raw core bytes.
    return { core: bytes, texts: new Map() };
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, false) !== MAGIC) {
    return { core: bytes, texts: new Map() };
  }

  const coreLen = view.getUint32(4, false);
  const core = bytes.subarray(8, 8 + coreLen);
  const textBytes = bytes.subarray(8 + coreLen);

  let texts = new Map<string, string>();
  if (textBytes.length > 0) {
    const parsed = JSON.parse(new TextDecoder().decode(textBytes)) as Array<[string, string]>;
    texts = new Map(parsed);
  }
  return { core, texts };
}
