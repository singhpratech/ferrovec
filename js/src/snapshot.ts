/**
 * The on-disk snapshot format shared by the persistence store (producer, on
 * commit) and the leader worker (consumer, on reload).
 *
 * A persisted snapshot is a single self-describing, checksummed blob so that one
 * write / truncate / flush keeps the vector index and its id→text sidecar
 * atomically in sync, and so that a torn or bit-flipped file is *detected*
 * rather than decoded into a wrong index.
 *
 * ## FVS2 layout (all integers big-endian)
 * ```
 *   offset size  field
 *   0      4     magic "FVS2" (0x46565332)
 *   4      2     uint16 formatVersion = 2
 *   6      2     uint16 flags = 0          (reserved; a future codec lives here)
 *   8      8     uint64 sequence           (commit counter, >= 1)
 *   16     4     uint32 metaLen
 *   20     4     uint32 coreLen
 *   24     4     uint32 textsLen
 *   28     4     uint32 crc32
 *   32     ...   meta   UTF-8 JSON ({@link SnapshotMeta}), metaLen bytes
 *          ...   core   FerrovecCore.toBytes(), coreLen bytes
 *          ...   texts  UTF-8 JSON of [id, text][] (may be empty), textsLen bytes
 * ```
 * `crc32` is IEEE CRC-32 over the whole file with the 4-byte crc field skipped
 * (`bytes[0..28) ++ bytes[32..end)`). The three section lengths must sum to
 * exactly the file length, so truncation *and* trailing garbage are both caught
 * by a cheap length check before the CRC is even computed.
 *
 * ## Legacy input (read-only migration path)
 * - **FVS1** (`"FVS1"`, uint32 coreLen, core, texts) — the pre-0.4 single-file
 *   format. No checksum exists, so it is decoded as before (with a bounds check)
 *   and reported as `formatVersion: 1`, `sequence: 0n`, `meta: null`.
 * - **Raw core bytes** — a bare `FerrovecCore.toBytes()` blob with no framing.
 *   Accepted only when it starts with the core's own `"FVEC"` magic; any other
 *   unrecognised header is `bad-magic`. (Accepting *any* non-FVS header as a raw
 *   core would let a single bit-flip in the FVS2 magic bypass the CRC entirely.)
 *
 * The FVS2 writer never produces either legacy shape.
 *
 * This module is intentionally pure (no DOM, no Worker, no wasm) so it stays
 * importable from the Node-testable {@link Engine} and slot store.
 */

import { Crc32 } from './crc32.ts';
import { SnapshotCorruptError } from './errors.ts';

/** `"FVS2"` as a big-endian uint32. */
const MAGIC_V2 = 0x46565332;
/** `"FVS1"` as a big-endian uint32 (legacy, read-only). */
const MAGIC_V1 = 0x46565331;
/** `"FVEC"` — the wasm core's own `toBytes()` magic (legacy raw-core input). */
const MAGIC_CORE = 0x46564543;

const FORMAT_VERSION = 2;
const HEADER_LEN = 32;
const CRC_OFFSET = 28;

/**
 * Identifies the writer recorded in {@link SnapshotMeta.writer}. Kept as a
 * literal (not read from package.json) so this module stays dependency-free;
 * update it alongside the package version.
 */
export const SNAPSHOT_WRITER = 'ferrovec-js/0.3.4';

/** The embedding model + geometry a store's vectors live in. */
export interface EmbeddingSpace {
  /** Model id (e.g. `Xenova/all-MiniLM-L6-v2`), or `'<unknown>'`. */
  model: string;
  /** Vector dimensionality. */
  dims: number;
  /** Distance metric the core indexes with. */
  metric: 'cosine';
}

/** Self-description stored in every FVS2 snapshot. */
export interface SnapshotMeta {
  embeddingSpace: EmbeddingSpace;
  /** Live items in the index at commit time. */
  count: number;
  /** Writer identity, e.g. `"ferrovec-js/0.3.4"`. */
  writer: string;
  /** `Date.now()` at commit. */
  createdAt: number;
}

/**
 * What the engine hands the persistence store on each commit. The store (not
 * the engine) owns the commit `sequence`, so it does the {@link encodeSnapshot}.
 */
export interface SnapshotSource {
  core: Uint8Array;
  texts: Map<string, string>;
  meta: SnapshotMeta;
}

/** A fully decoded snapshot. */
export interface DecodedSnapshot {
  /** `2` for FVS2; `1` for legacy FVS1 or raw-core input. */
  formatVersion: 1 | 2;
  /** Commit counter; `0n` for legacy input. */
  sequence: bigint;
  /** Self-description; `null` for legacy input. */
  meta: SnapshotMeta | null;
  core: Uint8Array;
  texts: Map<string, string>;
}

/** Frame `core`, `texts`, and the header fields into a single FVS2 blob. */
export function encodeSnapshot(
  core: Uint8Array,
  texts: Map<string, string>,
  header: { sequence: bigint; meta: SnapshotMeta },
): Uint8Array {
  const encoder = new TextEncoder();
  const metaBytes = encoder.encode(JSON.stringify(header.meta));
  const textBytes = encoder.encode(texts.size > 0 ? JSON.stringify([...texts.entries()]) : '');

  const out = new Uint8Array(HEADER_LEN + metaBytes.length + core.length + textBytes.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, MAGIC_V2, false);
  view.setUint16(4, FORMAT_VERSION, false);
  view.setUint16(6, 0, false);
  view.setBigUint64(8, header.sequence, false);
  view.setUint32(16, metaBytes.length, false);
  view.setUint32(20, core.length, false);
  view.setUint32(24, textBytes.length, false);

  let at = HEADER_LEN;
  out.set(metaBytes, at);
  at += metaBytes.length;
  out.set(core, at);
  at += core.length;
  out.set(textBytes, at);

  view.setUint32(CRC_OFFSET, checksum(out), false);
  return out;
}

