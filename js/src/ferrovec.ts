/**
 * The main-thread proxy.
 *
 * `Ferrovec` spawns the dedicated {@link worker}, forwards a text-in API to it,
 * and correlates responses back to their awaiting callers via a pending-request
 * map. All embedding + indexing happens off the main thread inside the worker.
 */

import type { Role } from './coordinator.ts';
import type {
  InsertResult,
  OpenResult,
  RemoveResult,
  SizeResult,
  WorkerOutbound,
  WorkerRequest,
  WorkerRequestBody,
} from './protocol.ts';
import type { Device, QueryResult } from './types.ts';

/** Options for {@link Ferrovec.open}. */
export interface FerrovecOptions {
  /** HF model id for embeddings. Defaults to `Xenova/all-MiniLM-L6-v2`. */
  model?: string;
  /** Device for the embedding pipeline. Defaults to `'webgpu'` with wasm fallback. */
  device?: Device;
  /**
   * Persist the index to OPFS across reloads when the environment supports it.
   * Defaults to `true`; transparently degrades to in-memory when OPFS sync
   * access is unavailable or the store is locked by another tab. Check
   * {@link Ferrovec.persistent} for the resolved mode.
   */
  persist?: boolean;
  /**
   * Ask the browser to make this origin's storage persistent
   * (`navigator.storage.persist()`) so OPFS data is not evicted under storage
   * pressure. Defaults to `true`.
   *
   * Firefox shows the user a permission prompt for `persist()`, which is why an
   * app may want to opt out (or call `navigator.storage.persist()` itself at a
   * moment of its choosing). When `false`, the call is skipped entirely and
   * {@link Ferrovec.storagePersisted} stays `false`.
   */
  requestPersistentStorage?: boolean;
}

/** Options for {@link Ferrovec.insert}. */
export interface InsertOptions {
  /** Explicit id to store under. Auto-generated when omitted. */
  id?: string;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

export class Ferrovec {
  /** Max time db.close() waits for the worker's graceful close before terminating. */
  static readonly #CLOSE_TIMEOUT_MS = 2000;

  readonly #worker: Worker;
  readonly #pending = new Map<number, Pending>();
  #nextId = 0;
  #persistent = false;
  #storagePersisted = false;
  #role: Role = 'solo';

  private constructor(worker: Worker) {
    this.#worker = worker;
    this.#worker.onmessage = (event: MessageEvent<WorkerOutbound>): void => {
      const message = event.data;
      // Unsolicited pushes carry a `type` discriminant and no correlation id —
      // e.g. a failover role change. Request responses never have `type`.
      if ('type' in message) {
        if (message.event === 'role') this.#role = message.role;
        return;
      }
      const response = message;
      const pending = this.#pending.get(response.id);
      if (!pending) return;
      this.#pending.delete(response.id);
      if (response.ok) {
        pending.resolve(response.result);
      } else {
        // Restore the typed error's name (e.g. 'EmbeddingSpaceMismatchError',
        // 'StoreCorruptError') so callers can switch on err.name.
        const error = new Error(response.error);
        if (response.errorName) error.name = response.errorName;
        pending.reject(error);
      }
    };
    this.#worker.onerror = (event: ErrorEvent): void => {
      const error = new Error(event.message || 'worker error');
      for (const pending of this.#pending.values()) pending.reject(error);
      this.#pending.clear();
    };
  }

