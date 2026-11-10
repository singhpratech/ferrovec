/**
 * Shared, framework-agnostic types for the ferrovec JS layer.
 *
 * Nothing here depends on the DOM, a Worker, or transformers.js — this keeps
 * {@link Engine} testable in plain Node with injected fakes.
 */

import type { Metadata } from './metadata.ts';
import type { SnapshotMeta } from './snapshot.ts';
import type { WalRecord } from './wal.ts';

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
  /**
   * The model id (e.g. `Xenova/all-MiniLM-L6-v2`). Recorded in every persisted
   * snapshot so a store reopened with a different model fails fast with an
   * `EmbeddingSpaceMismatchError` instead of returning wrong neighbours.
   */
  readonly id?: string;
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
  /**
   * Rebuild the index from its live vectors only, dropping removed and
   * replaced ones (which otherwise stay in memory and in {@link toBytes} as
   * tombstones). Optional, so cores injected without it keep working;
   * {@link Engine.compact} then only rewrites the persisted files.
   */
  compact?(): void;
}

/**
 * The mutation-facing surface {@link Engine} uses to persist itself.
 *
 * Kept DOM-free so `Engine` stays Node-testable: the default is a no-op, and the
 * worker injects the OPFS-backed store (see `persistence.ts`). `Engine` calls
 * {@link append} for every mutation **after** applying it in memory and
 * **before** acknowledging it to the caller, so the returned promise of
 * `insert`/`remove` is the durability acknowledgement.
 */
export interface Persister {
  /** Append one mutation. Resolves once the record is durable per the store's durability mode. */
  append(record: WalRecord): Promise<void>;
  /** Checkpoint now (full snapshot) and flush. */
  flush(): Promise<void>;
  /** Final checkpoint + release of handles. */
  close(): Promise<void>;
  /**
   * Write the current state as a full snapshot into every snapshot slot and
   * reset the log, even when nothing was logged since the last checkpoint, so
   * no file of the store still holds data that is no longer live. Optional;
   * {@link Engine.compact} falls back to {@link flush} without it.
   */
  rewrite?(): Promise<void>;
}

/** A single ranked hit returned from {@link Engine.query}. */
export interface QueryResult {
  /** The id the source text was stored under. */
  id: string;
  /** The original text, if it is still known to the engine. */
  text?: string;
  /** The metadata the document was inserted with; absent when it has none. */
  metadata?: Metadata;
  /**
   * Similarity score, higher is closer. Derived from the core's distance as
   * `1 - distance`; for the default cosine metric on normalized vectors this is
   * cosine similarity in `[-1, 1]` (≈ `1` for near-duplicates).
   */
  score: number;
}

/** Options for {@link Engine.list} / `Ferrovec.list`. */
export interface ListOptions {
  /** Number of documents to skip from the start of the order. Defaults to `0`. */
  offset?: number;
  /**
   * Maximum number of documents to return. Defaults to `100`; values above
   * `1000` are clamped to `1000` (and negative values to `0`) rather than
   * rejected.
   */
  limit?: number;
}

/** One stored document, as returned by {@link Engine.list} / `Ferrovec.list`. */
export interface StoredDocument {
  /** The id the document was stored under. */
  id: string;
  /** The original text it was inserted with (its latest text, after an upsert). */
  text: string;
  /** The metadata of its latest insert; absent when that insert had none. */
  metadata?: Metadata;
}

/**
 * When an `insert`/`remove` is acknowledged relative to its write-ahead-log
 * record reaching OPFS.
 *
 * - `'strict'` (default): every insert/remove is flushed to OPFS before its
 *   promise resolves, so an acknowledged write survives a tab kill.
 * - `'relaxed'`: the promise resolves as soon as the record is written, and the
 *   log is flushed at most every 50 ms. Faster, but a tab kill can lose the
 *   last ~50 ms of acknowledged writes.
 *
 * Either way OPFS `flush()` is content consistency, not `fsync`: the guarantee
 * is "survives a tab kill / crash and reload", not "survives power loss".
 */
export type Durability = 'strict' | 'relaxed';