/**
 * Parse and fully validate a snapshot blob. Throws {@link SnapshotCorruptError}
 * on any framing, length, checksum, or JSON failure — it never returns a
 * partially-decoded result.
 */
export function decodeSnapshot(bytes: Uint8Array): DecodedSnapshot {
  if (bytes.length < 4) throw new SnapshotCorruptError('too-short', `${bytes.length} bytes`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = view.getUint32(0, false);

  if (magic === MAGIC_V2) return decodeV2(bytes, view);
  if (magic === MAGIC_V1) return decodeV1(bytes, view);
  if (magic === MAGIC_CORE) {
    if (bytes.length < 8) throw new SnapshotCorruptError('too-short', `${bytes.length} bytes`);
    // Legacy bare core, no sidecar: its texts are simply unknown.
    return { formatVersion: 1, sequence: 0n, meta: null, core: bytes, texts: new Map() };
  }
  throw new SnapshotCorruptError('bad-magic', `0x${magic.toString(16).padStart(8, '0')}`);
}

function decodeV2(bytes: Uint8Array, view: DataView): DecodedSnapshot {
  if (bytes.length < HEADER_LEN) {
    throw new SnapshotCorruptError('too-short', `${bytes.length} < ${HEADER_LEN}-byte header`);
  }
  const version = view.getUint16(4, false);
  if (version !== FORMAT_VERSION) throw new SnapshotCorruptError('bad-version', `version ${version}`);

  const sequence = view.getBigUint64(8, false);
  const metaLen = view.getUint32(16, false);
  const coreLen = view.getUint32(20, false);
  const textsLen = view.getUint32(24, false);
  const expected = HEADER_LEN + metaLen + coreLen + textsLen;
  if (expected !== bytes.length) {
    throw new SnapshotCorruptError('bad-length', `header declares ${expected} bytes, file has ${bytes.length}`);
  }

  const stored = view.getUint32(CRC_OFFSET, false);
  const actual = checksum(bytes);
  if (stored !== actual) throw new SnapshotCorruptError('bad-crc', `stored ${stored}, computed ${actual}`);

  let at = HEADER_LEN;
  const metaBytes = bytes.subarray(at, at + metaLen);
  at += metaLen;
  const core = bytes.subarray(at, at + coreLen);
  at += coreLen;
  const textBytes = bytes.subarray(at, at + textsLen);

  return {
    formatVersion: 2,
    sequence,
    meta: parseMeta(metaBytes),
    core,
    texts: parseTexts(textBytes),
  };
}

function decodeV1(bytes: Uint8Array, view: DataView): DecodedSnapshot {
  if (bytes.length < 8) throw new SnapshotCorruptError('too-short', `${bytes.length} bytes`);
  const coreLen = view.getUint32(4, false);
  if (8 + coreLen > bytes.length) {
    throw new SnapshotCorruptError('bad-length', `FVS1 core of ${coreLen} bytes exceeds file of ${bytes.length}`);
  }
  return {
    formatVersion: 1,
    sequence: 0n,
    meta: null,
    core: bytes.subarray(8, 8 + coreLen),
    texts: parseTexts(bytes.subarray(8 + coreLen)),
  };
}

/** CRC-32 over the whole blob with the 4-byte crc field at [28..32) skipped. */
function checksum(bytes: Uint8Array): number {
  return new Crc32()
    .update(bytes.subarray(0, CRC_OFFSET))
    .update(bytes.subarray(HEADER_LEN))
    .digest();
}

function parseMeta(metaBytes: Uint8Array): SnapshotMeta {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(metaBytes));
  } catch (err) {
    throw new SnapshotCorruptError('bad-meta', err instanceof Error ? err.message : String(err));
  }
  const m = parsed as Partial<SnapshotMeta> | null;
  const space = m?.embeddingSpace;
  if (
    m === null ||
    typeof m !== 'object' ||
    space === null ||
    typeof space !== 'object' ||
    typeof space.model !== 'string' ||
    typeof space.dims !== 'number' ||
    typeof m.count !== 'number'
  ) {
    throw new SnapshotCorruptError('bad-meta', 'missing embeddingSpace/count');
  }
  return m as SnapshotMeta;
}

function parseTexts(textBytes: Uint8Array): Map<string, string> {
  if (textBytes.length === 0) return new Map();
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(textBytes));
  } catch (err) {
    throw new SnapshotCorruptError('bad-texts', err instanceof Error ? err.message : String(err));
  }
  if (
    !Array.isArray(parsed) ||
    !parsed.every(
      (e) => Array.isArray(e) && e.length === 2 && typeof e[0] === 'string' && typeof e[1] === 'string',
    )
  ) {
    throw new SnapshotCorruptError('bad-texts', 'expected an array of [id, text] string pairs');
  }
  return new Map(parsed as Array<[string, string]>);
}
