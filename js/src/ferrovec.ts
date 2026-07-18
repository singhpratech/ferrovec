/**
 * The main-thread proxy.
 *
 * `Ferrovec` spawns the dedicated {@link worker}, forwards a text-in API to it,
 * and correlates responses back to their awaiting callers via a pending-request
 * map. All embedding + indexing happens off the main thread inside the worker.
 */

import type {
  InsertResult,
  OpenResult,
  RemoveResult,
  SizeResult,
  WorkerRequest,
  WorkerRequestBody,
  WorkerResponse,
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
  readonly #worker: Worker;
  readonly #pending = new Map<number, Pending>();
  #nextId = 0;
  #persistent = false;

  private constructor(worker: Worker) {
    this.#worker = worker;
    this.#worker.onmessage = (event: MessageEvent<WorkerResponse>): void => {
      const response = event.data;
      const pending = this.#pending.get(response.id);
      if (!pending) return;
      this.#pending.delete(response.id);
      if (response.ok) {
        pending.resolve(response.result);
      } else {
        pending.reject(new Error(response.error));
      }
    };
    this.#worker.onerror = (event: ErrorEvent): void => {
      const error = new Error(event.message || 'worker error');
      for (const pending of this.#pending.values()) pending.reject(error);
      this.#pending.clear();
    };
  }

  /** Spawn the worker, open an index named `name`, and await readiness. */
  static async open(name: string, options: FerrovecOptions = {}): Promise<Ferrovec> {
    // References the *built* sibling `worker.js`, so this resolves correctly from
    // `dist/` and is statically analyzable by bundlers (Vite/webpack) that
    // rewrite `new Worker(new URL('./worker.js', import.meta.url))`.
    const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    const client = new Ferrovec(worker);
    const result = await client.#send<OpenResult>({
      type: 'open',
      name,
      model: options.model,
      device: options.device,
      persist: options.persist,
    });
    client.#persistent = result.persistent;
    return client;
  }

  /** Whether this index persists to disk (OPFS) or is running in-memory only. */
  get persistent(): boolean {
    return this.#persistent;
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
      await this.#send({ type: 'close' });
    } finally {
      this.#worker.terminate();
    }
  }
}
