/**
 * Loads and instantiates the vendored wasm core (`FerrovecCore`, `web` target).
 *
 * The `web` target's default init fetches `ferrovec_bg.wasm` relative to the
 * module URL in a browser. Node's `fetch` cannot read `file:` URLs, so under
 * Node we read the wasm bytes off disk and hand them to `initSync`-style init.
 */

import initWasm, { FerrovecCore } from './core/ferrovec.js';
import type { VectorCore } from './types.ts';

let initialized: Promise<void> | undefined;

function isNode(): boolean {
  return (
    typeof process !== 'undefined' &&
    process.versions != null &&
    process.versions.node != null
  );
}

async function ensureInit(): Promise<void> {
  if (initialized) return initialized;
  initialized = (async () => {
    if (isNode()) {
      // Node: read the wasm file and pass the bytes explicitly.
      const { readFile } = await import('node:fs/promises');
      const { fileURLToPath } = await import('node:url');
      const wasmPath = fileURLToPath(new URL('./core/ferrovec_bg.wasm', import.meta.url));
      const bytes = await readFile(wasmPath);
      await initWasm({ module_or_path: bytes });
    } else {
      // Browser/Worker: let the glue fetch `ferrovec_bg.wasm` from its own URL.
      await initWasm();
    }
  })();
  return initialized;
}

/**
 * Instantiate a `dims`-dimensional wasm-backed vector core (cosine metric by
 * default, matching the L2-normalized MiniLM embeddings).
 */
export async function createCore(dims: number): Promise<VectorCore> {
  await ensureInit();
  return new FerrovecCore(dims) as unknown as VectorCore;
}

/**
 * Rehydrate a vector core from bytes produced by {@link VectorCore.toBytes}
 * (via `FerrovecCore.fromBytes`). Used by the worker to restore a persisted
 * OPFS snapshot; dimensionality is recovered from the serialized index.
 */
export async function createCoreFromBytes(bytes: Uint8Array): Promise<VectorCore> {
  await ensureInit();
  return FerrovecCore.fromBytes(bytes) as unknown as VectorCore;
}
