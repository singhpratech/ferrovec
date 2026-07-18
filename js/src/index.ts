/**
 * ferrovec — text-in vector search: transformers.js embeddings + a wasm HNSW
 * core, driven off a dedicated Web Worker.
 *
 * Most apps only need {@link Ferrovec} (the main-thread proxy). {@link Engine}
 * and the embedder/core factories are exported for advanced use, custom
 * embedders, and non-Worker (e.g. Node) environments.
 */

export { Ferrovec } from './ferrovec.ts';
export type { FerrovecOptions, InsertOptions } from './ferrovec.ts';

export { Engine } from './engine.ts';

export { createTransformersEmbedder, DEFAULT_MODEL, DEFAULT_DIMS } from './embedder.ts';
export { createCore, createCoreFromBytes } from './core-loader.ts';

export type { Role } from './coordinator.ts';

export type {
  Embedder,
  VectorCore,
  Persister,
  QueryResult,
  Device,
  EmbedderOptions,
  EngineCreateOptions,
} from './types.ts';

export type { WorkerRequest, WorkerResponse } from './protocol.ts';
