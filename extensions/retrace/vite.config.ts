/**
 * Build of the extension pages (search, offscreen store host) and the service
 * worker. The content script is a classic script, built separately by
 * vite.content.config.ts; tools/copy-assets.ts then adds the model and the
 * onnxruntime wasm.
 */
import { defineConfig, defaultClientConditions } from 'vite';

export default defineConfig({
  publicDir: 'static',
  resolve: {
    // transformers.js imports `onnxruntime-web/webgpu`; this condition selects
    // the build that loads its wasm from `env.backends.onnx.wasm.wasmPaths`
    // (set by the store host to the copy bundled in `ort/`) instead of a
    // 23 MB asyncify wasm Vite would otherwise emit as an asset.
    conditions: ['onnxruntime-web-use-extern-wasm', ...defaultClientConditions],
  },
  // ferrovec's worker loads the wasm core and transformers.js lazily, which
  // needs code splitting inside the worker bundle: only the ES format allows it.
  worker: { format: 'es' },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    // No inline scripts anywhere (MV3 CSP), and no preload polyfill.
    modulePreload: { polyfill: false },
    assetsInlineLimit: 0,
    sourcemap: false,
    chunkSizeWarningLimit: 4096,
    rollupOptions: {
      input: {
        search: 'search.html',
        offscreen: 'offscreen.html',
        background: 'src/background.ts',
      },
      output: {
        // The manifest names the service worker by a fixed path.
        entryFileNames: (chunk) => (chunk.name === 'background' ? 'background.js' : 'assets/[name]-[hash].js'),
      },
    },
  },
});
