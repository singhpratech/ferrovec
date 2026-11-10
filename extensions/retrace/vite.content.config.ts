/** The content script: one classic (IIFE) file, since content scripts cannot be ES modules. */
import { defineConfig } from 'vite';

export default defineConfig({
  publicDir: false,
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    target: 'es2022',
    sourcemap: false,
    lib: {
      entry: 'src/content.ts',
      formats: ['iife'],
      name: 'retraceContent',
      fileName: () => 'content.js',
    },
  },
});
