/** Rebuilding bookkeeping from `db.list()` rows (the IndexedDB side runs in the e2e). */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { recordsFromList } from '../src/lib/bookkeeping.ts';
import { chunkId, sha256Hex, urlHash } from '../src/lib/hash.ts';

function row(urlH: string, i: number, url: string, visitedAt: string, of = 3) {
  return {
    id: chunkId(urlH, i),
    metadata: { url, title: `T ${url}`, host: new URL(url).hostname, visitedAt, chunk: i, of },
  };
}

test('one record per URL, newest visit, chunk count from metadata; hash unknown forces a re-index', () => {
  const records = recordsFromList([
    row('aaaa', 0, 'https://a.example/', '2026-01-01T00:00:00.000Z'),
    row('bbbb', 0, 'https://b.example/', '2026-01-02T00:00:00.000Z', 1),
    row('aaaa', 2, 'https://a.example/', '2026-01-05T00:00:00.000Z'),
    row('aaaa', 1, 'https://a.example/', '2026-01-03T00:00:00.000Z'),
    { id: 'stray' },
    { id: 'x:0', metadata: { note: 'not ours' } },
  ]);
  assert.deepEqual(records, [
    {
      url: 'https://a.example/',
      urlHash: 'aaaa',
      hash: '',
      chunks: 3,
      title: 'T https://a.example/',
      host: 'a.example',
      visitedAt: '2026-01-05T00:00:00.000Z',
      indexedAt: '2026-01-05T00:00:00.000Z',
    },
    {
      url: 'https://b.example/',
      urlHash: 'bbbb',
      hash: '',
      chunks: 1,
      title: 'T https://b.example/',
      host: 'b.example',
      visitedAt: '2026-01-02T00:00:00.000Z',
      indexedAt: '2026-01-02T00:00:00.000Z',
    },
  ]);
});

test('chunks covers the highest stored passage even if `of` says fewer (page shrank mid-way)', () => {
  const [r] = recordsFromList([row('cc', 4, 'https://c.example/', '2026-01-01T00:00:00.000Z', 2)]);
  assert.equal(r!.chunks, 5);
});

test('hash helpers', async () => {
  assert.equal(
    await sha256Hex('abc'),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );
  const h = await urlHash('https://a.example/');
  assert.match(h, /^[0-9a-f]{16}$/);
  assert.equal(chunkId(h, 3), `${h}:3`);
});
