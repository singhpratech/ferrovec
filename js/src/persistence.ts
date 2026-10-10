/**
 * OPFS persistence for the dedicated worker: an A/B-buffered snapshot store
 * plus a write-ahead log.
 *
 * A {@link PersistentStore} owns three files in `ferrovec/<name>/` in the
 * Origin Private File System — `slot-a.bin`, `slot-b.bin` (full snapshots) and
 * `wal.bin` (the write-ahead log) — each accessed through a synchronous access
 * handle held for the lifetime of the store. Sync handles are **worker-only**
 * and **secure-context-only**, which is why the OPFS adapter here is used
 * exclusively from the worker and never from the main thread.
 *
 * ## Why a write-ahead log
 *
 * A full snapshot rewrites the whole index, so it cannot run on every mutation.
 * Instead each insert/remove is appended to `wal.bin` as one small checksummed
 * record (see `wal.ts`) **before** it is acknowledged: in `'strict'` durability
 * (the default) the log is flushed before the caller's promise resolves; in
 * `'relaxed'` it is flushed at most every `relaxedFlushMs` (50 ms). On open, the
 * newest snapshot is loaded and the log's records are replayed on top of it
 * ({@link PersistentStore.initialReplay}). A torn last record — the normal
 * shape of a tab killed mid-append — is cut off; it was never acknowledged in
 * strict mode.
 *
 * ## Checkpoints, and why they cannot lose the log
 *
 * When the log grows past `checkpointBytes` (4 MiB) or `checkpointRecords`
 * (2000), and on `flush()`/`close()` when it holds any record, the store
 * checkpoints: (a) it writes a complete FVS2 snapshot with the next `sequence`
 * to the slot that does **not** hold the current one and flushes it, and (b)
 * **only then** resets the log to a fresh header whose `baseSequence` is that
 * new sequence. A threshold checkpoint runs on a later macrotask, after the
 * acknowledgement of the append that tripped it (that record is already in the
 * log), so no single insert pays for a full snapshot write. The log header
 * therefore always names the snapshot it applies on top of, and on open (`S` = newest valid snapshot sequence, `B` = log base):
 *
 * - `B === S` — replay the log (the common case, and the "crash during (a)"
 *   case: the torn slot is ignored, the older slot plus the full log is exact);
 * - `B < S` — a crash between (a) and (b): every logged record is already in
 *   the snapshot, so the log is discarded (never double-applied);
 * - `B > S` — impossible under this ordering (a log is never reset before the
 *   snapshot it depends on is durable); if seen, the newer snapshot was lost
 *   after the fact and the records it absorbed are gone, so open throws
 *   `StoreCorruptError` (`wal-ahead-of-snapshot`) instead of guessing.
 *
 * ## Why two slots
 *
 * Every checkpoint writes a complete, checksummed FVS2 snapshot (see
 * `snapshot.ts`) carrying a monotonically increasing `sequence`, and it always
 * writes to the slot that does **not** hold the current committed version. On
 * open, both slots are decoded and the valid one with the highest sequence
 * wins. A torn write (tab killed mid-`write`, partial truncate) can therefore
 * only ever damage the *target* slot; the previous checkpoint in the other slot
 * is never touched and is recovered on the next open. The torn slot is simply
 * the target of the next checkpoint, which overwrites it.
 *
 * **Durability scope.** OPFS `flush()` guarantees content consistency for other
 * readers of the file; it is **not** an `fsync`. The guarantee is "survives a
 * tab kill / crash and reload", not "survives power loss or an OS crash".
 *
 * ## Safety rails
 *
 * - If slots exist but none decodes, open throws `StoreCorruptError` — it never
 *   silently starts empty over corrupt data. The one exception is a single torn
 *   slot next to an empty one with an intact legacy `index.bin` (an interrupted
 *   first migration commit): the legacy file is migrated again. A log with an
 *   unreadable header is ignored (with a warning) only when a valid snapshot
 *   exists to fall back on.
 * - A checkpoint that would replace a non-empty on-disk index with an empty
 *   one, when nothing was removed since open (replayed removes count), throws
 *   `EmptyOverwriteRefusedError` and writes nothing (the signature of a failed
 *   rehydrate, not of intent).
 * - A pre-slot store (`index.bin`, FVS1 / raw core) is read once as a migration
 *   source; after the first successful checkpoint it is deleted best-effort.
 *
 * The store logic ({@link SlotStore}) runs against the tiny
 * {@link SlotFileSystem} abstraction so it is unit-testable under Node with an
 * in-memory fake; {@link openStore} supplies the OPFS-backed implementation.
 *
 * Each sync handle holds an **exclusive lock** on its file. If another tab
 * already holds one, `createSyncAccessHandle()` throws — we retry per the
 * caller's budget, then either degrade to a non-persistent in-memory store
 * (solo opens) or throw (lock-holding leaders, see `requireLock`).
 */