/** Backend the transformers.js pipeline should run on. */
export type Device = 'webgpu' | 'wasm' | 'auto';

/**
 * Settings copied onto transformers.js's `env` before the model loads. Only the
 * keys listed here are applied; an omitted key keeps transformers.js's default.
 * Plain data, so it can cross into the worker.
 */
export interface TransformersEnvOptions {
  /** `env.allowRemoteModels`: `false` never fetches model files from the hub. */
  allowRemoteModels?: boolean;
  /** `env.allowLocalModels`: load model files from {@link localModelPath}. */
  allowLocalModels?: boolean;
  /** `env.localModelPath`: URL prefix (in a browser) local model files are fetched from. */
  localModelPath?: string;
  /** `env.remoteHost`: the hub mirror remote model files are fetched from. */
  remoteHost?: string;
  /** `env.useBrowserCache`: keep fetched model files in the Cache API. */
  useBrowserCache?: boolean;
  /**
   * `env.useWasmCache`: pre-fetch the onnxruntime wasm into the Cache API and
   * import its loader from a `blob:` URL. Set `false` under a CSP that forbids
   * `blob:` scripts (e.g. a browser extension).
   */
  useWasmCache?: boolean;
  /**
   * `env.backends.onnx.wasm.wasmPaths`: where the onnxruntime-web wasm files are
   * loaded from, as a URL prefix or explicit `{ mjs, wasm }` URLs. Without it
   * transformers.js loads them from a CDN.
   */
  wasmPaths?: string | { mjs?: string; wasm?: string };
  /** `env.backends.onnx.wasm.numThreads`. */
  numThreads?: number;
}

/** How the default embedder configures and loads transformers.js. */
export interface TransformersOptions {
  /**
   * Applied to transformers.js's `env` before the pipeline is built. `env` is
   * global to the context transformers.js runs in (the store's worker), so the
   * last store opened there wins.
   */
  env?: TransformersEnvOptions;
  /**
   * The pipeline's `dtype` (e.g. `'q8'` for `onnx/model_quantized.onnx`,
   * `'fp32'` for `onnx/model.onnx`). Defaults to transformers.js's choice for
   * the device.
   */
  dtype?: string;
}

/** Options for constructing the default transformers.js embedder. */
export interface EmbedderOptions {
  /** HF model id. Defaults to `Xenova/all-MiniLM-L6-v2` (384-dim). */
  model?: string;
  /** Preferred device. `'auto'` lets transformers.js pick the default backend. */
  device?: Device;
  /** transformers.js configuration (local model files, wasm paths, dtype). */
  transformers?: TransformersOptions;
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
  /** transformers.js configuration for the default embedder. */
  transformers?: TransformersOptions;
  /**
   * Override the core dimensionality. When omitted it is taken from the
   * embedder (probing with a warmup embed if the embedder reports `0`).
   */
  dims?: number;
  /**
   * Persistence sink each mutation is appended to before it is acknowledged.
   * Defaults to a no-op (pure in-memory). The worker injects an OPFS-backed
   * store.
   */
  persister?: Persister;
  /**
   * Seed the id→text sidecar when rehydrating a persisted index, so queries can
   * echo stored text back immediately after a reload.
   */
  initialTexts?: Map<string, string>;
  /**
   * Seed the id→metadata sidecar when rehydrating, paired with
   * {@link initialTexts} (only documents that have metadata appear).
   */
  initialMetadata?: Map<string, Metadata>;
  /**
   * The self-description of the persisted snapshot an injected {@link core} was
   * rehydrated from, if any. Used only to name the stored model when the core's
   * dimensionality does not match the embedder's.
   */
  initialMeta?: SnapshotMeta | null;
  /**
   * Write-ahead-log records to apply, in order, on top of the injected (or
   * fresh) core before the engine is returned — the mutations acknowledged
   * after the last checkpoint. Applied directly to the core and the text and
   * metadata sidecars with **no** persister calls (they are already durable). A logged
   * vector whose width is not the engine's dims throws `WalCorruptError`.
   */
  replay?: WalRecord[];
}
