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
 *
 * Durability contract: every mutation is applied in memory, then appended to
 * the persister's write-ahead log, and only then acknowledged (the returned
 * promise resolves). On open, the records logged since the last checkpoint are
 * replayed onto the rehydrated core inside {@link Engine.create}, so a failed
 * replay fails engine construction before anything can be written.
 */

import { EmbeddingSpaceMismatchError, WalCorruptError } from './errors.ts';
import { SNAPSHOT_WRITER, type EmbeddingSpace, type SnapshotSource } from './snapshot.ts';
import type { Embedder, EngineCreateOptions, Persister, QueryResult, VectorCore } from './types.ts';

/** A {@link Persister} that does nothing — the default (pure in-memory) sink. */
const NO_PERSIST: Persister = {
  async append() {},
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
    const texts = options.initialTexts ?? new Map<string, string>();

    // Replay the write-ahead log on top of the checkpoint, in order, before the
    // engine exists (so auto-id resumption below sees replayed ids too). These
    // records are already durable, so the persister is not involved.
    for (const record of options.replay ?? []) {
      if (record.kind === 'insert') {
        if (record.vector.length !== dims) {
          throw new WalCorruptError(
            'dims-mismatch',
            `logged insert "${record.id}" has ${record.vector.length} dims, the index has ${dims}`,
          );
        }
        core.insert(record.id, record.vector);
        texts.set(record.id, record.text);
      } else {
        core.remove(record.id);
        texts.delete(record.id);
      }
    }

    return new Engine(embedder, core, options.persister ?? NO_PERSIST, texts, embeddingSpace);
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
   * re-inserting an existing id replaces its vector and stored text. Resolves
   * with the id used only once the mutation is durable per the persister's
   * durability mode — the resolution *is* the acknowledgement.
   *
   * If the write-ahead log append rejects (quota, oversized id, ...) the
   * rejection is rethrown, and:
   * - a **new** id is exactly-once: the item is rolled back out of memory, so
   *   it is neither queryable nor written by a later checkpoint;
   * - an **upsert** of an existing id is at-least-once: the new vector and text
   *   stay in memory and become durable at the next successful checkpoint, even
   *   though this call rejected.
   */
  async insert(text: string, id?: string): Promise<string> {
    const key = id ?? `auto-${this.#autoId++}`;
    const vector = await this.#embedder.embed(text);
    const isNew = !this.#texts.has(key);
    this.#core.insert(key, vector);
    this.#texts.set(key, text);
    try {
      await this.#persister.append({ kind: 'insert', id: key, vector, text });
    } catch (err) {
      if (isNew) {
        this.#core.remove(key);
        this.#texts.delete(key);
      }
      throw err;
    }
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

  /**
   * Remove the item stored under `id`. Resolves `true` if it existed — after the
   * removal is durable — and `false` (logging nothing) if it did not.
   *
   * Removes are at-least-once: if the write-ahead log append rejects, the
   * rejection is rethrown but the item stays removed in memory, and the removal
   * becomes durable at the next successful checkpoint.
   */
  async remove(id: string): Promise<boolean> {
    this.#texts.delete(id);
    const removed = this.#core.remove(id);
    if (removed) await this.#persister.append({ kind: 'remove', id });
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

  /** Checkpoint now: write a full snapshot and reset the write-ahead log. */
  flush(): Promise<void> {
    return this.#persister.flush();
  }

  /** Final checkpoint and release of the persistence handles. */
  close(): Promise<void> {
    return this.#persister.close();
  }
}
