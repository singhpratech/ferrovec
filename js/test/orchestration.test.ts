/**
 * Offline orchestration test: a deterministic FAKE embedder driving the REAL
 * wasm core. Validates Engine wiring (insert/query/remove/size), upsert
 * semantics, and the id→text mapping without any network access.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Engine } from '../src/engine.ts';
import { createCore } from '../src/core-loader.ts';
import { EmbeddingSpaceMismatchError } from '../src/errors.ts';
import type { Embedder } from '../src/types.ts';

const DIMS = 32;

/**
 * Deterministic bag-of-tokens embedder: each token is hashed (FNV-1a) into a
 * dimension; the vector is L2-normalized. Identical text → identical vector, so
 * an exact-match query yields cosine similarity ≈ 1.
 */
function makeFakeEmbedder(dims = DIMS): Embedder {
  return {
    id: 'fake-fnv1a-32',
    dims,
    async embed(text: string): Promise<Float32Array> {
      const acc = new Array<number>(dims).fill(0);
      for (const token of text.toLowerCase().split(/\s+/).filter(Boolean)) {
        let h = 2166136261 >>> 0;
        for (let i = 0; i < token.length; i++) {
          h ^= token.charCodeAt(i);
          h = Math.imul(h, 16777619) >>> 0;
        }
        const idx = h % dims;
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

test('Engine.create: a 32-dim injected core with a 16-dim embedder throws EmbeddingSpaceMismatchError', async () => {
  await assert.rejects(
    Engine.create({
      embedder: makeFakeEmbedder(16),
      core: await createCore(32),
      initialMeta: {
        embeddingSpace: { model: 'stored-model', dims: 32, metric: 'cosine' },
        count: 0,
        writer: 'test',
        createdAt: 0,
      },
    }),
    (err: unknown) => {
      assert.ok(err instanceof EmbeddingSpaceMismatchError);
      assert.equal(err.name, 'EmbeddingSpaceMismatchError');
      assert.deepEqual(err.stored, { model: 'stored-model', dims: 32, metric: 'cosine' });
      assert.deepEqual(err.requested, { model: 'fake-fnv1a-32', dims: 16, metric: 'cosine' });
      assert.match(err.message, /stored-model/);
      assert.match(err.message, /Ferrovec\.destroy/);
      return true;
    },
  );
});

test('engine.snapshot().meta reports the live count and the embedder model', async () => {
  const engine = await Engine.create({ embedder: makeFakeEmbedder(), core: await createCore(DIMS) });
  assert.deepEqual(engine.embeddingSpace, { model: 'fake-fnv1a-32', dims: DIMS, metric: 'cosine' });
  await engine.insert('one', 'a');
  await engine.insert('two', 'b');
  await engine.insert('three', 'c');
  engine.remove('b');

  const snap = engine.snapshot();
  assert.equal(snap.meta.count, engine.size());
  assert.equal(snap.meta.count, 2);
  assert.equal(snap.meta.embeddingSpace.model, 'fake-fnv1a-32');
  assert.equal(snap.meta.embeddingSpace.dims, DIMS);
  assert.ok(snap.meta.writer.startsWith('ferrovec-js/'));
  assert.ok(snap.core.length > 0);
  assert.deepEqual([...snap.texts.keys()].sort(), ['a', 'c']);
});

test('Engine passes markDirty kinds: insert → "insert", successful remove → "remove"', async () => {
  const kinds: Array<string | undefined> = [];
  const engine = await Engine.create({
    embedder: makeFakeEmbedder(),
    core: await createCore(DIMS),
    persister: {
      markDirty: (kind) => void kinds.push(kind),
      async flush() {},
      async close() {},
    },
  });
  await engine.insert('x', 'x');
  engine.remove('x');
  engine.remove('missing'); // no-op remove does not mark dirty
  assert.deepEqual(kinds, ['insert', 'remove']);
});
