/**
 * The default {@link Embedder}: a thin wrapper over a transformers.js
 * `feature-extraction` pipeline.
 *
 * transformers.js is imported dynamically so that merely importing this module
 * (or {@link Engine}) does not pull in the ~large library — tests that inject a
 * fake embedder never touch it, and it stays fully offline-capable.
 */

import type { Embedder, EmbedderOptions, TransformersEnvOptions } from './types.ts';

/** Default model: MiniLM produces 384-dim sentence embeddings. */
export const DEFAULT_MODEL = 'Xenova/all-MiniLM-L6-v2';
/** Output dimensionality of {@link DEFAULT_MODEL}. */
export const DEFAULT_DIMS = 384;

/** Minimal shape of the transformers.js pipeline output we consume. */
interface FeatureExtractionOutput {
  data: Float32Array | number[];
}
type FeatureExtractor = (
  text: string,
  options: { pooling: 'mean'; normalize: boolean },
) => Promise<FeatureExtractionOutput>;

/** The part of transformers.js's `env` that {@link applyTransformersEnv} writes. */
export interface TransformersEnvTarget {
  [key: string]: unknown;
  backends?: { onnx?: { wasm?: Record<string, unknown> } & Record<string, unknown> };
}

/** The top-level `env` keys {@link TransformersEnvOptions} may set, copied as-is. */
const ENV_KEYS = [
  'allowRemoteModels',
  'allowLocalModels',
  'localModelPath',
  'remoteHost',
  'useBrowserCache',
  'useWasmCache',
] as const;

/**
 * Copy `options` onto a transformers.js `env` object: the top-level keys as-is,
 * `wasmPaths` / `numThreads` onto `env.backends.onnx.wasm` (skipped when the
 * runtime has no onnx backend object, e.g. a stubbed env). Keys that are
 * `undefined` (or not part of {@link TransformersEnvOptions}) are left alone.
 */
export function applyTransformersEnv(
  env: TransformersEnvTarget,
  options: TransformersEnvOptions | undefined,
): void {
  if (!options) return;
  for (const key of ENV_KEYS) {
    const value = options[key];
    if (value !== undefined) env[key] = value;
  }
  if (options.wasmPaths === undefined && options.numThreads === undefined) return;
  const onnx = env.backends?.onnx;
  if (!onnx || typeof onnx !== 'object') return;
  const wasm = (onnx.wasm ??= {});
  if (options.wasmPaths !== undefined) {
    wasm.wasmPaths =
      typeof options.wasmPaths === 'string' ? options.wasmPaths : { ...options.wasmPaths };
  }
  if (options.numThreads !== undefined) wasm.numThreads = options.numThreads;
}

/**
 * Build the default transformers.js embedder.
 *
 * In a browser Worker, `device: 'webgpu'` is preferred with a graceful fallback
 * to the wasm backend; `'auto'` (the default) lets transformers.js choose,
 * which resolves to the wasm backend under Node.
 *
 * `options.transformers.env` is applied to transformers.js's `env` before the
 * pipeline is built (so it decides where model and wasm files come from), and
 * `options.transformers.dtype` is passed to the pipeline.
 *
 * The returned embedder is warmed up (one forward pass) so its {@link
 * Embedder.dims} is populated before it is returned.
 */
export async function createTransformersEmbedder(
  options: EmbedderOptions = {},
): Promise<Embedder> {
  const model = options.model ?? DEFAULT_MODEL;
  const requested = options.device ?? 'auto';
  const dtype = options.transformers?.dtype;

  const { pipeline, env } = await import('@huggingface/transformers');
  applyTransformersEnv(env as unknown as TransformersEnvTarget, options.transformers?.env);

  const build = async (device?: 'webgpu' | 'wasm'): Promise<FeatureExtractor> => {
    const pipelineOptions: Record<string, unknown> = {};
    if (device) pipelineOptions.device = device;
    if (dtype !== undefined) pipelineOptions.dtype = dtype;
    const extractor = await pipeline('feature-extraction', model, pipelineOptions);
    return extractor as unknown as FeatureExtractor;
  };

  let extractor: FeatureExtractor;
  if (requested === 'webgpu') {
    try {
      extractor = await build('webgpu');
    } catch {
      extractor = await build('wasm');
    }
  } else if (requested === 'wasm') {
    extractor = await build('wasm');
  } else {
    extractor = await build(undefined);
  }

  let dims = 0;
  const embedder: Embedder = {
    id: model,
    get dims(): number {
      return dims;
    },
    async embed(text: string): Promise<Float32Array> {
      const output = await extractor(text, { pooling: 'mean', normalize: true });
      const vec =
        output.data instanceof Float32Array ? output.data : Float32Array.from(output.data);
      if (dims === 0) dims = vec.length;
      return vec;
    },
  };

  // Warm up so `dims` is known immediately (and to surface device errors early).
  await embedder.embed('warmup');
  return embedder;
}
