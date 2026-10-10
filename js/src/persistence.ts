/**
 * OPFS persistence for the dedicated worker: an A/B-buffered snapshot store.
 *
 * A {@link PersistentStore} owns two slot files, `ferrovec/<name>/slot-a.bin`
 * and `slot-b.bin`, in the Origin Private File System, each accessed through a
 * synchronous access handle held for the lifetime of the store. Sync handles
 * are **worker-only** and **secure-context-only**, which is why the OPFS adapter
 * here is used exclusively from the worker and never from the main thread.
 *
 * ## Why two slots
 *
 * Every commit writes a complete, checksummed FVS2 snapshot (see
 * `snapshot.ts`) carrying a monotonically increasing `sequence`, and it always
 * writes to the slot that does **not** hold the current committed version. On
 * open, both slots are decoded and the valid one with the highest sequence
 * wins. A torn write (tab killed mid-`write`, partial truncate) can therefore
 * only ever damage the *target* slot; the previous commit in the other slot is
 * never touched and is recovered on the next open. The torn slot is simply the
 * target of the next commit, which overwrites it.
 *
 * **Durability scope.** OPFS `flush()` guarantees content consistency for other
 * readers of the file; it is **not** an `fsync`. The guarantee is "survives a
 * tab kill / crash and reload", not "survives power loss or an OS crash".
 *
 * ## Commit strategy: full snapshot, debounced
 *
 * Every mutation marks the store dirty and (re)arms a short debounce timer; when
 * it fires we ask the bound producer for `{ core, texts, meta }`, encode it with
 * the next sequence, and do one `write(at:0)` → `truncate` → `flush` on the
 * target slot. Only after `flush` returns is the commit considered current.
 * {@link PersistentStore.close} always performs a final synchronous commit
 * before releasing the handles.
 *
 * ## Safety rails
 *
 * - If slots exist but none decodes, open throws `StoreCorruptError` — it never
 *   silently starts empty over corrupt data. The one exception is a single torn
 *   slot next to an empty one with an intact legacy `index.bin` (an interrupted
 *   first migration commit): the legacy file is migrated again.
 * - A commit that would replace a non-empty on-disk index with an empty one,
 *   when nothing was removed since open, throws `EmptyOverwriteRefusedError` and
 *   writes nothing (the signature of a failed rehydrate, not of intent).
 * - A pre-slot store (`index.bin`, FVS1 / raw core) is read once as a migration
 *   source; after the first successful slot commit it is deleted best-effort.
 *
 * The slot logic ({@link SlotStore}) runs against the tiny {@link SlotFileSystem}
 * abstraction so it is unit-testable under Node with an in-memory fake;
 * {@link openStore} supplies the OPFS-backed implementation.
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
} from './errors.ts';
import {
  decodeSnapshot,
  encodeSnapshot,
  type DecodedSnapshot,
  type SnapshotSource,
} from './snapshot.ts';
import type { Persister } from './types.ts';

export type { SnapshotSource } from './snapshot.ts';

/** Options controlling how a store is opened. */
export interface OpenStoreOptions {
  /** Opt out of persistence entirely (pure in-memory). Defaults to `true`. */
  persist?: boolean;
  /** Debounce window for snapshot writes, in ms. Defaults to `250`. */
  debounceMs?: number;
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
   * owner of the slot files. On sync-handle contention it must **never**
   * silently fall back to in-memory: doing so would present an intact on-disk
   * index as empty and accept writes that are discarded on reload while the
   * slots sit untouched. Instead retry for a much longer deadline
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
 * mutation-facing surface) with the load-time snapshot, the persistence mode,
 * and a `bind` hook the coordinator uses to supply the snapshot source once the
 * engine (and thus the core) exists.
 */
export interface PersistentStore extends Persister {
  /** Whether writes actually reach disk. `false` = degraded/in-memory. */
  readonly persistent: boolean;
  /** The committed snapshot found at open time, or `null` when starting empty. */
  readonly initialSnapshot: DecodedSnapshot | null;
  /** Live items in the on-disk index; `-1` when unknown (a legacy raw core with no text sidecar). */
  readonly onDiskCount: number;
  /** Supply the function that produces the snapshot contents on demand. */
  bind(source: () => SnapshotSource): void;
}

/** The files a store may touch inside its directory. */
export type StoreFile = 'slot-a.bin' | 'slot-b.bin' | 'index.bin';
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
   * Open `file` with an exclusive handle, creating the slot files on demand.
   * Resolves `null` only when `index.bin` (the legacy probe) does not exist.
   */
  open(file: StoreFile): Promise<SlotFile | null>;
  /** Best-effort delete (the legacy `index.bin` after migration). */
  remove(file: string): Promise<void>;
}

/** Options for {@link SlotStore.open}. */
export interface SlotStoreOptions {
  /** Debounce window for snapshot writes, in ms. */
  debounceMs: number;
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

/** The validated state {@link SlotStore.open} hands the constructor. */
interface SlotStoreInit {
  handles: Record<SlotName, SlotFile>;
  current: SlotName | null;
  initialSnapshot: DecodedSnapshot | null;
  nextSequence: bigint;
  migrateFromLegacy: boolean;
}

/**
 * The A/B slot store. Construct via {@link SlotStore.open}, which reads and
 * validates both slots (and the legacy file) before any commit can happen.
 */
export class SlotStore implements PersistentStore {
  readonly persistent = true;
  readonly initialSnapshot: DecodedSnapshot | null;