import {
  EmptyOverwriteRefusedError,
  SnapshotCorruptError,
  StoreCorruptError,
  WalCorruptError,
} from './errors.ts';
import {
  decodeSnapshot,
  encodeSnapshot,
  type DecodedSnapshot,
  type SnapshotSource,
} from './snapshot.ts';
import type { Durability, Persister } from './types.ts';
import {
  WAL_HEADER_LEN,
  decodeWalHeader,
  encodeWalHeader,
  encodeWalRecord,
  scanWal,
  type WalRecord,
} from './wal.ts';

export type { SnapshotSource } from './snapshot.ts';

/** Default log size that triggers a checkpoint: 4 MiB. */
const DEFAULT_CHECKPOINT_BYTES = 4 * 1024 * 1024;
/** Default record count that triggers a checkpoint. */
const DEFAULT_CHECKPOINT_RECORDS = 2000;
/** Default relaxed-mode flush window, in ms. */
const DEFAULT_RELAXED_FLUSH_MS = 50;

/** Durability and checkpoint tuning shared by {@link OpenStoreOptions} and {@link SlotStoreOptions}. */
export interface WalOptions {
  /**
   * `'strict'` (default): every insert/remove is flushed to OPFS before its
   * promise resolves (survives a tab kill). `'relaxed'`: acknowledged up to
   * 50 ms before the flush — faster, but a tab kill can lose the last ~50 ms of
   * acknowledged writes.
   */
  durability?: Durability;
  /** Checkpoint once the log reaches this many bytes. Defaults to 4 MiB. */
  checkpointBytes?: number;
  /** Checkpoint once the log holds this many records. Defaults to `2000`. */
  checkpointRecords?: number;
  /** Relaxed-mode flush window, in ms. Defaults to `50`. */
  relaxedFlushMs?: number;
}

/** Options controlling how a store is opened. */
export interface OpenStoreOptions extends WalOptions {
  /** Opt out of persistence entirely (pure in-memory). Defaults to `true`. */
  persist?: boolean;
  /**
   * On sync-handle contention, retry acquiring the exclusive handles this many
   * times before falling back to in-memory. Defaults to `0` (single attempt —
   * today's prompt fallback). The M6 coordinator passes a small budget so a
   * *promoted* leader can wait out the previous leader's OPFS-handle teardown
   * during a crash failover (the Web Lock and the sync handle release
   * independently, so there is a brief window where both are contended).
   */
  contentionRetries?: number;
  /** Delay between contention retries, in ms. Defaults to `50`. */
  retryDelayMs?: number;
  /**
   * The caller holds the exclusive leader Web Lock, so it is the one legitimate
   * owner of the store files. On sync-handle contention it must **never**
   * silently fall back to in-memory: doing so would present an intact on-disk
   * index as empty and accept writes that are discarded on reload while the
   * files sit untouched. Instead retry for a much longer deadline
   * ({@link LOCKED_CONTENTION_RETRIES}) and, if the handles truly never free,
   * **throw** so promotion fails loudly rather than degrading. Ordinary
   * (solo / no-lock) opens leave this `false` and keep the best-effort in-memory
   * fallback unchanged. Defaults to `false`.
   */
  requireLock?: boolean;
}

/**
 * When the caller holds the leader Web Lock ({@link OpenStoreOptions.requireLock}),
 * keep retrying the OPFS sync handles at least this many times before giving up.
 * The outgoing owner's handles always free once its tab/process finishes tearing
 * down — even a crashed tab's OS-level cleanup completes — so a generous deadline
 * (≈ 200 × 50ms = 10s) covers the handoff without silently degrading to memory.
 */
const LOCKED_CONTENTION_RETRIES = 200;

/**
 * A store the {@link Engine} can persist into. Extends {@link Persister} (the
 * mutation-facing surface) with the load-time state, the persistence mode, and
 * a `bind` hook the coordinator uses to supply the snapshot source once the
 * engine (and thus the core) exists.
 */
export interface PersistentStore extends Persister {
  /** Whether writes actually reach disk. `false` = degraded/in-memory. */
  readonly persistent: boolean;
  /** The committed snapshot found at open time, or `null` when starting empty. */
  readonly initialSnapshot: DecodedSnapshot | null;
  /**
   * The write-ahead-log records to replay on top of {@link initialSnapshot}, in
   * order (acknowledged after the last checkpoint). Empty for in-memory stores.
   */
  readonly initialReplay: WalRecord[];
  /** The dims recorded in the log header found at open, or `null` if none was kept. */
  readonly walDims: number | null;
  /** Live items in the on-disk index; `-1` when unknown (a legacy raw core with no text sidecar). */
  readonly onDiskCount: number;
  /**
   * Supply the function that produces the snapshot contents on demand, and the
   * index dims (so a log header can be written even when the first logged
   * mutation of a fresh store is a remove, which carries no vector).
   */
  bind(source: () => SnapshotSource, options?: { dims?: number }): void;
}

