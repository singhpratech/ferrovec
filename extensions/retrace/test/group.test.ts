import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  contentWords,
  filterResults,
  groupHits,
  omniboxSuggestions,
  passageLink,
  relativeTime,
  snippetFor,
  queryOverlap,
  splitByStrength,
  STRENGTH_RULE,
  type StrengthRule,
  type PageResult,
} from '../src/lib/group.ts';
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

function page(host: string, score: number): PageResult {
  return {
    url: `https://${host}/`,
    title: host,
    host,
    visitedAt: '2026-01-01T00:00:00.000Z',
    score,
    snippet: '',
    chunk: 0,
    matches: 1,
  };
}

const RULE: StrengthRule = { floor: 0.48, lowFloor: 0.3, minGap: 0.15, minOverlap: 0.6, margin: 0.05 };

function pageWith(host: string, score: number, snippet: string): PageResult {
  return { ...page(host, score), snippet };
}

test('splitByStrength: a top page above the floor is strong; others need the floor AND the margin', () => {
  const { strong, weak } = splitByStrength(
    [page('a', 0.62), page('b', 0.59), page('c', 0.55), page('d', 0.3)],
    '',
    RULE,
  );
  assert.deepEqual(strong.map((r) => r.host), ['a', 'b']);
  assert.deepEqual(weak.map((r) => r.host), ['c', 'd'], 'c clears the floor but is 0.07 below the top');
});

test('splitByStrength: below the floor, a top page that leads the runner-up by the gap is strong', () => {
  const lead = splitByStrength([page('a', 0.4), page('b', 0.24)], '', RULE);
  assert.deepEqual(lead.strong.map((r) => r.host), ['a']);
  const close = splitByStrength([page('a', 0.4), page('b', 0.3)], '', RULE);
  assert.deepEqual(close.strong, [], 'a lead of 0.10 is not enough');
  const alone = splitByStrength([page('a', 0.35)], '', RULE);
  assert.deepEqual(alone.strong.map((r) => r.host), ['a'], 'a single result leads by its whole score');
});

test('splitByStrength: below the floor, a top page whose best passage holds most query words is strong', () => {
  const results = [
    pageWith('a', 0.36, 'Bleached coral turns white when the sea is warm.'),
    page('b', 0.33),
  ];
  assert.deepEqual(splitByStrength(results, 'why does coral turn white', RULE).strong.map((r) => r.host), ['a']);
  assert.deepEqual(splitByStrength(results, 'tax returns for freelancers', RULE).strong, [], 'no shared words');
  assert.deepEqual(splitByStrength(results, '', RULE).strong, [], 'no query: scores only');
});

test('splitByStrength: nothing strong under the low floor, whatever stands out; empty input; order kept', () => {
  const { strong, weak } = splitByStrength(
    [pageWith('a', 0.29, 'coral white sea'), page('b', 0.05)],
    'coral white sea',
    RULE,
  );
  assert.deepEqual(strong, []);
  assert.deepEqual(weak.map((r) => r.host), ['a', 'b']);
  assert.deepEqual(splitByStrength([]), { strong: [], weak: [] });
});

test('splitByStrength: if the top page is not strong, a lower page above the floor is not either', () => {
  // Cannot happen with sorted input; guards the invariant "nothing strong without a strong top".
  const { strong } = splitByStrength([page('a', 0.47), page('b', 0.46)], '', RULE);
  assert.deepEqual(strong, []);
});

test('STRENGTH_RULE is the measured rule', () => {
  assert.deepEqual(STRENGTH_RULE, RULE);
});

test('queryOverlap: share of query content words found in the passage', () => {
  assert.equal(queryOverlap('why do corals turn white', 'The coral turns white.'), 1);
  assert.equal(queryOverlap('coral reef temperature', 'A reef.'), 1 / 3);
  assert.equal(queryOverlap('the and of', 'anything'), 0, 'stopwords only');
});

test('contentWords drops stopwords and short words and folds simple endings', () => {
  assert.deepEqual([...contentWords('Why do the reefs turn white when the sea warms?')].sort(), [
    'reef',
    'sea',
    'turn',
    'warm',
    'white',
  ]);
  assert.ok(contentWords('feeding').has('feed'));
  assert.ok(contentWords('bleached').has('bleach'));
});

const PASSAGE =
  'Reef-building corals live with algae. The algae give corals their colour.\n' +
  'When the water stays warm for weeks, the coral expels them. Without its algae the coral turns white: it has bleached. ' +
  'Bleached coral is not dead.';

test('snippetFor starts at the sentence with the most query words and marks it', () => {
  const s = snippetFor(PASSAGE, 'why do reefs turn white when the sea gets warmer');
  assert.equal(s.mark, 'Without its algae the coral turns white: it has bleached.');
  assert.equal(s.lead, true);
  assert.equal(s.rest, ' Bleached coral is not dead.');
  assert.equal(s.cut, false);
});

test('snippetFor: earliest sentence wins a tie; no shared word → passage start, nothing marked', () => {
  assert.equal(snippetFor('Alpha beta. Gamma beta. Delta.', 'beta').mark, 'Alpha beta.');
  const none = snippetFor(PASSAGE, 'xylophone quartz');
  assert.deepEqual(
    { lead: none.lead, mark: none.mark },
    { lead: false, mark: '' },
  );
  assert.ok(none.rest.startsWith('Reef-building corals live with algae.'));
});

test('snippetFor caps length on a word boundary', () => {
  const long = `${'word '.repeat(200)}target sentence here. ${'tail '.repeat(200)}`;
  const s = snippetFor(long, 'target', 120);
  assert.ok(s.mark.length + s.rest.length <= 120);
  assert.equal(s.cut, true);
  assert.ok(!/\s$/.test(s.rest));
  const short = snippetFor('One target here. Then the rest of it goes on and on and on.', 'target', 25);
  assert.equal(short.mark, 'One target here.');
  assert.equal(short.rest, ' Then the');
  assert.equal(short.cut, true);
});

test('passageLink anchors at the marked sentence when given it', () => {
  const s = snippetFor(PASSAGE, 'coral turns white');
  assert.equal(
    passageLink('https://ocean.test/c', s.mark),
    'https://ocean.test/c#:~:text=Without%20its%20algae%20the%20coral%20turns%20white%3A%20it',
  );
});

test('omniboxSuggestions: strong pages only, linking to and showing the matched sentence', () => {
  const hits: Hit[] = [
    {
      ...hit('https://ocean.test/c', 0, 0.64),
      text: 'Corals host algae. When warm water lingers the reef turns white and starves.',
    },
    hit('https://bike.test/chain', 0, 0.2),
  ];
  const out = omniboxSuggestions(hits, 'why does the reef turn white');
  assert.equal(out.length, 1, 'the 0.2 page is weak: no suggestion');
  assert.equal(out[0]!.title, 'Title of https://ocean.test/c');
  assert.equal(out[0]!.detail, 'ocean.test: When warm water lingers the reef turns white and starves.');
  assert.equal(
    out[0]!.content,
    'https://ocean.test/c#:~:text=When%20warm%20water%20lingers%20the%20reef%20turns%20white',
  );
  assert.deepEqual(
    omniboxSuggestions([hit('https://x.test/', 0, 0.3), hit('https://y.test/', 0, 0.28)], 'anything'),
    [],
    'nothing strong, nothing suggested',
  );
});
