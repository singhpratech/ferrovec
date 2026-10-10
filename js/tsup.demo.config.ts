import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

/**
 * Builds the GitHub Pages notebook demo bundle (`docs/remember/`): the
 * package's main-thread client plus the demo worker (`demo/worker.ts`, the
 * production worker with an instant hashed embedder), minified, no dts or
 * sourcemaps. transformers.js is not bundled: the worker's import is rewritten
 * to a jsdelivr URL pinned to the installed version, used only when the page
 * opts into the real MiniLM model. The vendored wasm core is copied into
 * `docs/remember/core` by the `build:demo` npm script.
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
    worker: 'demo/worker.ts',
  },
  outDir: '../docs/remember',
  format: ['esm'],
  target: 'es2022',
  platform: 'neutral',
  dts: false,
  clean: true,
  sourcemap: false,
  minify: true,
  splitting: false,
  external: [/core\/ferrovec\.js$/, /^node:/],
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
