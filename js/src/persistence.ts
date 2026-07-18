/**
 * OPFS persistence for the dedicated worker.
 *
 * A {@link PersistentStore} owns one `ferrovec/<name>/index.bin` file in the
 * Origin Private File System, accessed through a synchronous access handle. That
 * handle is **worker-only** and **secure-context-only**, which is why this
 * module is used exclusively from `worker.ts` and never from the main thread.
 *
 * Persistence strategy: **full snapshot, debounced.** Every mutation marks the
 * store dirty and (re)arms a short debounce timer; when it fires we serialize
 * the whole index ({@link snapshot}) and do one `write(at:0)` → `truncate` →
 * `flush`. Snapshots (rather than an append-only log) keep the format trivial
 * and self-healing, and the index is small enough that re-serialization is
 * cheap relative to the debounce window. {@link PersistentStore.close} always
 * performs a final synchronous flush before releasing the exclusive lock.
 *
 * The sync access handle holds an **exclusive lock** on the file. If another tab
 * already holds it, `createSyncAccessHandle()` throws — we catch that, warn, and
 * transparently degrade to a non-persistent in-memory store. (Cross-tab leader
 * election is M6.)
 */

import type { Persister } from './types.ts';

/** Options controlling how a store is opened. */
export interface OpenStoreOptions {
  /** Opt out of persistence entirely (pure in-memory). Defaults to `true`. */
  persist?: boolean;
  /** Debounce window for snapshot writes, in ms. Defaults to `250`. */
  debounceMs?: number;
}

/**
 * A store the {@link Engine} can persist into. Extends {@link Persister} (the
 * mutation-facing surface) with the load-time bytes, the persistence mode, and
 * a `bind` hook the worker uses to supply the snapshot source once the engine
 * (and thus the core) exists.
 */
export interface PersistentStore extends Persister {
  /** Whether writes actually reach disk. `false` = degraded/in-memory. */
  readonly persistent: boolean;
  /** Bytes read from `index.bin` at open time, or `null` when starting empty. */
  readonly initialBytes: Uint8Array | null;
  /** Supply the function that produces a full snapshot blob on demand. */
  bind(snapshot: () => Uint8Array): void;
}

/**
 * Minimal structural view of `FileSystemSyncAccessHandle`. Declared locally so
 * the build does not depend on the host lib shipping these (still-recent) DOM
 * typings.
 */
interface SyncAccessHandle {
  read(buffer: ArrayBufferView, options?: { at?: number }): number;
  write(buffer: ArrayBufferView, options?: { at?: number }): number;
  truncate(newSize: number): void;
  getSize(): number;
  flush(): void;
  close(): void;
}

interface FileHandleWithSync {
  createSyncAccessHandle(): Promise<SyncAccessHandle>;
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
function sanitizeName(name: string): string {
  const safe = name.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^\.+/, '_');
  return safe.length > 0 ? safe : '_';
}

/** A no-op store: feature unavailable, disabled, or lock contended. */
function inMemoryStore(): PersistentStore {
  return {
    persistent: false,
    initialBytes: null,
    bind() {},
    markDirty() {},
    async flush() {},
    async close() {},
  };
}

/** The real OPFS-backed store. Created only once a sync handle is acquired. */
class OpfsStore implements PersistentStore {
  readonly persistent = true;
  readonly initialBytes: Uint8Array | null;

  readonly #handle: SyncAccessHandle;
  readonly #debounceMs: number;
  #snapshot: (() => Uint8Array) | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #dirty = false;
  #closed = false;

  constructor(handle: SyncAccessHandle, initialBytes: Uint8Array | null, debounceMs: number) {
    this.#handle = handle;
    this.initialBytes = initialBytes;
    this.#debounceMs = debounceMs;
  }

  bind(snapshot: () => Uint8Array): void {
    this.#snapshot = snapshot;
  }

  markDirty(): void {
    if (this.#closed) return;
    this.#dirty = true;
    if (this.#timer === null) {
      this.#timer = setTimeout(() => {
        this.#timer = null;
        this.#writeNow();
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
      // Releases the exclusive lock so another tab can take over.
      this.#handle.close();
    }
  }

  /** Serialize and persist the current index if dirty. Synchronous by design. */
  #writeNow(): void {
    if (!this.#dirty || this.#snapshot === null) return;
    const bytes = this.#snapshot();
    this.#handle.write(bytes, { at: 0 });
    this.#handle.truncate(bytes.length);
    this.#handle.flush();
    this.#dirty = false;
  }
}

/**
 * Open (or create) the persistent store named `name`.
 *
 * Falls back to a non-persistent in-memory store — never throwing — when
 * persistence is disabled, OPFS sync access is unavailable (Node, insecure
 * context, unsupported browser), or the exclusive lock is already held by
 * another tab.
 */
export async function openStore(name: string, options: OpenStoreOptions = {}): Promise<PersistentStore> {
  const persist = options.persist ?? true;
  const debounceMs = options.debounceMs ?? 250;

  if (!persist || !syncAccessAvailable()) {
    return inMemoryStore();
  }

  try {
    const root = await navigator.storage.getDirectory();
    const base = await root.getDirectoryHandle('ferrovec', { create: true });
    const dir = await base.getDirectoryHandle(sanitizeName(name), { create: true });
    const fileHandle = await dir.getFileHandle('index.bin', { create: true });

    // Throws if another tab holds the exclusive lock — caught below.
    const handle = await (
      fileHandle as unknown as FileHandleWithSync
    ).createSyncAccessHandle();

    let initialBytes: Uint8Array | null = null;
    const size = handle.getSize();
    if (size > 0) {
      const buf = new Uint8Array(size);
      handle.read(buf, { at: 0 });
      initialBytes = buf;
    }
    return new OpfsStore(handle, initialBytes, debounceMs);
  } catch (err) {
    console.warn(
      `[ferrovec] OPFS persistence unavailable for "${name}" ` +
        `(likely held by another tab); falling back to in-memory:`,
      err,
    );
    return inMemoryStore();
  }
}
