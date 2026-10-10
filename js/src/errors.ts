/**
 * Typed errors for ferrovec's durability guarantees.
 *
 * Each class sets a stable `name` so callers can `switch (err.name)` even after
 * the error crosses the worker boundary: the worker protocol serializes errors
 * as `{ error: message, errorName: name }` and the main-thread {@link Ferrovec}
 * proxy rethrows an `Error` whose `name` is restored from `errorName` (the class
 * identity itself does not survive `postMessage`).
 *
 * Pure: no DOM, no Worker, no wasm.
 */

import type { EmbeddingSpace } from './snapshot.ts';

/** Why a snapshot blob failed to decode. */
export type SnapshotCorruptReason =
  | 'too-short'
  | 'bad-magic'
  | 'bad-version'
  | 'bad-length'
  | 'bad-crc'
  | 'bad-meta'
  | 'bad-texts';

/**
 * A snapshot blob is torn, truncated, bit-flipped, or otherwise not a valid
 * snapshot. Thrown by `decodeSnapshot` before any byte reaches the wasm core, so
 * corruption never yields a wrong (partially-decoded) index.
 */
export class SnapshotCorruptError extends Error {
  override name = 'SnapshotCorruptError' as const;
  readonly reason: SnapshotCorruptReason;

  constructor(reason: SnapshotCorruptReason, detail?: string) {
    super(`[ferrovec] corrupt snapshot (${reason})${detail ? `: ${detail}` : ''}`);
    this.reason = reason;
  }
}

/** `dims` of `0` means "not yet known" (the model is checked before it loads). */
function describeDims(dims: number): string {
  return dims > 0 ? `${dims} dims` : 'dims not yet known';
}

/**
 * The store was written with a different embedding model / dimensionality than
 * the one it is being opened with. Vectors from two embedding spaces are not
 * comparable, so answering queries would return confidently wrong neighbours.
 */
export class EmbeddingSpaceMismatchError extends Error {
  override name = 'EmbeddingSpaceMismatchError' as const;
  readonly stored: EmbeddingSpace;
  readonly requested: EmbeddingSpace;

  constructor(stored: EmbeddingSpace, requested: EmbeddingSpace) {
    super(
      `[ferrovec] embedding space mismatch: this store holds vectors from model ` +
        `"${stored.model}" (${describeDims(stored.dims)}), but it was opened with model ` +
        `"${requested.model}" (${describeDims(requested.dims)}). Open it with ` +
        `{ model: "${stored.model}" }, or call Ferrovec.destroy(name) to delete ` +
        `the store and start over with the new model.`,
    );
    this.stored = stored;
    this.requested = requested;
  }
}

/**
 * Every snapshot slot of a persisted store is present but undecodable. Thrown
 * instead of silently starting empty, which would overwrite the evidence (and
 * any recoverable data) on the first commit.
 */
export class StoreCorruptError extends Error {
  override name = 'StoreCorruptError' as const;
  readonly slots: Array<{ file: string; reason: string }>;

  constructor(storeName: string, slots: Array<{ file: string; reason: string }>) {
    super(
      `[ferrovec] store "${storeName}" is corrupt: no valid snapshot ` +
        `(${slots.map((s) => `${s.file}: ${s.reason}`).join('; ')}). ` +
        `Call Ferrovec.destroy(name) to delete it and start over.`,
    );
    this.slots = slots;
  }
}

/**
 * A commit would replace a non-empty on-disk index with an empty one although
 * nothing was removed since open — the signature of a failed rehydrate (e.g. an
 * engine built empty over real data), not of user intent. The write is refused
 * so the on-disk index survives.
 */
export class EmptyOverwriteRefusedError extends Error {
  override name = 'EmptyOverwriteRefusedError' as const;
  readonly onDiskCount: number;

  constructor(onDiskCount: number) {
    super(
      `[ferrovec] refusing to overwrite an on-disk index of ${onDiskCount} item(s) ` +
        `with an empty one: nothing was removed since open, so the empty in-memory ` +
        `index is likely a failed load rather than intent. The on-disk data was ` +
        `left untouched.`,
    );
    this.onDiskCount = onDiskCount;
  }
}