  readonly #fs: SlotFileSystem;
  readonly #debounceMs: number;
  readonly #handles: Record<SlotName, SlotFile>;
  /** Slot holding the newest committed snapshot (`null` = none / legacy). */
  #current: SlotName | null;
  #target: SlotName;
  #nextSequence: bigint;
  #onDiskCount: number;
  #migrateFromLegacy: boolean;
  #pendingRemoval: Promise<void> | null = null;
  #removesSinceOpen = 0;
  #source: (() => SnapshotSource) | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #dirty = false;
  #closed = false;

  private constructor(fs: SlotFileSystem, opts: SlotStoreOptions, init: SlotStoreInit) {
    this.#fs = fs;
    this.#debounceMs = opts.debounceMs;
    this.#handles = init.handles;
    this.#current = init.current;
    this.#target = init.current === 'slot-a.bin' ? 'slot-b.bin' : 'slot-a.bin';
    this.#nextSequence = init.nextSequence;
    this.#migrateFromLegacy = init.migrateFromLegacy;
    this.initialSnapshot = init.initialSnapshot;
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
   * sequence. Falls back to the legacy `index.bin` when both slots are empty,
   * or when exactly one slot is non-empty-but-invalid and the other empty (the
   * very first migration commit was torn). Throws {@link StoreCorruptError}
   * rather than starting empty over undecodable data. Any handle opened here is
   * closed again if open fails.
   */
  static async open(fs: SlotFileSystem, opts: SlotStoreOptions): Promise<SlotStore> {
    const storeName = opts.name ?? '';
    const opened: SlotFile[] = [];
    try {
      const a = await fs.open('slot-a.bin');
      if (a) opened.push(a);
      const b = await fs.open('slot-b.bin');
      if (b) opened.push(b);
      if (!a || !b) throw new Error('[ferrovec] slot file could not be opened');
      const handles: Record<SlotName, SlotFile> = { 'slot-a.bin': a, 'slot-b.bin': b };

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
        return new SlotStore(fs, opts, {
          handles,
          current: best.file,
          initialSnapshot: best.decoded,
          nextSequence: best.decoded.sequence + 1n,
          migrateFromLegacy: false,
        });
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
        return new SlotStore(fs, opts, {
          handles,
          current: null,
          initialSnapshot: legacy,
          nextSequence: 1n,
          migrateFromLegacy: true,
        });
      }

      // Both slots empty: a fresh store, or a pre-slot store to migrate.
      const legacy = await readLegacy(fs, storeName);
      return new SlotStore(fs, opts, {
        handles,
        current: null,
        initialSnapshot: legacy,
        nextSequence: 1n,
        migrateFromLegacy: legacy !== null,
      });
    } catch (err) {
      for (const h of opened) closeQuietly(h);
      throw err;
    }
  }

  /** The sequence the next commit will carry. */
  get nextSequence(): bigint {
    return this.#nextSequence;
  }

  /** Live items in the newest committed snapshot (`-1` = unknown: legacy raw core, no sidecar). */
  get onDiskCount(): number {
    return this.#onDiskCount;
  }

  bind(source: () => SnapshotSource): void {
    this.#source = source;
  }

  markDirty(kind?: 'insert' | 'remove'): void {
    if (this.#closed) return;
    if (kind === 'remove') this.#removesSinceOpen++;
    this.#dirty = true;
    if (this.#timer === null) {
      this.#timer = setTimeout(() => {
        this.#timer = null;
        try {
          this.#writeNow();
        } catch (err) {
          // A background commit has no caller to reject. The store stays dirty,
          // so the next flush()/close() retries and surfaces the error there.
          console.error('[ferrovec] background snapshot commit failed:', err);
        }
      }, this.#debounceMs);
    }
  }

  async flush(): Promise<void> {
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    this.#writeNow();
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    try {
      this.#writeNow();
    } finally {
      // Releases the exclusive locks so another tab can take over — even when
      // the final commit threw (the error is rethrown after this block).
      closeQuietly(this.#handles['slot-a.bin']);
      closeQuietly(this.#handles['slot-b.bin']);
    }
    if (this.#pendingRemoval) await this.#pendingRemoval;
  }

  /** Encode and commit the current index to the target slot if dirty. Synchronous by design. */
  #writeNow(): void {
    if (!this.#dirty || this.#source === null) return;
    const { core, texts, meta } = this.#source();

    if (meta.count === 0 && this.#onDiskCount > 0 && this.#removesSinceOpen === 0) {
      throw new EmptyOverwriteRefusedError(this.#onDiskCount);
    }

    const bytes = encodeSnapshot(core, texts, { sequence: this.#nextSequence, meta });
    const target = this.#handles[this.#target];
    const written = target.write(bytes, { at: 0 });
    if (written !== bytes.length) {
      throw new Error(`[ferrovec] short write to ${this.#target}: ${written}/${bytes.length} bytes`);
    }
    target.truncate(bytes.length);
    target.flush();

    // Committed: only now does the target become current. A throw anywhere
    // above leaves #current (the other slot) untouched and the store dirty.
    this.#current = this.#target;
    this.#target = this.#current === 'slot-a.bin' ? 'slot-b.bin' : 'slot-a.bin';
    this.#onDiskCount = meta.count;
    this.#nextSequence++;
    this.#dirty = false;

    if (this.#migrateFromLegacy) {
      this.#migrateFromLegacy = false;
      this.#pendingRemoval = this.#fs.remove('index.bin').catch((err: unknown) => {
        console.warn('[ferrovec] could not remove migrated legacy index.bin:', err);
      });
    }
  }
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
        // Never create the legacy file: it is only probed for migration.
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
    onDiskCount: 0,
    bind() {},
    markDirty() {},
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
  const debounceMs = options.debounceMs ?? 250;
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
      return await SlotStore.open(fs, { debounceMs, name });
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
          `[ferrovec] OPFS slot files for "${name}" are still locked after ` +
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
