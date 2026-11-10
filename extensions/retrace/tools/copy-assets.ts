/**
 * Last build step: put the files the store host loads at runtime into `dist/`:
 *
 * - `models/Xenova/all-MiniLM-L6-v2/...` from `models/` (see fetch-model.ts);
 * - `ort/ort-wasm-simd-threaded.{mjs,wasm}`: the onnxruntime-web build that
 *   the bundled transformers.js resolves to (same package instance, so the
 *   JS glue and the wasm always match).
 *
 * Fails the build if the model has not been fetched.
 */

import { cp, mkdir, readFile, realpath, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const MODEL = 'Xenova/all-MiniLM-L6-v2';
const MODEL_FILES = ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model_quantized.onnx'];
const ORT_FILES = ['ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm'];

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

// --- model -----------------------------------------------------------------
for (const file of MODEL_FILES) {
  const from = join(root, 'models', MODEL, file);
  if (!(await exists(from))) {
    console.error(`missing ${from}\nrun \`npm run fetch-model\` first`);
    process.exit(1);
  }
  const to = join(dist, 'models', MODEL, file);
  await mkdir(dirname(to), { recursive: true });
  await cp(from, to);
}

// --- onnxruntime-web wasm ------------------------------------------------------
// Resolve exactly as the bundle did: ferrovec → @huggingface/transformers → onnxruntime-web.
const ferrovecDir = await realpath(join(root, 'node_modules', 'ferrovec'));
const fromFerrovec = createRequire(join(ferrovecDir, 'package.json'));
const transformersEntry = fromFerrovec.resolve('@huggingface/transformers');
const fromTransformers = createRequire(transformersEntry);
const ortEntry = fromTransformers.resolve('onnxruntime-web');
let ortDir = dirname(ortEntry);
while (!(await exists(join(ortDir, 'package.json')))) ortDir = dirname(ortDir);
const ortVersion = (JSON.parse(await readFile(join(ortDir, 'package.json'), 'utf8')) as { version: string }).version;
await mkdir(join(dist, 'ort'), { recursive: true });
for (const file of ORT_FILES) await cp(join(ortDir, 'dist', file), join(dist, 'ort', file));

console.log(`copied ${MODEL} and onnxruntime-web ${ortVersion} wasm into dist/`);
