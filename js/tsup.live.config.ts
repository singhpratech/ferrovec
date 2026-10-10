import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

/**
 * Builds the GitHub Pages live demo bundle (`docs/live/`): the same entries as
 * the package build, minified, no dts/sourcemaps. transformers.js is NOT
 * bundled — the worker's `import('@huggingface/transformers')` is rewritten to
 * a CDN URL pinned to the exact installed version, so the committed demo stays
 * small and loads the library (and, through it, onnxruntime's wasm) from
 * jsdelivr. The vendored wasm core is copied into `docs/live/core` by the
 * `build:live` npm script.
 */
const transformersVersion = (
  JSON.parse(
    readFileSync(new URL('./node_modules/@huggingface/transformers/package.json', import.meta.url), 'utf8'),
  ) as { version: string }
).version;
const TRANSFORMERS_CDN = `https://cdn.jsdelivr.net/npm/@huggingface/transformers@${transformersVersion}/dist/transformers.min.js`;

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    worker: 'src/worker.ts',
  },
  outDir: '../docs/live',
  format: ['esm'],
  target: 'es2022',
  platform: 'neutral',
  dts: false,
  clean: true,
  sourcemap: false,
  minify: true,
  splitting: false,
  external: [/core\/ferrovec\.js$/, /^node:/],
  // tsup externalizes package.json dependencies before plugins run; opt
  // transformers.js out of that so the plugin below can rewrite it.
  noExternal: ['@huggingface/transformers'],
  esbuildPlugins: [
    {
      name: 'pin-transformers-cdn',
      setup(build) {
        build.onResolve({ filter: /^@huggingface\/transformers$/ }, () => ({
          path: TRANSFORMERS_CDN,
          external: true,
        }));
      },
    },
  ],
});
