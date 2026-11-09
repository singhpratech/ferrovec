import { defineConfig } from 'vite';

export default defineConfig({
  // ferrovec's worker imports the wasm core and transformers.js lazily, which
  // needs code splitting inside the worker bundle: only the ES format allows it.
  worker: { format: 'es' },
  optimizeDeps: {
    // Keep ferrovec's `new Worker(new URL('./worker.js', import.meta.url))` and
    // the wasm core's `new URL('ferrovec_bg.wasm', import.meta.url)` pointing at
    // the real files instead of a pre-bundled copy.
    exclude: ['ferrovec', '@huggingface/transformers'],
  },
  server: {
    // `ferrovec` is linked from ../../js (file: dependency); let the dev server
    // read it.
    fs: { allow: ['.', '../../js'] },
  },
});
