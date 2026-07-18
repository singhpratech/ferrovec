import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    worker: 'src/worker.ts',
  },
  format: ['esm'],
  target: 'es2022',
  platform: 'neutral',
  dts: true,
  clean: true,
  sourcemap: true,
  splitting: false,
  // The vendored wasm glue resolves `ferrovec_bg.wasm` relative to its own URL,
  // so keep it external and ship it alongside the bundle (copied below).
  // transformers.js and Node builtins are runtime deps, never bundled.
  external: [/core\/ferrovec\.js$/, /^node:/, '@huggingface/transformers'],
  // The vendored core is copied into `dist/core` by the `build` npm script
  // *after* tsup finishes: tsup's dts phase prunes stray `.d.ts` files from
  // `dist`, so an `onSuccess` copy would lose the core type declarations.
});
