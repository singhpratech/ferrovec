import { test } from 'node:test';
import assert from 'node:assert/strict';

import { filterResults, groupHits, passageLink, relativeTime } from '../src/lib/group.ts';
import type { Hit } from '../src/lib/types.ts';

function hit(url: string, chunk: number, score: number, visitedAt = '2026-01-01T00:00:00.000Z', extra: Partial<Hit> = {}): Hit {
  const host = new URL(url).hostname;
  return {
    id: `${host}:${chunk}`,
    text: `passage ${chunk} of ${url}`,
    score,
    meta: { url, title: `Title of ${url}`, host, visitedAt, chunk, of: 5 },
    ...extra,
  };
}

test('groups passages by URL; the best passage sets score and snippet', () => {
  const results = groupHits([
    hit('https://a.example/x', 0, 0.5),
    hit('https://b.example/y', 2, 0.9),
    hit('https://a.example/x', 3, 0.7),
    hit('https://b.example/y', 1, 0.4),
    hit('https://c.example/z', 0, 0.6),
  ]);
  assert.deepEqual(
    results.map((r) => [r.url, r.score, r.chunk, r.matches]),
    [
      ['https://b.example/y', 0.9, 2, 2],
      ['https://a.example/x', 0.7, 3, 2],
      ['https://c.example/z', 0.6, 0, 1],
    ],
  );
  assert.equal(results[1]!.snippet, 'passage 3 of https://a.example/x');
});

test('a page ranks by its best passage, not by how many passages matched', () => {
  const results = groupHits([
    hit('https://many.example/', 0, 0.61),
    hit('https://many.example/', 1, 0.6),
    hit('https://many.example/', 2, 0.6),
    hit('https://one.example/', 0, 0.8),
  ]);
  assert.equal(results[0]!.url, 'https://one.example/');
});

test('visitedAt is the latest of passage metadata and bookkeeping', () => {
  const [r] = groupHits([
    hit('https://a.example/', 0, 0.5, '2026-01-01T00:00:00.000Z', { lastVisitedAt: '2026-03-01T00:00:00.000Z' }),
    hit('https://a.example/', 1, 0.4, '2026-02-01T00:00:00.000Z'),
  ]);
  assert.equal(r!.visitedAt, '2026-03-01T00:00:00.000Z');
});

test('empty input', () => {
  assert.deepEqual(groupHits([]), []);
});

test('filters by host (with subdomains) and by time', () => {
  const now = Date.parse('2026-06-10T00:00:00.000Z');
  const results = groupHits([
    hit('https://docs.example.com/a', 0, 0.9, '2026-06-09T12:00:00.000Z'),
    hit('https://example.com/b', 0, 0.8, '2026-01-01T00:00:00.000Z'),
    hit('https://other.org/c', 0, 0.7, '2026-06-09T00:00:00.000Z'),
  ]);
  assert.deepEqual(
    filterResults(results, { host: 'example.com' }).map((r) => r.url),
    ['https://docs.example.com/a', 'https://example.com/b'],
  );
  assert.deepEqual(
    filterResults(results, { since: now - 7 * 86400_000 }).map((r) => r.url),
    ['https://docs.example.com/a', 'https://other.org/c'],
  );
  assert.deepEqual(
    filterResults(results, { host: 'Example.com', since: now - 86400_000 }).map((r) => r.url),
    ['https://docs.example.com/a'],
  );
  assert.equal(filterResults(results, {}).length, 3);
});

test('passageLink builds a text fragment from the start of the passage', () => {
  assert.equal(
    passageLink('https://a.example/p', 'Rust manages memory without a garbage collector through a set of rules'),
    'https://a.example/p#:~:text=Rust%20manages%20memory%20without%20a%20garbage%20collector%20through',
  );
  // Dashes, commas and ampersands are encoded (they are directive syntax).
  assert.equal(
    passageLink('https://a.example/p', 'Well-known, tried & tested: three words'),
    'https://a.example/p#:~:text=Well%2Dknown%2C%20tried%20%26%20tested%3A%20three%20words',
  );
  // Skips a too-short first paragraph (e.g. a heading word) to the next.
  assert.equal(
    passageLink('https://a.example/p', 'Intro\n\nThe real passage starts here today', 4),
    'https://a.example/p#:~:text=The%20real%20passage%20starts',
  );
  assert.equal(passageLink('https://a.example/p#old', 'one two three'), 'https://a.example/p#:~:text=one%20two%20three');
  assert.equal(passageLink('https://a.example/p', ''), 'https://a.example/p');
  assert.equal(passageLink('https://a.example/p', 'tiny'), 'https://a.example/p');
});

test('relativeTime', () => {
  const now = Date.parse('2026-06-10T12:00:00.000Z');
  assert.equal(relativeTime('2026-06-10T11:59:40.000Z', now, 'en'), 'this minute');
  assert.equal(relativeTime('2026-06-10T09:00:00.000Z', now, 'en'), '3 hours ago');
  assert.equal(relativeTime('2026-06-09T12:00:00.000Z', now, 'en'), 'yesterday');
  assert.equal(relativeTime('2026-05-01T12:00:00.000Z', now, 'en'), 'last month');
  assert.equal(relativeTime('garbage', now, 'en'), '');
});
