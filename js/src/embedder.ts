/**
 * The default {@link Embedder}: a thin wrapper over a transformers.js
 * `feature-extraction` pipeline.
 *
 * transformers.js is imported dynamically so that merely importing this module
 * (or {@link Engine}) does not pull in the ~large library — tests that inject a
 * fake embedder never touch it, and it stays fully offline-capable.
 */

import type { Embedder, EmbedderOptions } from './types.ts';

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

/**
 * Build the default transformers.js embedder.
 *
 * In a browser Worker, `device: 'webgpu'` is preferred with a graceful fallback
 * to the wasm backend; `'auto'` (the default) lets transformers.js choose,
 * which resolves to the wasm backend under Node.
 *
 * The returned embedder is warmed up (one forward pass) so its {@link
 * Embedder.dims} is populated before it is returned.
 */
export async function createTransformersEmbedder(
  options: EmbedderOptions = {},
): Promise<Embedder> {
  const model = options.model ?? DEFAULT_MODEL;
  const requested = options.device ?? 'auto';

  const { pipeline } = await import('@huggingface/transformers');

  const build = async (device?: 'webgpu' | 'wasm'): Promise<FeatureExtractor> => {
    const extractor = await pipeline('feature-extraction', model, device ? { device } : {});
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
