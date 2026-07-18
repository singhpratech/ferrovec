/**
 * Offline orchestration test: a deterministic FAKE embedder driving the REAL
 * wasm core. Validates Engine wiring (insert/query/remove/size), upsert
 * semantics, and the id→text mapping without any network access.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Engine } from '../src/engine.ts';
import { createCore } from '../src/core-loader.ts';
import type { Embedder } from '../src/types.ts';

const DIMS = 32;

/**
 * Deterministic bag-of-tokens embedder: each token is hashed (FNV-1a) into a
 * dimension; the vector is L2-normalized. Identical text → identical vector, so
 * an exact-match query yields cosine similarity ≈ 1.
 */
function makeFakeEmbedder(): Embedder {
  return {
    dims: DIMS,
    async embed(text: string): Promise<Float32Array> {
      const acc = new Array<number>(DIMS).fill(0);
      for (const token of text.toLowerCase().split(/\s+/).filter(Boolean)) {
        let h = 2166136261 >>> 0;
        for (let i = 0; i < token.length; i++) {
          h ^= token.charCodeAt(i);
          h = Math.imul(h, 16777619) >>> 0;
        }
        const idx = h % DIMS;
        acc[idx] = (acc[idx] ?? 0) + 1;
      }
      let norm = 0;
      for (const x of acc) norm += x * x;
      norm = Math.sqrt(norm) || 1;
      return Float32Array.from(acc, (x) => x / norm);
    },
  };
}

test('engine wiring: insert / query / remove / size + id→text mapping', async () => {
  const engine = await Engine.create({
    embedder: makeFakeEmbedder(),
    core: await createCore(DIMS),
  });
  assert.equal(engine.size(), 0);

  const catId = await engine.insert('the cat sat on the mat');
  const felineId = await engine.insert('a feline napped on a rug', 'feline-doc');
  await engine.insert('quantum chromodynamics describes quarks');

  assert.equal(engine.size(), 3);
  assert.equal(catId, 'auto-0');
  assert.equal(felineId, 'feline-doc');

  // Exact-match query returns the item first, echoing its stored text.
  const hits = await engine.query('the cat sat on the mat', 3);
  assert.ok(hits.length >= 1);
  assert.equal(hits[0]?.id, catId);
  assert.equal(hits[0]?.text, 'the cat sat on the mat');
  assert.ok((hits[0]?.score ?? 0) > 0.99, `expected near-1 score, got ${hits[0]?.score}`);

  // Upsert: re-inserting an existing id replaces rather than grows.
  await engine.insert('the cat sat on the mat', catId);
  assert.equal(engine.size(), 3);

  // Remove is idempotent and shrinks the index.
  assert.equal(engine.remove('feline-doc'), true);
  assert.equal(engine.remove('feline-doc'), false);
  assert.equal(engine.size(), 2);

  // The removed id no longer surfaces (and its text mapping is gone).
  const afterRemoval = await engine.query('a feline napped on a rug', 3);
  assert.ok(!afterRemoval.some((r) => r.id === 'feline-doc'));
});