/** The files a store may touch inside its directory. */
export type StoreFile = 'slot-a.bin' | 'slot-b.bin' | 'index.bin' | 'wal.bin';
type SlotName = 'slot-a.bin' | 'slot-b.bin';

/**
 * Minimal file abstraction; OPFS `FileSystemSyncAccessHandle` and an in-memory
 * test fake both implement it. Declared locally so the build does not depend on
 * the host lib shipping the (still-recent) sync-handle DOM typings.
 */
export interface SlotFile {
  read(buffer: Uint8Array, options: { at: number }): number;
  write(buffer: Uint8Array, options: { at: number }): number;
  truncate(newSize: number): void;
  getSize(): number;
  flush(): void;
  close(): void;
}

/** The directory a {@link SlotStore} lives in. */
export interface SlotFileSystem {
  /**
   * Open `file` with an exclusive handle, creating the slot files and the log
   * on demand. Resolves `null` only when `index.bin` (the legacy probe) does
   * not exist.
   */
  open(file: StoreFile): Promise<SlotFile | null>;
  /** Best-effort delete (the legacy `index.bin` after migration). */
  remove(file: string): Promise<void>;
}

/** Options for {@link SlotStore.open}. */
export interface SlotStoreOptions extends WalOptions {
  /** Store name, used only in error messages. */
  name?: string;
}

/** Read a file's full contents (looping in case a read returns short). */
function readAll(file: SlotFile): Uint8Array {
  const size = file.getSize();
  const buf = new Uint8Array(size);
  let off = 0;
  while (off < size) {
    const n = file.read(buf.subarray(off), { at: off });
    if (n <= 0) break;
    off += n;
  }
  return off === size ? buf : buf.subarray(0, off);
}

function closeQuietly(file: SlotFile | null | undefined): void {
  try {
    file?.close();
  } catch {
    /* best-effort */
  }
}

/** One slot's state at open time. */
type SlotProbe =
  | { file: SlotName; empty: true }
  | { file: SlotName; empty: false; ok: true; decoded: DecodedSnapshot }
  | { file: SlotName; empty: false; ok: false; reason: string };

/** Which snapshot open resolved to (before the log is considered). */
interface SnapshotResolution {
  current: SlotName | null;
  initialSnapshot: DecodedSnapshot | null;
  nextSequence: bigint;
  migrateFromLegacy: boolean;
}

/** What open learned from `wal.bin`. */
interface WalResolution {
  initialReplay: WalRecord[];
  /** Byte length of the valid log on disk (`0` = no header; written lazily). */
  walEnd: number;
  walDims: number | null;
}

/** The validated state {@link SlotStore.open} hands the constructor. */
interface SlotStoreInit extends SnapshotResolution, WalResolution {
  handles: Record<SlotName, SlotFile>;
  wal: SlotFile;
}

/**
 * The A/B slot store with its write-ahead log. Construct via
 * {@link SlotStore.open}, which reads and validates both slots (and the legacy
 * file) and the log before any write can happen.
 */
export class SlotStore implements PersistentStore {
  readonly persistent = true;
  readonly initialSnapshot: DecodedSnapshot | null;
  readonly initialReplay: WalRecord[];
  readonly walDims: number | null;

  readonly #fs: SlotFileSystem;
  readonly #handles: Record<SlotName, SlotFile>;
  readonly #wal: SlotFile;
  readonly #durability: Durability;
  readonly #checkpointBytes: number;
  readonly #checkpointRecords: number;
  readonly #relaxedFlushMs: number;
  /** Slot holding the newest committed snapshot (`null` = none / legacy). */
  #current: SlotName | null;
  #target: SlotName;
  #nextSequence: bigint;
  #onDiskCount: number;
  #migrateFromLegacy: boolean;
  #pendingRemoval: Promise<void> | null = null;
  #removesSinceOpen: number;
  #source: (() => SnapshotSource) | null = null;
  /** Index dims supplied at bind time (for a log header before any insert). */
  #bindDims: number | null = null;
  /** End of the valid log on disk; `0` means no header yet (written lazily). */
  #walEnd: number;
  /** Dims of the log header on disk (`null` until one is read or written). */
  #headerDims: number | null;
  /** Records in the log since the last checkpoint (replayed ones included). */
  #walRecords: number;
  /** Relaxed mode: bytes written to the log but not yet flushed. */
  #walUnflushed = false;
  #flushTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Strict mode: a threshold checkpoint scheduled to run after the tripping
   * append has been acknowledged (at most one pending).
   */
  #checkpointTimer: ReturnType<typeof setTimeout> | null = null;
  #closed = false;