  /** Spawn a store worker (see {@link Ferrovec.open} for why this URL form). */
  static #spawnWorker(): Worker {
    // References the *built* sibling `worker.js`, so this resolves correctly from
    // `dist/` and is statically analyzable by bundlers (Vite/webpack) that
    // rewrite `new Worker(new URL('./worker.js', import.meta.url))`.
    return new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  }

  /**
   * Spawn the worker, open an index named `name`, and await readiness.
   *
   * Rejects with an `Error` whose `name` is `'EmbeddingSpaceMismatchError'` when
   * the store was written with a different model (open it with the stored
   * model, or {@link Ferrovec.destroy} it), or `'StoreCorruptError'` when no
   * persisted snapshot slot is readable.
   *
   * Also asks the browser to make this origin's storage persistent
   * (`navigator.storage.persist()`, main-thread only) so OPFS data is not
   * evicted under storage pressure, unless
   * {@link FerrovecOptions.requestPersistentStorage} is `false`; see
   * {@link Ferrovec.storagePersisted}.
   */
  static async open(name: string, options: FerrovecOptions = {}): Promise<Ferrovec> {
    const worker = Ferrovec.#spawnWorker();
    const client = new Ferrovec(worker);
    // Best-effort and non-blocking: some browsers resolve persist() only after
    // the user answers a permission prompt, which must never stall open().
    if (options.requestPersistentStorage ?? true) {
      try {
        void navigator.storage
          ?.persist?.()
          .then((granted) => {
            client.#storagePersisted = granted === true;
          })
          .catch(() => {
            /* unsupported / denied → stays false */
          });
      } catch {
        /* navigator.storage unavailable → stays false */
      }
    }
    const result = await client.#send<OpenResult>({
      type: 'open',
      name,
      model: options.model,
      device: options.device,
      persist: options.persist,
    });
    client.#persistent = result.persistent;
    client.#role = result.role;
    return client;
  }

  /** Whether this index persists to disk (OPFS) or is running in-memory only. */
  get persistent(): boolean {
    return this.#persistent;
  }

  /**
   * Whether the browser granted persistent storage for this origin
   * (`navigator.storage.persist()`), i.e. OPFS data will not be evicted under
   * storage pressure. `false` when unsupported, denied, not yet answered, or
   * not requested ({@link FerrovecOptions.requestPersistentStorage} `false`);
   * the request is made by {@link Ferrovec.open} and this updates when it
   * resolves (usually before `open()` itself resolves).
   */
  get storagePersisted(): boolean {
    return this.#storagePersisted;
  }

  /**
   * Permanently delete the persisted store `name` (its whole OPFS directory).
   * Close every open handle to it first — in this tab and others — or the
   * browser refuses the removal and this rejects. Resolves (no-op) when the
   * store does not exist or OPFS is unavailable. This is the escape hatch for an
   * `EmbeddingSpaceMismatchError` or a `StoreCorruptError`.
   */
  static async destroy(name: string): Promise<void> {
    const worker = Ferrovec.#spawnWorker();
    const client = new Ferrovec(worker);
    try {
      await client.#send({ type: 'destroy', name });
    } finally {
      worker.terminate();
    }
  }

  /**
   * This tab's cross-tab coordination role:
   * - `'leader'` — owns the OPFS store and the authoritative index;
   * - `'follower'` — shares another tab's store, proxying ops to the leader;
   * - `'solo'` — no coordination (Web Locks/BroadcastChannel unavailable), sole owner.
   *
   * Updates live: a follower reports `'leader'` after it is promoted on failover.
   */
  get role(): Role {
    return this.#role;
  }

  #send<T = unknown>(payload: WorkerRequestBody): Promise<T> {
    const id = this.#nextId++;
    const request = { ...payload, id } as WorkerRequest;
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.#worker.postMessage(request);
    });
  }

  /** Embed and index `text`, returning the id it was stored under. */
  async insert(text: string, options: InsertOptions = {}): Promise<string> {
    const result = await this.#send<InsertResult>({ type: 'insert', text, docId: options.id });
    return result.id;
  }

  /** Return the `k` nearest stored items to `text`. */
  query(text: string, k = 5): Promise<QueryResult[]> {
    return this.#send<QueryResult[]>({ type: 'query', text, k });
  }

  /** Remove the item stored under `id`; resolves `true` if it existed. */
  async remove(id: string): Promise<boolean> {
    const result = await this.#send<RemoveResult>({ type: 'remove', docId: id });
    return result.removed;
  }

  /** Number of live items in the index. */
  async size(): Promise<number> {
    const result = await this.#send<SizeResult>({ type: 'size' });
    return result.size;
  }

  /** Close the index and terminate the worker. */
  async close(): Promise<void> {
    try {
      // Race the graceful close against a short timeout: a wedged/frozen worker
      // must not hang db.close() forever — we terminate() regardless below.
      await Promise.race([
        this.#send({ type: 'close' }),
        new Promise<void>((resolve) => setTimeout(resolve, Ferrovec.#CLOSE_TIMEOUT_MS)),
      ]);
    } catch {
      /* close send failed — terminate() still reclaims the worker */
    } finally {
      this.#worker.terminate();
    }
  }
}
