/**
 * LangChain.js adapter (`ferrovec/langchain`), offline: a FerrovecVectorStore
 * over an Engine-backed shim of the `Ferrovec` surface, driven by the same
 * deterministic fake embedder as the orchestration tests and the real wasm
 * core. Covers addDocuments and its ids, metadata, similarity search with and
 * without a filter, delete, the static constructors, the unsupported
 * vector-level methods, and `asRetriever().invoke`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Document } from '@langchain/core/documents';

import { Engine } from '../src/engine.ts';
import { createCore } from '../src/core-loader.ts';
import { FerrovecEmbeddings, FerrovecVectorStore, type FerrovecLike } from '../src/langchain.ts';
import type { Embedder } from '../src/types.ts';

const DIMS = 32;

/** Deterministic bag-of-tokens embedder (FNV-1a buckets, L2-normalized), as in orchestration.test.ts. */
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

/** An Engine behind the `Ferrovec` method shapes, recording every query's `k`. */
async function makeDb(): Promise<{ db: FerrovecLike; engine: Engine; queryKs: number[] }> {
  const engine = await Engine.create({ embedder: makeFakeEmbedder(), core: await createCore(DIMS) });
  const queryKs: number[] = [];
  const db: FerrovecLike = {
    insert: (text, options = {}) => engine.insert(text, options.id, options.metadata),
    query: (text, k = 5) => {
      queryKs.push(k);
      return engine.query(text, k);
    },
    remove: (id) => engine.remove(id),
    list: async (options) => engine.list(options),
  };
  return { db, engine, queryKs };
}

const DOCS = [
  new Document({ pageContent: 'the cat sat on the mat', metadata: { source: 'pets', page: 1 } }),
  new Document({ pageContent: 'a dog chased the ball', metadata: { source: 'pets', page: 2 } }),
  new Document({ pageContent: 'quarks are bound by gluons', metadata: { source: 'physics', tags: ['qcd'] } }),
  new Document({ pageContent: 'no metadata on this one' }),
];

test('addDocuments: inserts text + metadata, returns ids (from options, then doc.id, then auto)', async () => {
  const { db, engine } = await makeDb();
  const store = new FerrovecVectorStore(db);
  assert.equal(store._vectorstoreType(), 'ferrovec');

  const ids = await store.addDocuments(DOCS.slice(0, 2), { ids: ['cat', 'dog'] });
  assert.deepEqual(ids, ['cat', 'dog']);
  const more = await store.addDocuments([
    new Document({ pageContent: DOCS[2]!.pageContent, metadata: DOCS[2]!.metadata, id: 'quark' }),
    DOCS[3]!,
  ]);
  assert.equal(more[0], 'quark', 'a document id is used when no ids are passed');
  assert.match(more[1]!, /^auto-\d+$/, 'otherwise ferrovec assigns one');

  assert.deepEqual(await db.list(), [
    { id: 'cat', text: 'the cat sat on the mat', metadata: { source: 'pets', page: 1 } },
    { id: 'dog', text: 'a dog chased the ball', metadata: { source: 'pets', page: 2 } },
    { id: 'quark', text: 'quarks are bound by gluons', metadata: { source: 'physics', tags: ['qcd'] } },
    { id: more[1], text: 'no metadata on this one' }, // `{}` is stored as no metadata
  ]);

  // Re-adding an id replaces the document, metadata included.
  await store.addDocuments([new Document({ pageContent: 'the cat moved', metadata: { source: 'moved' } })], {
    ids: ['cat'],
  });
  assert.equal(engine.size(), 4);
  assert.deepEqual((await db.list())[0], { id: 'cat', text: 'the cat moved', metadata: { source: 'moved' } });

  await assert.rejects(store.addDocuments(DOCS, { ids: ['only-one'] }), /1 ids for 4 documents/);
});

test('similaritySearch / similaritySearchWithScore return Documents with id, stored text, metadata and score', async () => {
  const { db, queryKs } = await makeDb();
  const store = await FerrovecVectorStore.fromDocuments(DOCS, undefined, { db });

  const docs = await store.similaritySearch('the cat sat on the mat', 2);
  assert.equal(docs.length, 2);
  assert.ok(docs[0] instanceof Document);
  assert.equal(docs[0]!.pageContent, 'the cat sat on the mat');
  assert.deepEqual(docs[0]!.metadata, { source: 'pets', page: 1 });
  assert.equal(docs[0]!.id, 'auto-0');

  const scored = await store.similaritySearchWithScore('quarks are bound by gluons', 4);
  assert.equal(scored.length, 4);
  const [top, score] = scored[0]!;
  assert.equal(top.pageContent, 'quarks are bound by gluons');
  assert.deepEqual(top.metadata, { source: 'physics', tags: ['qcd'] });
  assert.ok(score > 0.99, `exact text scores ≈ 1, got ${score}`);
  for (let i = 1; i < scored.length; i++) assert.ok(scored[i - 1]![1] >= scored[i]![1], 'nearest first');
  const bare = scored.find(([d]) => d.pageContent === 'no metadata on this one');
  assert.deepEqual(bare?.[0].metadata, {}, 'no metadata → {}');

  assert.deepEqual(await store.similaritySearch('anything'), (await store.similaritySearch('anything', 4)));
  assert.deepEqual(queryKs, [2, 4, 4, 4], 'no filter: ferrovec is asked for exactly k (default 4)');
});