  private constructor(fs: SlotFileSystem, opts: SlotStoreOptions, init: SlotStoreInit) {
    this.#fs = fs;
    this.#handles = init.handles;
    this.#wal = init.wal;
    this.#durability = opts.durability ?? 'strict';
    this.#checkpointBytes = opts.checkpointBytes ?? DEFAULT_CHECKPOINT_BYTES;
    this.#checkpointRecords = opts.checkpointRecords ?? DEFAULT_CHECKPOINT_RECORDS;
    this.#relaxedFlushMs = opts.relaxedFlushMs ?? DEFAULT_RELAXED_FLUSH_MS;
    this.#current = init.current;
    this.#target = init.current === 'slot-a.bin' ? 'slot-b.bin' : 'slot-a.bin';
    this.#nextSequence = init.nextSequence;
    this.#migrateFromLegacy = init.migrateFromLegacy;
    this.initialSnapshot = init.initialSnapshot;
    this.initialReplay = init.initialReplay;
    this.walDims = init.walDims;
    this.#walEnd = init.walEnd;
    this.#headerDims = init.walDims;
    this.#walRecords = init.initialReplay.length;
    // Replayed removes are removes since the last checkpoint: without counting
    // them, a log that legitimately empties the index would trip the
    // empty-overwrite guard on every checkpoint.
    this.#removesSinceOpen = init.initialReplay.filter((r) => r.kind === 'remove').length;
    // An FVS2 snapshot records its live count. A legacy FVS1 file written by the
    // Engine carries one sidecar text per live item, so the sidecar size is the
    // live count; only a raw core without a sidecar (the persister cannot run
    // wasm to count it) stays unknown (-1).
    const snap = init.initialSnapshot;
    this.#onDiskCount = snap
      ? (snap.meta?.count ?? (snap.texts.size > 0 ? snap.texts.size : -1))
      : 0;
  }

  /**
   * Open both slots, decode each, and pick the valid one with the highest
   * sequence (falling back to the legacy `index.bin`, see
   * {@link resolveSnapshot}); then open the log and decide, from its
   * `baseSequence`, whether to replay it, discard it, or refuse to open (see the
   * module header). Any handle opened here is closed again if open fails.
   */
  static async open(fs: SlotFileSystem, opts: SlotStoreOptions = {}): Promise<SlotStore> {
    const storeName = opts.name ?? '';
    const opened: SlotFile[] = [];
    try {
      const a = await fs.open('slot-a.bin');
      if (a) opened.push(a);
      const b = await fs.open('slot-b.bin');
      if (b) opened.push(b);
      if (!a || !b) throw new Error('[ferrovec] slot file could not be opened');
      const handles: Record<SlotName, SlotFile> = { 'slot-a.bin': a, 'slot-b.bin': b };

      const snapshot = await resolveSnapshot(fs, handles, storeName);

      const wal = await fs.open('wal.bin');
      if (!wal) throw new Error('[ferrovec] wal.bin could not be opened');
      opened.push(wal);
      const log = resolveWal(wal, snapshot, storeName);

      return new SlotStore(fs, opts, { handles, wal, ...snapshot, ...log });
    } catch (err) {
      for (const h of opened) closeQuietly(h);
      throw err;
    }
  }

  /** The sequence the next checkpoint will carry. */
  get nextSequence(): bigint {
    return this.#nextSequence;
  }

  /** Live items in the newest committed snapshot (`-1` = unknown: legacy raw core, no sidecar). */
  get onDiskCount(): number {
    return this.#onDiskCount;
  }

  bind(source: () => SnapshotSource, options: { dims?: number } = {}): void {
    this.#source = source;
    this.#bindDims = options.dims ?? null;
  }

