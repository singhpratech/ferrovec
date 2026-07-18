/**
 * The testable core orchestrator.
 *
 * `Engine` owns an {@link Embedder} and a {@link VectorCore} and turns a
 * text-in API into embed → index operations. It has no Worker/DOM coupling, so
 * it runs unchanged under Node with injected fakes and will be reused by M4
 * (persistence) behind the same seam.
 */

import { encodeSnapshot } from './snapshot.ts';
import type { Embedder, EngineCreateOptions, Persister, QueryResult, VectorCore } from './types.ts';

/** A {@link Persister} that does nothing — the default (pure in-memory) sink. */
const NO_PERSIST: Persister = {
  markDirty() {},
  async flush() {},
  async close() {},
};

export class Engine {
  readonly #embedder: Embedder;
  readonly #core: VectorCore;
  readonly #persister: Persister;
  /** id → original text, so queries can echo the stored source text back. */
  readonly #texts: Map<string, string>;
  #autoId = 0;

  private constructor(
    embedder: Embedder,
    core: VectorCore,
    persister: Persister,
    texts: Map<string, string>,
  ) {
    this.#embedder = embedder;
    this.#core = core;
    this.#persister = persister;
    this.#texts = texts;
    // When rehydrating a persisted index, resume auto-ids past any restored
    // `auto-N` keys so fresh inserts don't collide with existing entries.
    for (const key of texts.keys()) {
      const match = /^auto-(\d+)$/.exec(key);
      if (match) this.#autoId = Math.max(this.#autoId, Number(match[1]) + 1);
    }
  }

  /**
   * Create an engine. Loads the transformers.js model and instantiates the wasm
   * core unless an {@link Embedder}/{@link VectorCore} is injected.
   */
  static async create(options: EngineCreateOptions = {}): Promise<Engine> {
    const embedder = options.embedder ?? (await Engine.#defaultEmbedder(options));

    let dims = options.dims ?? embedder.dims;
    if (!dims) {
      // Lazily-probed embedder: discover dimensionality with one embed.
      dims = (await embedder.embed('warmup')).length;
    }

    const core = options.core ?? (await Engine.#defaultCore(dims));
    return new Engine(
      embedder,
      core,
      options.persister ?? NO_PERSIST,
      options.initialTexts ?? new Map<string, string>(),
    );
  }

  static async #defaultEmbedder(options: EngineCreateOptions): Promise<Embedder> {
    const { createTransformersEmbedder } = await import('./embedder.ts');
    return createTransformersEmbedder({ model: options.model, device: options.device });
  }

  static async #defaultCore(dims: number): Promise<VectorCore> {
    const { createCore } = await import('./core-loader.ts');
    return createCore(dims);
  }

  /**
   * Embed `text` and insert it under `id` (auto-generated if omitted). Upserts:
   * re-inserting an existing id replaces its vector and stored text. Returns the
   * id used.
   */
  async insert(text: string, id?: string): Promise<string> {
    const key = id ?? `auto-${this.#autoId++}`;
    const vector = await this.#embedder.embed(text);
    this.#core.insert(key, vector);
    this.#texts.set(key, text);
    this.#persister.markDirty();
    return key;
  }

  /** Embed `text` and return the `k` nearest stored items, nearest first. */
  async query(text: string, k = 5): Promise<QueryResult[]> {
    const vector = await this.#embedder.embed(text);
    const hits = this.#core.search(vector, k);
    return hits.map((hit) => ({
      id: hit.id,
      text: this.#texts.get(hit.id),
      score: 1 - hit.distance,
    }));
  }

  /** Remove the item stored under `id`. Returns `true` if it existed. */
  remove(id: string): boolean {
    this.#texts.delete(id);
    const removed = this.#core.remove(id);
    if (removed) this.#persister.markDirty();
    return removed;
  }

  /** Number of live items in the index. */
  size(): number {
    return this.#core.len();
  }

  /**
   * Serialize the full index — vectors plus the id→text sidecar — into a single
   * snapshot blob. This is the source the injected {@link Persister} writes to
   * disk; the worker binds it into the OPFS store after construction.
   */
  snapshot(): Uint8Array {
    return encodeSnapshot(this.#core.toBytes(), this.#texts);
  }

  /** Force any pending persistence write to complete now. */
  flush(): Promise<void> {
    return this.#persister.flush();
  }

  /** Final flush and release of the persistence handle. */
  close(): Promise<void> {
    return this.#persister.close();
  }
}
