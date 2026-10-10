/**
 * Offline orchestration test: a deterministic FAKE embedder driving the REAL
 * wasm core. Validates Engine wiring (insert/query/remove/size), upsert
 * semantics, and the id→text mapping without any network access.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Engine } from '../src/engine.ts';
import { createCore } from '../src/core-loader.ts';
import { EmbeddingSpaceMismatchError, WalCorruptError } from '../src/errors.ts';
import type { Embedder } from '../src/types.ts';
import type { WalRecord } from '../src/wal.ts';

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
  assert.equal(await engine.remove('feline-doc'), true);
  assert.equal(await engine.remove('feline-doc'), false);
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
  await engine.remove('b');

  const snap = engine.snapshot();
  assert.equal(snap.meta.count, engine.size());
  assert.equal(snap.meta.count, 2);
  assert.equal(snap.meta.embeddingSpace.model, 'fake-fnv1a-32');
  assert.equal(snap.meta.embeddingSpace.dims, DIMS);
  assert.ok(snap.meta.writer.startsWith('ferrovec-js/'));
  assert.ok(snap.core.length > 0);
  assert.deepEqual([...snap.texts.keys()].sort(), ['a', 'c']);
});

test('Engine appends one WAL record per mutation: insert → insert, successful remove → remove', async () => {
  const records: WalRecord[] = [];
  const engine = await Engine.create({
    embedder: makeFakeEmbedder(),
    core: await createCore(DIMS),
    persister: {
      append: async (record) => void records.push(record),
      async flush() {},
      async close() {},
    },
  });
  await engine.insert('x marks the spot', 'x');
  assert.equal(await engine.remove('x'), true);
  assert.equal(await engine.remove('missing'), false); // a no-op remove logs nothing
  assert.deepEqual(
    records.map((r) => [r.kind, r.id]),
    [
      ['insert', 'x'],
      ['remove', 'x'],
    ],
  );
  const first = records[0]!;
  assert.ok(first.kind === 'insert');
  assert.equal(first.text, 'x marks the spot');
  assert.equal(first.vector.length, DIMS);
});

test('insert()/remove() resolve only after the persister\'s append resolves', async () => {
  let release: (() => void) | null = null;
  let appends = 0;
  const engine = await Engine.create({
    embedder: makeFakeEmbedder(),
    core: await createCore(DIMS),
    persister: {
      append: () => {
        appends++;
        return new Promise<void>((resolve) => {
          release = resolve;
        });
      },
      async flush() {},
      async close() {},
    },
  });

  let acked = false;
  const insert = engine.insert('pending durability', 'p').then((id) => {
    acked = true;
    return id;
  });
  // Let the embed + in-memory apply run; the append is now pending.
  for (let i = 0; i < 20 && appends === 0; i++) await new Promise((r) => setImmediate(r));
  assert.equal(appends, 1);
  await new Promise((r) => setImmediate(r));
  assert.equal(acked, false, 'insert must not resolve before append resolves');
  assert.equal(engine.size(), 1, 'applied in memory before the append');
  release!();
  assert.equal(await insert, 'p');
  assert.equal(acked, true);

  let removed = false;
  const remove = engine.remove('p').then((v) => {
    removed = true;
    return v;
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(removed, false, 'remove must not resolve before append resolves');
  release!();
  assert.equal(await remove, true);
});

test('Engine.create({ replay }) applies inserts and removes in order, with no persister calls', async () => {
  const embedder = makeFakeEmbedder();
  const v = (t: string): Promise<Float32Array> => embedder.embed(t);
  const replay: WalRecord[] = [
    { kind: 'insert', id: 'a', vector: await v('alpha one'), text: 'alpha one' },
    { kind: 'insert', id: 'b', vector: await v('bravo two'), text: 'bravo two' },
    { kind: 'remove', id: 'a' },
    { kind: 'insert', id: 'c', vector: await v('charlie three'), text: 'charlie three' },
    { kind: 'insert', id: 'b', vector: await v('bravo replaced'), text: 'bravo replaced' },
    { kind: 'insert', id: 'auto-4', vector: await v('auto four'), text: 'auto four' },
  ];
  const calls: string[] = [];
  const engine = await Engine.create({
    embedder,
    core: await createCore(DIMS),
    replay,
    persister: {
      append: async (r) => void calls.push(`append ${r.kind}`),
      flush: async () => void calls.push('flush'),
      close: async () => void calls.push('close'),
    },
  });
  assert.deepEqual(calls, [], 'replay must not touch the persister');
  assert.equal(engine.size(), 3, 'a removed, b upserted, c and auto-4 inserted');
  const hits = await engine.query('bravo replaced', 1);
  assert.equal(hits[0]?.id, 'b');
  assert.equal(hits[0]?.text, 'bravo replaced');
  assert.ok(!(await engine.query('alpha one', 3)).some((h) => h.id === 'a'));
  assert.equal(await engine.insert('fresh'), 'auto-5', 'auto ids resume past replayed ones');
});

test('Engine.create({ replay }) with a wrong-width logged vector throws WalCorruptError', async () => {
  await assert.rejects(
    Engine.create({
      embedder: makeFakeEmbedder(),
      core: await createCore(DIMS),
      replay: [{ kind: 'insert', id: 'x', vector: new Float32Array(DIMS * 2), text: 'x' }],
    }),
    (err: unknown) => {
      assert.ok(err instanceof WalCorruptError);
      assert.equal(err.name, 'WalCorruptError');
      assert.equal(err.reason, 'dims-mismatch');
      return true;
    },
  );
});

test('append rejection: a new insert rolls back; an upsert and a remove stay applied (at-least-once)', async () => {
  let failAppends = false;
  const engine = await Engine.create({
    embedder: makeFakeEmbedder(),
    core: await createCore(DIMS),
    persister: {
      append: async () => {
        if (failAppends) throw new Error('simulated QuotaExceededError');
      },
      async flush() {},
      async close() {},
    },
  });
  await engine.insert('kept alpha document', 'keep');
  await engine.insert('doomed bravo document', 'doomed');
  assert.equal(engine.size(), 2);
  failAppends = true;

  // New id: rejected and rolled back — not counted, not queryable, not snapshotted.
  await assert.rejects(engine.insert('ghost zulu yankee xray', 'ghost'), /QuotaExceeded/);
  assert.equal(engine.size(), 2, 'size unchanged after a rejected new insert');
  const ghostHits = await engine.query('ghost zulu yankee xray', 5);
  assert.ok(!ghostHits.some((h) => h.id === 'ghost'), 'the rolled-back item is not returned');
  assert.ok(!engine.snapshot().texts.has('ghost'), 'and would not reach a checkpoint');

  // Auto id: rolled back the same way.
  await assert.rejects(engine.insert('auto ghost whiskey'), /QuotaExceeded/);
  assert.equal(engine.size(), 2);

  // Upsert of an existing id: rejected, but the new text stays in place.
  await assert.rejects(engine.insert('kept alpha rewritten', 'keep'), /QuotaExceeded/);
  assert.equal(engine.size(), 2);
  const upsertHits = await engine.query('kept alpha rewritten', 1);
  assert.equal(upsertHits[0]?.id, 'keep');
  assert.equal(upsertHits[0]?.text, 'kept alpha rewritten');

  // Remove: rejected, but the item is still gone.
  await assert.rejects(engine.remove('doomed'), /QuotaExceeded/);
  assert.equal(engine.size(), 1);
  assert.ok(!(await engine.query('doomed bravo document', 5)).some((h) => h.id === 'doomed'));
  assert.equal(await engine.remove('doomed'), false, 'reported gone');
});