  async append(record: WalRecord): Promise<void> {
    if (this.#closed) throw new Error('[ferrovec] store is closed');
    if (this.#walEnd === 0) {
      // Fresh (or just-discarded) log: write its header first, based on the
      // newest committed snapshot.
      const dims = record.kind === 'insert' ? record.vector.length : (this.#bindDims ?? this.#headerDims);
      this.#writeWalHeader(this.#nextSequence - 1n, dims);
    }
    const bytes = encodeWalRecord(record, this.#headerDims!);
    this.#writeWalAt(bytes, this.#walEnd);
    this.#walEnd += bytes.length;
    this.#walRecords++;
    if (record.kind === 'remove') this.#removesSinceOpen++;

    if (this.#durability === 'strict') {
      // The acknowledgement: the record is flushed before this resolves.
      this.#wal.flush();
      this.#walUnflushed = false;
      // The record is already durable, so the checkpoint need not delay this
      // acknowledgement: run it on a later macrotask instead.
      if (this.#checkpointDue()) this.#scheduleCheckpoint();
    } else {
      this.#walUnflushed = true;
      this.#armRelaxedFlush();
    }
  }

  async flush(): Promise<void> {
    this.#clearRelaxedFlush();
    this.#clearScheduledCheckpoint();
    this.#flushWal();
    if (this.#walRecords > 0) this.#checkpoint();
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#clearRelaxedFlush();
    this.#clearScheduledCheckpoint();
    try {
      this.#flushWal();
      // Only a log with records needs folding into a snapshot: closing an
      // untouched store writes nothing.
      if (this.#walRecords > 0) this.#checkpoint();
    } finally {
      // Releases the exclusive locks so another tab can take over — even when
      // the final checkpoint threw (the error is rethrown after this block).
      closeQuietly(this.#handles['slot-a.bin']);
      closeQuietly(this.#handles['slot-b.bin']);
      closeQuietly(this.#wal);
    }
    if (this.#pendingRemoval) await this.#pendingRemoval;
  }

  #checkpointDue(): boolean {
    return this.#walEnd >= this.#checkpointBytes || this.#walRecords >= this.#checkpointRecords;
  }

  /**
   * A threshold-triggered checkpoint has no caller to reject: the mutation that
   * tripped it is already durable in the log, so its acknowledgement must not
   * fail. The log keeps growing; the next append (or flush/close, which do
   * surface the error) retries.
   */
  #backgroundCheckpoint(): void {
    try {
      this.#checkpoint();
    } catch (err) {
      console.error(
        '[ferrovec] background checkpoint failed; the write-ahead log still holds every ' +
          'acknowledged mutation:',
        err,
      );
    }
  }

  /** Strict mode: run a threshold checkpoint after the current acknowledgement. */
  #scheduleCheckpoint(): void {
    if (this.#checkpointTimer !== null) return;
    this.#checkpointTimer = setTimeout(() => {
      this.#checkpointTimer = null;
      if (this.#closed) return;
      if (this.#checkpointDue()) this.#backgroundCheckpoint();
    }, 0);
  }

  #clearScheduledCheckpoint(): void {
    if (this.#checkpointTimer !== null) {
      clearTimeout(this.#checkpointTimer);
      this.#checkpointTimer = null;
    }
  }

  #armRelaxedFlush(): void {
    if (this.#flushTimer !== null) return;
    this.#flushTimer = setTimeout(() => {
      this.#flushTimer = null;
      if (this.#closed) return;
      try {
        this.#flushWal();
      } catch (err) {
        console.error('[ferrovec] write-ahead log flush failed:', err);
        return;
      }
      if (this.#checkpointDue()) this.#backgroundCheckpoint();
    }, this.#relaxedFlushMs);
  }

  #clearRelaxedFlush(): void {
    if (this.#flushTimer !== null) {
      clearTimeout(this.#flushTimer);
      this.#flushTimer = null;
    }
  }

  #flushWal(): void {
    if (!this.#walUnflushed) return;
    this.#wal.flush();
    this.#walUnflushed = false;
  }

  /** Replace the log with a bare header (`truncate(0)` + write). Does not flush. */
  #writeWalHeader(baseSequence: bigint, dims: number | null): void {
    if (!dims) {
      throw new Error('[ferrovec] cannot start the write-ahead log: the index dims are unknown');
    }
    this.#wal.truncate(0);
    this.#walEnd = 0;
    this.#writeWalAt(encodeWalHeader({ baseSequence, dims }), 0);
    this.#walEnd = WAL_HEADER_LEN;
    this.#headerDims = dims;
    this.#walRecords = 0;
  }

  /** Write `bytes` at `at`; on failure cut the file back to the last good end. */
  #writeWalAt(bytes: Uint8Array, at: number): void {
    try {
      const written = this.#wal.write(bytes, { at });
      if (written !== bytes.length) {
        throw new Error(`[ferrovec] short write to wal.bin: ${written}/${bytes.length} bytes`);
      }
    } catch (err) {
      try {
        this.#wal.truncate(this.#walEnd);
      } catch {
        /* best-effort: a torn tail is cut off on the next open anyway */
      }
      throw err;
    }
  }

  /**
   * (a) Write a full snapshot to the target slot and flush it; (b) only then
   * reset the log to a header based on the new sequence. Synchronous by design.
   * See the module header for why this order makes every crash point safe.
   */
  #checkpoint(): void {
    if (this.#source === null) return;
    // Everything the snapshot will contain must be durable in the log first: if
    // (a) is torn, open falls back to the older slot and replays this log.
    this.#flushWal();
    const { core, texts, meta } = this.#source();

    if (meta.count === 0 && this.#onDiskCount > 0 && this.#removesSinceOpen === 0) {
      throw new EmptyOverwriteRefusedError(this.#onDiskCount);
    }

    // (a) the snapshot.
    const sequence = this.#nextSequence;
    const bytes = encodeSnapshot(core, texts, { sequence, meta });
    const target = this.#handles[this.#target];
    const written = target.write(bytes, { at: 0 });
    if (written !== bytes.length) {
      throw new Error(`[ferrovec] short write to ${this.#target}: ${written}/${bytes.length} bytes`);
    }
    target.truncate(bytes.length);
    target.flush();

    // Committed: only now does the target become current. A throw anywhere
    // above leaves #current (the other slot) and the log untouched.
    this.#current = this.#target;
    this.#target = this.#current === 'slot-a.bin' ? 'slot-b.bin' : 'slot-a.bin';
    this.#onDiskCount = meta.count;
    this.#nextSequence++;

    // (b) the log reset. Every logged record is now in the snapshot. Mark the
    // log header-less first, so that if the reset fails part-way the next
    // append rewrites a header based on `sequence` rather than appending to the
    // stale log (which open would discard as B < S).
    this.#walEnd = 0;
    this.#walRecords = 0;
    this.#writeWalHeader(sequence, meta.embeddingSpace.dims);
    this.#wal.flush();
    this.#walUnflushed = false;

    if (this.#migrateFromLegacy) {
      this.#migrateFromLegacy = false;
      this.#pendingRemoval = this.#fs.remove('index.bin').catch((err: unknown) => {
        console.warn('[ferrovec] could not remove migrated legacy index.bin:', err);
      });
    }
  }
}

/**
 * Pick the snapshot to load: the valid slot with the highest sequence; else,
 * when both slots are empty (or exactly one is torn and the other empty — an
 * interrupted first migration), the legacy `index.bin`. Throws
 * {@link StoreCorruptError} rather than starting empty over undecodable data.
 */
async function resolveSnapshot(
  fs: SlotFileSystem,
  handles: Record<SlotName, SlotFile>,
  storeName: string,
): Promise<SnapshotResolution> {
  const probes = (['slot-a.bin', 'slot-b.bin'] as const).map((file): SlotProbe => {
    const handle = handles[file];
    if (handle.getSize() === 0) return { file, empty: true };
    return probeSlot(file, readAll(handle));
  });

  let best: { file: SlotName; decoded: DecodedSnapshot } | null = null;
  for (const p of probes) {
    if (!p.empty && p.ok && (best === null || p.decoded.sequence > best.decoded.sequence)) {
      best = { file: p.file, decoded: p.decoded };
    }
  }

  if (best) {
    return {
      current: best.file,
      initialSnapshot: best.decoded,
      nextSequence: best.decoded.sequence + 1n,
      migrateFromLegacy: false,
    };
  }

  // No valid slot. (Every non-empty probe is invalid here.)
  const slotReasons = probes.map((p) => ({
    file: p.file,
    reason: p.empty ? 'empty' : p.ok ? 'ok' : p.reason,
  }));
  const nonEmpty = probes.filter((p) => !p.empty).length;
  if (nonEmpty === 2) throw new StoreCorruptError(storeName, slotReasons);

  if (nonEmpty === 1) {
    // One torn slot, the other empty: exactly "the first commit was torn".
    // If that commit was migrating a legacy index.bin, the legacy file is
    // still intact (it is removed only after a successful commit), so
    // migrate from it again; the torn slot is overwritten or superseded by
    // the next commit. A fresh store whose first commit was torn has no
    // legacy file and stays an explicit error.
    let legacy: DecodedSnapshot | null;
    try {
      legacy = await readLegacy(fs, storeName);
    } catch (err) {
      if (err instanceof StoreCorruptError) {
        throw new StoreCorruptError(storeName, [...slotReasons, ...err.slots]);
      }
      throw err;
    }
    if (!legacy) throw new StoreCorruptError(storeName, slotReasons);
    const torn = slotReasons.find((s) => s.reason !== 'empty');
    console.warn(
      `[ferrovec] store "${storeName}": found a torn ${torn?.file} (${torn?.reason}) ` +
        `and no other snapshot; the first migration commit was interrupted, so ` +
        `the intact legacy index.bin is being used instead`,
    );
    return { current: null, initialSnapshot: legacy, nextSequence: 1n, migrateFromLegacy: true };
  }

  // Both slots empty: a fresh store, or a pre-slot store to migrate.
  const legacy = await readLegacy(fs, storeName);
  return { current: null, initialSnapshot: legacy, nextSequence: 1n, migrateFromLegacy: legacy !== null };
}

/** Truncate the log to nothing (its header is rewritten lazily on the next append). */
function resetWal(wal: SlotFile): void {
  wal.truncate(0);
  wal.flush();
}

/**
 * Decide what the log means relative to the chosen snapshot (`S` = its
 * sequence, `0n` for none / legacy; `B` = the log's `baseSequence`): replay
 * (`B === S`), discard (`B < S`), or refuse (`B > S`). A torn tail is cut off.
 */
function resolveWal(wal: SlotFile, snapshot: SnapshotResolution, storeName: string): WalResolution {
  const empty: WalResolution = { initialReplay: [], walEnd: 0, walDims: null };
  // A log shorter than its header never got a complete header: nothing was
  // ever logged into it. The next append rewrites it from scratch.
  if (wal.getSize() < WAL_HEADER_LEN) return empty;

  const bytes = readAll(wal);
  let header: { baseSequence: bigint; dims: number };
  try {
    header = decodeWalHeader(bytes);
  } catch (err) {
    if (!(err instanceof WalCorruptError)) throw err;
    if (snapshot.initialSnapshot === null) {
      throw new StoreCorruptError(storeName, [{ file: 'wal.bin', reason: 'bad-header' }]);
    }
    console.warn(
      `[ferrovec] store "${storeName}": wal.bin has an unreadable header (${err.message}); ` +
        `its contents are unknowable, so it is discarded and the last checkpoint is used`,
    );
    resetWal(wal);
    return empty;
  }

  const snapshotDims = snapshot.initialSnapshot?.meta?.embeddingSpace.dims;
  if (snapshotDims !== undefined && header.dims !== snapshotDims) {
    throw new StoreCorruptError(storeName, [{ file: 'wal.bin', reason: 'dims-mismatch' }]);
  }

  const S = snapshot.nextSequence - 1n;
  const B = header.baseSequence;
  if (B < S) {
    // Crash between a checkpoint's commit and its log reset: every record here
    // is already in snapshot S. Replaying would double-apply; discard.
    resetWal(wal);
    return empty;
  }
  if (B > S) {
    throw new StoreCorruptError(storeName, [{ file: 'wal.bin', reason: 'wal-ahead-of-snapshot' }]);
  }

  const scan = scanWal(bytes, header.dims);
  if (scan.truncatedTail) {
    wal.truncate(scan.validLength);
    wal.flush();
    console.warn(
      `[ferrovec] store "${storeName}": wal.bin had a torn tail (${bytes.length - scan.validLength} ` +
        `bytes after record ${scan.records.length}); it was cut off — a write interrupted ` +
        `mid-append, never applied`,
    );
  }
  return { initialReplay: scan.records, walEnd: scan.validLength, walDims: header.dims };
}

/** Decode one non-empty slot. Slots are only ever written as FVS2. */
function probeSlot(file: SlotName, bytes: Uint8Array): SlotProbe {
  try {
    const decoded = decodeSnapshot(bytes);
    if (decoded.formatVersion !== 2) {
      return { file, empty: false, ok: false, reason: 'not-fvs2' };
    }
    return { file, empty: false, ok: true, decoded };
  } catch (err) {
    if (err instanceof SnapshotCorruptError) return { file, empty: false, ok: false, reason: err.reason };
    throw err;
  }
}

/** Read + decode the pre-slot `index.bin`, or `null` if absent/empty. */
async function readLegacy(fs: SlotFileSystem, storeName: string): Promise<DecodedSnapshot | null> {
  const legacy = await fs.open('index.bin');
  if (!legacy) return null;
  let bytes: Uint8Array;
  try {
    bytes = readAll(legacy);
  } finally {
    closeQuietly(legacy);
  }
  if (bytes.length === 0) return null;
  try {
    return decodeSnapshot(bytes);
  } catch (err) {
    if (err instanceof SnapshotCorruptError) {
      throw new StoreCorruptError(storeName, [{ file: 'index.bin', reason: err.reason }]);
    }
    throw err;
  }
}

interface FileHandleWithSync {
  createSyncAccessHandle(): Promise<SlotFile>;
}

/** Feature-detect worker-side OPFS synchronous access. */
function syncAccessAvailable(): boolean {
  try {
    return (
      typeof navigator !== 'undefined' &&
      navigator.storage != null &&
      typeof navigator.storage.getDirectory === 'function' &&
      typeof FileSystemFileHandle !== 'undefined' &&
      typeof (FileSystemFileHandle.prototype as unknown as FileHandleWithSync)
        .createSyncAccessHandle === 'function'
    );
  } catch {
    return false;
  }
}

/** Reduce an arbitrary store name to a single safe OPFS path segment. */
export function sanitizeName(name: string): string {
  const safe = name.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^\.+/, '_');
  return safe.length > 0 ? safe : '_';
}

/** The OPFS directory `ferrovec/<sanitized name>` as a {@link SlotFileSystem}. */
async function opfsSlotFileSystem(name: string): Promise<SlotFileSystem> {
  const root = await navigator.storage.getDirectory();
  const base = await root.getDirectoryHandle('ferrovec', { create: true });
  const dir = await base.getDirectoryHandle(sanitizeName(name), { create: true });
  return {
    async open(file: StoreFile): Promise<SlotFile | null> {
      let fileHandle: FileSystemFileHandle;
      try {
        // Never create the legacy file: it is only probed for migration. The
        // slots and the log are created on demand.
        fileHandle = await dir.getFileHandle(file, { create: file !== 'index.bin' });
      } catch (err) {
        if (file === 'index.bin' && (err as { name?: string })?.name === 'NotFoundError') return null;
        throw err;
      }
      // Throws if another tab holds this file's exclusive lock.
      return (fileHandle as unknown as FileHandleWithSync).createSyncAccessHandle();
    },
    async remove(file: string): Promise<void> {
      await dir.removeEntry(file);
    },
  };
}

/** A no-op store: feature unavailable, disabled, or lock contended. */
function inMemoryStore(): PersistentStore {
  return {
    persistent: false,
    initialSnapshot: null,
    initialReplay: [],
    walDims: null,
    onDiskCount: 0,
    bind() {},
    async append() {},
    async flush() {},
    async close() {},
  };
}

/**
 * Open (or create) the persistent store named `name`.
 *
 * Falls back to a non-persistent in-memory store — never throwing — when
 * persistence is disabled, OPFS sync access is unavailable (Node, insecure
 * context, unsupported browser), or the exclusive locks are held by another tab
 * (unless `requireLock`). A {@link StoreCorruptError} is never retried nor
 * degraded to memory: the data is on disk and must not be silently hidden.
 */
export async function openStore(name: string, options: OpenStoreOptions = {}): Promise<PersistentStore> {
  const persist = options.persist ?? true;
  const retryDelayMs = options.retryDelayMs ?? 50;
  const requireLock = options.requireLock ?? false;
  // A lock-holding caller is the legitimate owner of the slots; give it a long
  // deadline and never degrade to memory (see requireLock). Ordinary opens keep
  // their caller-supplied (small / zero) budget and the in-memory fallback.
  const contentionRetries = requireLock
    ? Math.max(options.contentionRetries ?? 0, LOCKED_CONTENTION_RETRIES)
    : (options.contentionRetries ?? 0);

  if (!persist || !syncAccessAvailable()) {
    return inMemoryStore();
  }

  for (let attempt = 0; ; attempt++) {
    try {
      const fs = await opfsSlotFileSystem(name);
      // Throws if another tab holds a slot's exclusive lock — retried/caught below.
      return await SlotStore.open(fs, {
        name,
        durability: options.durability,
        checkpointBytes: options.checkpointBytes,
        checkpointRecords: options.checkpointRecords,
        relaxedFlushMs: options.relaxedFlushMs,
      });
    } catch (err) {
      if (err instanceof StoreCorruptError) throw err;
      // Contention during a failover handoff is transient — retry briefly.
      if (attempt < contentionRetries) {
        await new Promise<void>((resolve) => setTimeout(resolve, retryDelayMs));
        continue;
      }
      if (requireLock) {
        // We hold the leader Web Lock: refuse to masquerade an intact on-disk
        // index as an empty in-memory one. Fail loudly so promotion can react
        // (re-queue) rather than silently serving size()===0 over real data.
        throw new Error(
          `[ferrovec] OPFS store files for "${name}" are still locked after ` +
            `${contentionRetries} retries while this tab holds the leader lock; ` +
            `refusing to fall back to in-memory (would lose the on-disk index)`,
          { cause: err },
        );
      }
      console.warn(
        `[ferrovec] OPFS persistence unavailable for "${name}" ` +
          `(likely held by another tab); falling back to in-memory:`,
        err,
      );
      return inMemoryStore();
    }
  }
}

/**
 * Delete the whole OPFS directory of store `name` (`ferrovec/<sanitized>`).
 * Resolves when the directory does not exist or OPFS is unavailable. If another
 * tab still holds one of its files open, the browser's error propagates.
 */
export async function destroyStore(name: string): Promise<void> {
  if (typeof navigator === 'undefined' || typeof navigator.storage?.getDirectory !== 'function') {
    return;
  }
  const root = await navigator.storage.getDirectory();
  let base: FileSystemDirectoryHandle;
  try {
    base = await root.getDirectoryHandle('ferrovec');
  } catch (err) {
    if ((err as { name?: string })?.name === 'NotFoundError') return;
    throw err;
  }
  try {
    await base.removeEntry(sanitizeName(name), { recursive: true });
  } catch (err) {
    if ((err as { name?: string })?.name === 'NotFoundError') return;
    throw new Error(
      `[ferrovec] could not destroy store "${name}"; it is probably still open in ` +
        `another tab (close it there first): ${(err as Error)?.message ?? String(err)}`,
      { cause: err },
    );
  }
}
