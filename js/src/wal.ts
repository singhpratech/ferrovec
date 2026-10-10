/**
 * The write-ahead log format: one durable record per acknowledged mutation.
 *
 * Phase 0 made each full snapshot crash-safe, but a snapshot is written on a
 * timer and rewrites the whole index, so an insert acknowledged to the caller
 * could still be lost if the tab died before the next commit. The WAL closes
 * that window: every insert/remove is appended (and, in strict mode, flushed)
 * as one small framed record *before* its promise resolves, and the full
 * snapshot becomes a periodic checkpoint that the log is replayed on top of.
 *
 * ## `wal.bin` layout (little-endian, except the header magic)
 * ```
 * header, 24 bytes
 *   0   4  magic "FVW1"            (raw bytes, so a hex dump reads "FVW1")
 *   4   2  u16 version = 1
 *   6   2  u16 flags = 0           (reserved)
 *   8   8  u64 baseSequence        (FVS2 snapshot sequence this log applies on top of; 0 = none)
 *   16  4  u32 dims
 *   20  4  u32 headerCrc = crc32(bytes[0..20))
 * records, repeated until EOF
 *   u32 payloadLen
 *   u32 payloadCrc = crc32(payload)
 *   payload:
 *     u8  kind                     1 = insert (upsert), 2 = remove
 *     u16 idLen, id UTF-8
 *     insert only: f32[dims] vector, u32 textLen, text UTF-8
 * ```
 *
 * ## Torn tails are normal
 * A tab killed mid-append leaves a partial last record. {@link scanWal} treats
 * the first record that overruns the file, fails its CRC, or does not parse as
 * the end of the log: everything before it is returned, nothing after it is
 * trusted, and the caller truncates the file back to the last good record. A
 * record is therefore applied whole or not at all — replay never sees a torn
 * record. Only a bad *header* is an error ({@link WalCorruptError}), because
 * then the log's base and geometry are unknowable.
 *
 * Pure: no DOM, no Worker, no wasm.
 */

import { crc32 } from './crc32.ts';
import { WalCorruptError } from './errors.ts';

/** One logged mutation. `insert` is an upsert, exactly like `Engine.insert`. */
export type WalRecord =
  | { kind: 'insert'; id: string; vector: Float32Array; text: string }
  | { kind: 'remove'; id: string };

/** The decoded {@link WAL_HEADER_LEN}-byte log header. */
export interface WalHeader {
  /** The FVS2 snapshot sequence the records apply on top of (`0n` = no snapshot). */
  baseSequence: bigint;
  /** Vector dimensionality of every insert record. */
  dims: number;
}

/** Result of {@link scanWal}. */
export interface WalScan {
  /** Every complete, checksummed record, in log order. */
  records: WalRecord[];
  /** Byte offset just past the last good record (≥ {@link WAL_HEADER_LEN}). */
  validLength: number;
  /** `true` when bytes follow {@link validLength} (a torn or corrupt tail). */
  truncatedTail: boolean;
}

/** Size of the fixed log header, in bytes. */
export const WAL_HEADER_LEN = 24;
/** Size of a record's `payloadLen` + `payloadCrc` prefix, in bytes. */
const RECORD_PREFIX_LEN = 8;

/** `"FVW1"` as raw bytes. */
const MAGIC = [0x46, 0x56, 0x57, 0x31] as const;
const VERSION = 1;
const KIND_INSERT = 1;
const KIND_REMOVE = 2;
const MAX_ID_BYTES = 0xffff;

const encoder = new TextEncoder();
/** Fatal, so a malformed UTF-8 payload is a stop condition rather than U+FFFD. */
const decoder = new TextDecoder('utf-8', { fatal: true });

/** Encode the 24-byte log header. */
export function encodeWalHeader(header: { baseSequence: bigint; dims: number }): Uint8Array {
  const bytes = new Uint8Array(WAL_HEADER_LEN);
  const view = new DataView(bytes.buffer);
  bytes.set(MAGIC, 0);
  view.setUint16(4, VERSION, true);
  view.setUint16(6, 0, true);
  view.setBigUint64(8, header.baseSequence, true);
  view.setUint32(16, header.dims, true);
  view.setUint32(20, crc32(bytes.subarray(0, 20)), true);
  return bytes;
}

