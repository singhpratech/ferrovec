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
  /**
   * On sync-handle contention, retry acquiring the exclusive handle this many
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
   * owner of `index.bin`. On sync-handle contention it must **never** silently
   * fall back to in-memory: doing so would present an intact on-disk index as
   * empty and accept writes that are discarded on reload while `index.bin` sits
   * untouched. Instead retry for a much longer deadline
   * ({@link LOCKED_CONTENTION_RETRIES}) and, if the handle truly never frees,
   * **throw** so promotion fails loudly rather than degrading. Ordinary
   * (solo / no-lock) opens leave this `false` and keep the best-effort in-memory
   * fallback unchanged. Defaults to `false`.
   */
  requireLock?: boolean;
}

/**
 * When the caller holds the leader Web Lock ({@link OpenStoreOptions.requireLock}),
 * keep retrying the OPFS sync handle at least this many times before giving up.
 * The outgoing owner's handle always frees once its tab/process finishes tearing
 * down — even a crashed tab's OS-level cleanup completes — so a generous deadline
 * (≈ 200 × 50ms = 10s) covers the handoff without silently degrading to memory.
 */
const LOCKED_CONTENTION_RETRIES = 200;

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
  const retryDelayMs = options.retryDelayMs ?? 50;
  const requireLock = options.requireLock ?? false;
  // A lock-holding caller is the legitimate owner of index.bin; give it a long
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
      const root = await navigator.storage.getDirectory();
      const base = await root.getDirectoryHandle('ferrovec', { create: true });
      const dir = await base.getDirectoryHandle(sanitizeName(name), { create: true });
      const fileHandle = await dir.getFileHandle('index.bin', { create: true });

      // Throws if another tab holds the exclusive lock — retried/caught below.
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
          `[ferrovec] OPFS index.bin for "${name}" is still locked after ` +
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
