/**
 * Shared, framework-agnostic types for the ferrovec JS layer.
 *
 * Nothing here depends on the DOM, a Worker, or transformers.js — this keeps
 * {@link Engine} testable in plain Node with injected fakes.
 */

/**
 * Turns text into a dense vector. The default implementation wraps
 * transformers.js, but tests inject a deterministic fake and M4 can reuse the
 * same seam for a persisted/precomputed embedder.
 */
export interface Embedder {
  /** Embed a single string into a (typically L2-normalized) vector. */
  embed(text: string): Promise<Float32Array>;
  /**
   * Output dimensionality. May be `0` until the first {@link embed} call for
   * lazily-probed embedders; the default transformers embedder warms up on
   * creation so this is populated immediately.
   */
  readonly dims: number;
}

/**
 * The subset of the wasm `FerrovecCore` surface that {@link Engine} depends on.
 *
 * Declaring it structurally (rather than importing the concrete class) keeps
 * the orchestrator decoupled from the wasm module, so tests can drive it with a
 * pure-JS stand-in and M4 can swap in a persistence-backed core.
 */
export interface VectorCore {
  insert(id: string, vector: Float32Array): void;
  search(query: Float32Array, k: number): Array<{ id: string; distance: number }>;
  remove(id: string): boolean;
  len(): number;
  isEmpty(): boolean;
  dims(): number;
  /** Serialize the whole index to bytes (round-trips through `fromBytes`). */
  toBytes(): Uint8Array;
}

/**
 * The mutation-facing surface {@link Engine} uses to persist itself.
 *
 * Kept DOM-free so `Engine` stays Node-testable: the default is a no-op, and the
 * worker injects the OPFS-backed store (see `persistence.ts`). `Engine` calls
 * {@link markDirty} after every mutation, {@link flush} to force a pending
 * write, and {@link close} for a final flush + resource release.
 */
export interface Persister {
  /** Note that the index changed; implementations debounce an actual write. */
  markDirty(): void;
  /** Force any pending snapshot to be persisted now. */
  flush(): Promise<void>;
  /** Final flush and release of the underlying handle/lock. */
  close(): Promise<void>;
}

/** A single ranked hit returned from {@link Engine.query}. */
export interface QueryResult {
  /** The id the source text was stored under. */
  id: string;
  /** The original text, if it is still known to the engine. */
  text?: string;
  /**
   * Similarity score, higher is closer. Derived from the core's distance as
   * `1 - distance`; for the default cosine metric on normalized vectors this is
   * cosine similarity in `[-1, 1]` (≈ `1` for near-duplicates).
   */
  score: number;
}

/** Backend the transformers.js pipeline should run on. */
export type Device = 'webgpu' | 'wasm' | 'auto';

/** Options for constructing the default transformers.js embedder. */
export interface EmbedderOptions {
  /** HF model id. Defaults to `Xenova/all-MiniLM-L6-v2` (384-dim). */
  model?: string;
  /** Preferred device. `'auto'` lets transformers.js pick the default backend. */
  device?: Device;
}

/** Options for {@link Engine.create}. */
export interface EngineCreateOptions {
  /** Inject a custom embedder (e.g. a fake in tests). Defaults to transformers.js. */
  embedder?: Embedder;
  /** Inject a custom vector core. Defaults to the vendored wasm `FerrovecCore`. */
  core?: VectorCore;
  /** HF model id for the default embedder. */
  model?: string;
  /** Device for the default embedder. */
  device?: Device;
  /**
   * Override the core dimensionality. When omitted it is taken from the
   * embedder (probing with a warmup embed if the embedder reports `0`).
   */
  dims?: number;
  /**
   * Persistence sink invoked after each mutation. Defaults to a no-op (pure
   * in-memory). The worker injects an OPFS-backed store.
   */
  persister?: Persister;
  /**
   * Seed the id→text sidecar when rehydrating a persisted index, so queries can
   * echo stored text back immediately after a reload.
   */
  initialTexts?: Map<string, string>;
}
