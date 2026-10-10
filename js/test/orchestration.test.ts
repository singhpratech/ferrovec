/**
 * Offline orchestration test: a deterministic FAKE embedder driving the REAL
 * wasm core. Validates Engine wiring (insert/query/remove/size), upsert
 * semantics, and the id→text mapping without any network access.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_LIST_LIMIT, Engine, MAX_LIST_LIMIT } from '../src/engine.ts';
import { createCore, createCoreFromBytes } from '../src/core-loader.ts';
import { decodeSnapshot, encodeSnapshot } from '../src/snapshot.ts';
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

/** The ids of `engine.list(...)`, for compact order assertions. */
function listedIds(engine: Engine, options?: { offset?: number; limit?: number }): string[] {
  return engine.list(options).map((d) => d.id);
}

test('list(): insertion order, upserts keep their position, removed ids absent, re-insert goes last', async () => {
  const engine = await Engine.create({ embedder: makeFakeEmbedder(), core: await createCore(DIMS) });
  assert.deepEqual(engine.list(), [], 'empty store lists nothing');

  await engine.insert('alpha one', 'a');
  await engine.insert('bravo two', 'b');
  const auto = await engine.insert('charlie three');
  await engine.insert('delta four', 'd');
  assert.deepEqual(listedIds(engine), ['a', 'b', auto, 'd'], 'insertion order');

  // Upsert: new text, same position.
  await engine.insert('bravo rewritten', 'b');
  assert.deepEqual(engine.list(), [
    { id: 'a', text: 'alpha one' },
    { id: 'b', text: 'bravo rewritten' },
    { id: auto, text: 'charlie three' },
    { id: 'd', text: 'delta four' },
  ]);

  // Removed ids never appear; a removed-then-reinserted id moves to the end.
  assert.equal(await engine.remove('a'), true);
  assert.equal(await engine.remove('nope'), false);
  assert.deepEqual(listedIds(engine), ['b', auto, 'd']);
  await engine.insert('alpha is back', 'a');
  assert.deepEqual(listedIds(engine), ['b', auto, 'd', 'a']);
  assert.equal(engine.list().length, engine.size(), 'list covers every live item');
});

test('list(): offset/limit paging, defaults, and clamping (never throws)', async () => {
  const engine = await Engine.create({ embedder: makeFakeEmbedder(), core: await createCore(DIMS) });
  const total = MAX_LIST_LIMIT + 5;
  const ids: string[] = [];
  for (let i = 0; i < total; i++) ids.push(await engine.insert(`doc number ${i}`, `id-${i}`));

  assert.equal(DEFAULT_LIST_LIMIT, 100);
  assert.equal(MAX_LIST_LIMIT, 1000);
  assert.deepEqual(listedIds(engine), ids.slice(0, 100), 'default: offset 0, limit 100');
  assert.deepEqual(listedIds(engine, { offset: 10, limit: 3 }), ['id-10', 'id-11', 'id-12']);
  assert.deepEqual(listedIds(engine, { offset: total - 2, limit: 10 }), ids.slice(-2), 'short last page');
  assert.deepEqual(listedIds(engine, { offset: total }), [], 'offset at the end');
  assert.deepEqual(listedIds(engine, { offset: total + 50 }), [], 'offset past the end');

  // Clamping, not throwing.
  assert.equal(engine.list({ limit: 5000 }).length, MAX_LIST_LIMIT, 'limit clamped to 1000');
  assert.equal(engine.list({ limit: Infinity }).length, DEFAULT_LIST_LIMIT, 'non-finite limit → default');
  assert.equal(engine.list({ limit: Number.NaN }).length, DEFAULT_LIST_LIMIT, 'NaN limit → default');
  assert.deepEqual(engine.list({ limit: 0 }), [], 'limit 0 → empty page');
  assert.deepEqual(engine.list({ limit: -3 }), [], 'negative limit → 0');
  assert.deepEqual(listedIds(engine, { offset: -7, limit: 2 }), ['id-0', 'id-1'], 'negative offset → 0');
  assert.deepEqual(listedIds(engine, { offset: 2.9, limit: 1.9 }), ['id-2'], 'fractions are floored');

  // Paging with offset += limit visits every document exactly once, in order.
  const paged: string[] = [];
  for (let offset = 0; ; offset += 300) {
    const page = listedIds(engine, { offset, limit: 300 });
    paged.push(...page);
    if (page.length < 300) break;
  }
  assert.deepEqual(paged, ids);
});

test('list(): the order survives a reopen (snapshot texts + write-ahead log replay)', async () => {
  const embedder = makeFakeEmbedder();
  const log: WalRecord[] = [];
  const engine = await Engine.create({
    embedder,
    core: await createCore(DIMS),
    persister: { append: async (r) => void log.push(r), async flush() {}, async close() {} },
  });

  // Before the checkpoint: inserts, an upsert, and a remove.
  await engine.insert('alpha one', 'a');
  await engine.insert('bravo two', 'b');
  await engine.insert('charlie three', 'c');
  await engine.insert('bravo rewritten', 'b');
  await engine.remove('a');

  // Checkpoint: the snapshot as the store would frame and later decode it.
  const source = engine.snapshot();
  const bytes = encodeSnapshot(source.core, source.texts, { sequence: 1n, meta: source.meta });
  log.length = 0; // the log resets at a checkpoint

  // After the checkpoint, only in the log: an upsert of a snapshotted id, a
  // remove + re-insert, and a fresh id.
  await engine.insert('charlie rewritten', 'c');
  await engine.remove('b');
  await engine.insert('bravo returns', 'b');
  await engine.insert('echo five', 'e');
  await engine.insert('alpha again', 'a');
  const before = engine.list();
  assert.deepEqual(
    before.map((d) => d.id),
    ['c', 'b', 'e', 'a'],
  );

  // Reopen: rehydrate the checkpoint, replay the log on top.
  const snap = decodeSnapshot(bytes);
  const reopened = await Engine.create({
    embedder,
    core: await createCoreFromBytes(snap.core),
    initialTexts: snap.texts,
    initialMeta: snap.meta,
    replay: [...log],
  });
  assert.deepEqual(reopened.list(), before, 'same ids, same texts, same order after reopen');
  assert.deepEqual(reopened.list(), [
    { id: 'c', text: 'charlie rewritten' },
    { id: 'b', text: 'bravo returns' },
    { id: 'e', text: 'echo five' },
    { id: 'a', text: 'alpha again' },
  ]);
  assert.equal(reopened.size(), 4);
});