test('filter: exact match on top-level metadata keys, over an enlarged candidate pool', async () => {
  const { db, queryKs } = await makeDb();
  const store = await FerrovecVectorStore.fromDocuments(DOCS, undefined, { db });

  const pets = await store.similaritySearch('the cat sat on the mat', 4, { source: 'pets' });
  assert.deepEqual(pets.map((d) => d.pageContent).sort(), ['a dog chased the ball', 'the cat sat on the mat']);

  const page2 = await store.similaritySearch('the cat sat on the mat', 4, { source: 'pets', page: 2 });
  assert.deepEqual(page2.map((d) => d.pageContent), ['a dog chased the ball'], 'every key must match');

  assert.deepEqual(
    (await store.similaritySearch('quarks', 4, { tags: ['qcd'] })).map((d) => d.pageContent),
    ['quarks are bound by gluons'],
    'arrays compare by value',
  );
  assert.deepEqual(await store.similaritySearch('quarks', 4, { tags: ['other'] }), []);
  assert.deepEqual(await store.similaritySearch('cat', 4, { page: '1' }), [], 'no type coercion');
  assert.deepEqual(await store.similaritySearch('cat', 4, { missing: undefined }), [], 'the key must be present');

  const one = await store.similaritySearchWithScore('the cat sat on the mat', 1, { source: 'pets' });
  assert.equal(one.length, 1, 'trimmed back to k');
  assert.equal(one[0]![0].pageContent, 'the cat sat on the mat');

  // An empty filter is no filter.
  assert.equal((await store.similaritySearch('cat', 4, {})).length, 4);

  // Pool size: min(k * 4, k + 50), and exactly k without a filter.
  queryKs.length = 0;
  await store.similaritySearch('x', 4, { source: 'pets' });
  await store.similaritySearch('x', 30, { source: 'pets' });
  await store.similaritySearch('x', 4, {});
  assert.deepEqual(queryKs, [16, 80, 4]);
});

test('delete({ ids }) removes documents; unknown ids are ignored; no ids throws', async () => {
  const { db, engine } = await makeDb();
  const store = new FerrovecVectorStore(db);
  await store.addDocuments(DOCS, { ids: ['a', 'b', 'c', 'd'] });
  await store.delete({ ids: ['b', 'd', 'never-stored'] });
  assert.equal(engine.size(), 2);
  assert.deepEqual((await db.list()).map((d) => d.id), ['a', 'c']);
  const hits = await store.similaritySearch('a dog chased the ball', 4);
  assert.ok(!hits.some((d) => d.id === 'b'));
  await assert.rejects(store.delete(), /needs \{ ids \}/);
});

test('asRetriever().invoke goes through similaritySearch (k and filter included)', async () => {
  const { db, queryKs } = await makeDb();
  const store = await FerrovecVectorStore.fromTexts(
    ['the cat sat on the mat', 'a dog chased the ball', 'quarks are bound by gluons'],
    [{ source: 'pets' }, { source: 'pets' }, { source: 'physics' }],
    undefined,
    { db },
  );

  const docs = await store.asRetriever(1).invoke('the cat sat on the mat');
  assert.equal(docs.length, 1);
  assert.equal(docs[0]!.pageContent, 'the cat sat on the mat');
  assert.deepEqual(docs[0]!.metadata, { source: 'pets' });

  const physics = await store.asRetriever({ k: 2, filter: { source: 'physics' } }).invoke('the cat sat on the mat');
  assert.deepEqual(physics.map((d) => d.pageContent), ['quarks are bound by gluons']);
  assert.deepEqual(queryKs, [1, 8]);
});

test('fromTexts with one shared metadata object; constructor embeddings option', async () => {
  const { db } = await makeDb();
  const embeddings = new FerrovecEmbeddings();
  const store = await FerrovecVectorStore.fromTexts(['one fish', 'two fish'], { source: 'seuss' }, embeddings, { db });
  assert.equal(store.embeddings, embeddings);
  assert.deepEqual(
    (await db.list()).map((d) => d.metadata),
    [{ source: 'seuss' }, { source: 'seuss' }],
  );
});

test('vector-level entry points and the default embeddings throw clear errors', async () => {
  const { db } = await makeDb();
  const store = new FerrovecVectorStore(db);
  assert.ok(store.embeddings instanceof FerrovecEmbeddings);
  await assert.rejects(store.embeddings.embedQuery('x'), /ferrovec embeds inside its worker; use addDocuments\/similaritySearch/);
  await assert.rejects(store.embeddings.embedDocuments(['x']), /ferrovec embeds inside its worker/);
  await assert.rejects(store.addVectors([[1, 2]], [new Document({ pageContent: 'x' })]), /addVectors is not supported/);
  await assert.rejects(store.similaritySearchVectorWithScore([1, 2], 1), /not supported/);
});
