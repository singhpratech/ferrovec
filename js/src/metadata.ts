/**
 * Per-document metadata: validation and the one JSON serialisation the worker
 * does per insert.
 *
 * Metadata is a plain JSON object stored beside a document's text. The engine
 * serialises it once on insert (the string goes into the write-ahead log and
 * sets the size cap) and keeps the parsed object in memory; the snapshot
 * writer serialises the in-memory objects as part of its id→text JSON.
 *
 * Pure: no DOM, no Worker, no wasm.
 */

/** A document's metadata: a JSON-serialisable plain object. */
export type Metadata = Record<string, unknown>;

/** Largest serialised metadata accepted per document, in UTF-8 bytes (64 KiB). */
export const METADATA_MAX_BYTES = 64 * 1024;

const encoder = new TextEncoder();

/** `true` for a non-null, non-array object (what `JSON.parse` gives for `{...}`). */
export function isPlainJsonObject(value: unknown): value is Metadata {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Serialise `metadata` to JSON. Throws `TypeError` when it is not a plain
 * object or holds something JSON cannot represent (a function, symbol, BigInt,
 * or a cycle), and `RangeError('metadata too large')` when the JSON is longer
 * than {@link METADATA_MAX_BYTES} UTF-8 bytes. Values JSON drops or rewrites
 * (`undefined` properties, `NaN`, `Date`) follow `JSON.stringify` rules.
 */
export function serializeMetadata(metadata: unknown): string {
  if (!isPlainJsonObject(metadata)) {
    throw new TypeError('[ferrovec] metadata must be a plain object');
  }
  let json: string;
  try {
    json = JSON.stringify(metadata, (key, value: unknown) => {
      const type = typeof value;
      if (type === 'function' || type === 'symbol' || type === 'bigint') {
        throw new TypeError(`${type} at key "${key}"`);
      }
      return value;
    });
  } catch (err) {
    throw new TypeError(
      `[ferrovec] metadata is not JSON-serialisable: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  // UTF-8 is at most 3 bytes per UTF-16 unit, so short strings skip the encode.
  if (json.length * 3 > METADATA_MAX_BYTES && encoder.encode(json).length > METADATA_MAX_BYTES) {
    throw new RangeError('metadata too large');
  }
  return json;
}