/** Decode and validate the log header. Throws `WalCorruptError('bad-header')`. */
export function decodeWalHeader(bytes: Uint8Array): WalHeader {
  if (bytes.length < WAL_HEADER_LEN) {
    throw new WalCorruptError('bad-header', `short header (${bytes.length} bytes)`);
  }
  for (let i = 0; i < MAGIC.length; i++) {
    if (bytes[i] !== MAGIC[i]) throw new WalCorruptError('bad-header', 'bad magic');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, WAL_HEADER_LEN);
  const version = view.getUint16(4, true);
  if (version !== VERSION) throw new WalCorruptError('bad-header', `unsupported version ${version}`);
  if (view.getUint32(20, true) !== crc32(bytes.subarray(0, 20))) {
    throw new WalCorruptError('bad-header', 'header checksum mismatch');
  }
  return { baseSequence: view.getBigUint64(8, true), dims: view.getUint32(16, true) };
}

/**
 * Encode one record as `payloadLen ‖ payloadCrc ‖ payload`. Throws if an insert
 * vector's length is not `dims`, or an id exceeds 65535 UTF-8 bytes.
 */
export function encodeWalRecord(rec: WalRecord, dims: number): Uint8Array {
  const id = encoder.encode(rec.id);
  if (id.length > MAX_ID_BYTES) {
    throw new RangeError(`[ferrovec] id is ${id.length} UTF-8 bytes; the log allows at most ${MAX_ID_BYTES}`);
  }
  let payloadLen = 1 + 2 + id.length;
  let text: Uint8Array | null = null;
  if (rec.kind === 'insert') {
    if (rec.vector.length !== dims) {
      throw new RangeError(
        `[ferrovec] cannot log a ${rec.vector.length}-dim vector into a ${dims}-dim write-ahead log`,
      );
    }
    text = encoder.encode(rec.text);
    payloadLen += dims * 4 + 4 + text.length;
  }

  const out = new Uint8Array(RECORD_PREFIX_LEN + payloadLen);
  const view = new DataView(out.buffer);
  let off = RECORD_PREFIX_LEN;
  view.setUint8(off, rec.kind === 'insert' ? KIND_INSERT : KIND_REMOVE);
  off += 1;
  view.setUint16(off, id.length, true);
  off += 2;
  out.set(id, off);
  off += id.length;
  if (rec.kind === 'insert' && text) {
    for (let i = 0; i < dims; i++, off += 4) view.setFloat32(off, rec.vector[i]!, true);
    view.setUint32(off, text.length, true);
    off += 4;
    out.set(text, off);
  }
  view.setUint32(0, payloadLen, true);
  view.setUint32(4, crc32(out.subarray(RECORD_PREFIX_LEN)), true);
  return out;
}

/** Decode one checksum-verified payload, or `null` if it is malformed. */
function decodePayload(payload: Uint8Array, dims: number): WalRecord | null {
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  if (payload.length < 3) return null;
  const kind = view.getUint8(0);
  const idLen = view.getUint16(1, true);
  let off = 3;
  if (off + idLen > payload.length) return null;
  let id: string;
  try {
    id = decoder.decode(payload.subarray(off, off + idLen));
  } catch {
    return null;
  }
  off += idLen;
  if (kind === KIND_REMOVE) {
    return off === payload.length ? { kind: 'remove', id } : null;
  }
  if (kind !== KIND_INSERT) return null;
  if (off + dims * 4 + 4 > payload.length) return null;
  const vector = new Float32Array(dims);
  for (let i = 0; i < dims; i++, off += 4) vector[i] = view.getFloat32(off, true);
  const textLen = view.getUint32(off, true);
  off += 4;
  if (off + textLen !== payload.length) return null;
  let text: string;
  try {
    text = decoder.decode(payload.subarray(off, off + textLen));
  } catch {
    return null;
  }
  return { kind: 'insert', id, vector, text };
}

/**
 * Decode a whole log. Validates the header (throwing `WalCorruptError` only for
 * a bad one), then reads records until the first one that overruns the file,
 * fails its CRC, or is malformed. Never throws for a torn tail.
 */
export function scanWal(bytes: Uint8Array, dims: number): WalScan {
  decodeWalHeader(bytes);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const records: WalRecord[] = [];
  let off = WAL_HEADER_LEN;
  while (off < bytes.length) {
    if (off + RECORD_PREFIX_LEN > bytes.length) break;
    const payloadLen = view.getUint32(off, true);
    const start = off + RECORD_PREFIX_LEN;
    if (payloadLen === 0 || start + payloadLen > bytes.length) break;
    const payload = bytes.subarray(start, start + payloadLen);
    if (crc32(payload) !== view.getUint32(off + 4, true)) break;
    const rec = decodePayload(payload, dims);
    if (!rec) break;
    records.push(rec);
    off = start + payloadLen;
  }
  return { records, validLength: off, truncatedTail: off < bytes.length };
}
