/**
 * The testable core orchestrator.
 *
 * `Engine` owns an {@link Embedder} and a {@link VectorCore} and turns a
 * text-in API into embed → index operations. It has no Worker/DOM coupling, so
 * it runs unchanged under Node with injected fakes and will be reused by M4
 * (persistence) behind the same seam.
 *
 * The engine knows which embedding space its vectors live in
 * ({@link Engine.embeddingSpace}: model id, dims, metric) and stamps it into
 * every snapshot it produces, so a persisted store can later refuse to be
 * reopened with a different model. Dimensionality is verified here, against an
 * injected (rehydrated) core, because it is only known once the embedder loads.
 */

import { EmbeddingSpaceMismatchError } from './errors.ts';
import { SNAPSHOT_WRITER, type EmbeddingSpace, type SnapshotSource } from './snapshot.ts';
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
  readonly #embeddingSpace: EmbeddingSpace;
  #autoId = 0;

  private constructor(
    embedder: Embedder,
    core: VectorCore,
    persister: Persister,
    texts: Map<string, string>,
    embeddingSpace: EmbeddingSpace,
  ) {
    this.#embeddingSpace = embeddingSpace;
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

    const embeddingSpace: EmbeddingSpace = {
      model: embedder.id ?? options.model ?? '<unknown>',
      dims,
      metric: 'cosine',
    };

    // A rehydrated core must live in the same space as the embedder: vectors of
    // a different width cannot be compared (and the core would reject them).
    if (options.core && options.core.dims() !== dims) {
      throw new EmbeddingSpaceMismatchError(
        {
          model: options.initialMeta?.embeddingSpace.model ?? 'unknown',
          dims: options.core.dims(),
          metric: 'cosine',
        },
        embeddingSpace,
      );
    }

    const core = options.core ?? (await Engine.#defaultCore(dims));
    return new Engine(
      embedder,
      core,
      options.persister ?? NO_PERSIST,
      options.initialTexts ?? new Map<string, string>(),
      embeddingSpace,
    );
  }

  /** The embedding model, dimensionality, and metric this engine's vectors live in. */
  get embeddingSpace(): EmbeddingSpace {
    return { ...this.#embeddingSpace };
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
    this.#persister.markDirty('insert');
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
    if (removed) this.#persister.markDirty('remove');
    return removed;
  }

  /** Number of live items in the index. */
  size(): number {
    return this.#core.len();
  }

  /**
   * Produce the full snapshot contents — serialized vectors, the id→text
   * sidecar, and the self-describing meta (embedding space, live count). The
   * persistence store binds this as its source and frames it (with its own
   * commit sequence) into the on-disk FVS2 blob. `texts` is the live map, so
   * the caller must encode it synchronously.
   */
  snapshot(): SnapshotSource {
    return {
      core: this.#core.toBytes(),
      texts: this.#texts,
      meta: {
        embeddingSpace: { ...this.#embeddingSpace },
        count: this.#core.len(),
        writer: SNAPSHOT_WRITER,
        createdAt: Date.now(),
      },
    };
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
