/**
 * `npm run fetch-model`: download the embedding model Retrace ships with into
 * `models/` (gitignored), so the built extension loads it from its own files
 * and never contacts the Hugging Face hub at runtime.
 *
 * The revision is pinned and every file is checked against a SHA-256, so a
 * build is reproducible and a tampered or truncated download fails loudly.
 * Files that are already present with the right hash are not downloaded again.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MODEL = 'Xenova/all-MiniLM-L6-v2';
const REVISION = '751bff37182d3f1213fa05d7196b954e230abad9';

/** path inside the model repo → expected SHA-256 (at the pinned revision). */
const FILES: Record<string, string> = {
  'config.json':
    '7135149f7cffa1a573466c6e4d8423ed73b62fd2332c575bf738a0d033f70df7',
  'tokenizer.json':
    'da0e79933b9ed51798a3ae27893d3c5fa4a201126cef75586296df9b4d2c62a0',
  'tokenizer_config.json':
    '9261e7d79b44c8195c1cada2b453e55b00aeb81e907a6664974b4d7776172ab3',
  'onnx/model_quantized.onnx':
    'afdb6f1a0e45b715d0bb9b11772f032c399babd23bfc31fed1c170afc848bdb1',
};

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'models', MODEL);

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function existing(path: string): Promise<Uint8Array | null> {
  try {
    return await readFile(path);
  } catch {
    return null;
  }
}

let failed = false;
for (const [file, expected] of Object.entries(FILES)) {
  const dest = join(outDir, file);
  const have = await existing(dest);
  if (have && expected && sha256(have) === expected) {
    console.log(`ok      ${file} (cached)`);
    continue;
  }
  const url = `https://huggingface.co/${MODEL}/resolve/${REVISION}/${file}`;
  const response = await fetch(url);
  if (!response.ok) {
    console.error(`FAILED  ${file}: HTTP ${response.status} from ${url}`);
    failed = true;
    continue;
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  const actual = sha256(bytes);
  if (expected && actual !== expected) {
    console.error(`FAILED  ${file}: sha256 ${actual}, expected ${expected}`);
    failed = true;
    continue;
  }
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(`${dest}.part`, bytes);
  await rename(`${dest}.part`, dest);
  console.log(`fetched ${file} (${(bytes.length / 1024).toFixed(0)} KiB, sha256 ${actual})`);
}

if (failed) process.exit(1);
console.log(`model ready in ${outDir}`);
