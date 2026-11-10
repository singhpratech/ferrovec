/**
 * Measure real relevance scores (MiniLM q8 in the built extension) on the
 * fixture articles, to choose and check the strong/weak cutoff in
 * src/lib/group.ts. `npm run build` first, then:
 *
 *   node test/e2e/scores.ts
 *
 * Indexes the eight fixture articles through the service worker, runs
 * on-topic queries (the e2e query per article, plus a second, held-out
 * paraphrase) and off-topic queries (no fixture covers them), groups the hits
 * by page exactly as the UI does, and prints:
 *
 * - for on-topic queries: the expected page's score, the best other page's
 *   score, and the gap between them;
 * - for off-topic queries: the top page's score;
 * - how the current thresholds classify every result.
 *
 * Writes test/e2e/.out/scores.json.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { groupHits, splitByStrength, STRONG_MARGIN, STRONG_MIN_SCORE } from '../../src/lib/group.ts';
import type { Hit } from '../../src/lib/types.ts';
import { ARTICLES, fixtureUrl } from './fixtures.ts';
import { OUT, bg, extensionId, launch, startProxy } from './harness.ts';

/** A second paraphrase per article, never used to pick the thresholds' shape by hand. */
export const HELD_OUT: Record<string, string> = {
  'astro.test': 'can anything get back out once it falls past the point of no return around a dead star',
  'bread.test': 'my jar of fermented flour paste has grey liquid on top, is it still alive',
  'garden.test': 'sunken dark patches underneath the fruit in my vegetable garden',
  'history.test': 'how did the empire supply its capital with fresh water from distant springs',
  'cycling.test': 'what oil to put on the chain of my road bike and how often',
  'ocean.test': 'why do reefs turn white when the sea gets warmer',
  'music.test': 'practising lines over the ii V I progression to get better at soloing',
  'code.test': 'why does my program fail to compile when I use a variable after moving it',
};

/** Topics no fixture covers. */
export const OFF_TOPIC = [
  'best way to train for a marathon in sixteen weeks',
  'how do mrna vaccines teach the immune system',
  'tax deductions for freelance graphic designers',
  'architecture of medieval castles and their defences',
  'how to negotiate a higher salary at a job offer',
  'what is the capital of australia',
  'symptoms of vitamin d deficiency in winter',
  'comparing electric cars and hybrids for long commutes',
  'knitting a scarf for beginners',
  'how does the stock market react to interest rate rises',
];

/**
 * Written after the thresholds were chosen, to check them on queries they
 * were not fitted to.
 */
export const VALIDATION_ON: Record<string, string> = {
  'astro.test': 'gravitational waves from two merging dark stellar remnants',
  'bread.test': 'keeping my rye leaven in the fridge between weekend bakes',
  'garden.test': 'mulching and steady watering to stop the fruit rotting',
  'history.test': 'lead pipes and siphons used to cross deep valleys in antiquity',
  'cycling.test': 'when to replace a worn bicycle chain before it ruins the cassette',
  'ocean.test': 'algae living inside coral tissue and what happens in a heatwave',
  'music.test': 'learning bebop phrases by transcribing saxophone solos',
  'code.test': 'borrow checker errors about mutable and shared references',
};
export const VALIDATION_OFF = [
  'how to repot an orchid',
  'history of the printing press',
  'photosynthesis in desert cacti',
  'best budget noise cancelling headphones',
  'learning to swim as an adult',
];

interface Row {
  kind: 'on-topic' | 'held-out' | 'off-topic' | 'valid-on' | 'valid-off';
  query: string;
  expected?: string;
  expectedScore?: number;
  bestOther?: number;
  top: number;
  ranked: Array<{ host: string; score: number }>;
  strong: string[];
}

async function main(): Promise<void> {
  await mkdir(OUT, { recursive: true });
  const proxy = await startProxy(new Map());
  const profile = await mkdtemp(join(OUT, 'scores-profile-'));
  const context = await launch(profile, proxy.port);
  try {
    const id = await extensionId(context);
    const ui = await context.newPage();
    await ui.goto(`chrome-extension://${id}/search.html`);
    for (const f of ARTICLES) {
      await bg(ui, {
        kind: 'page',
        page: { url: fixtureUrl(f), title: f.title, text: f.paragraphs.join('\n'), lang: 'en' },
      });
    }
    await bg(ui, { kind: 'wait-idle', timeoutMs: 120_000 });

    const rows: Row[] = [];
    const run = async (kind: Row['kind'], query: string, expected?: string): Promise<void> => {
      const hits = await bg<Hit[]>(ui, { kind: 'search', q: query, k: 60 });
      const pages = groupHits(hits);
      const { strong } = splitByStrength(pages);
      const ranked = pages.map((p) => ({ host: p.host, score: Math.round(p.score * 1000) / 1000 }));
      const row: Row = { kind, query, top: ranked[0]?.score ?? 0, ranked, strong: strong.map((p) => p.host) };
      if (expected) {
        row.expected = expected;
        row.expectedScore = ranked.find((r) => r.host === expected)?.score ?? 0;
        row.bestOther = Math.max(0, ...ranked.filter((r) => r.host !== expected).map((r) => r.score));
      }
      rows.push(row);
    };
    for (const f of ARTICLES) await run('on-topic', f.query!, f.host);
    for (const f of ARTICLES) await run('held-out', HELD_OUT[f.host]!, f.host);
    for (const q of OFF_TOPIC) await run('off-topic', q);
    for (const f of ARTICLES) await run('valid-on', VALIDATION_ON[f.host]!, f.host);
    for (const q of VALIDATION_OFF) await run('valid-off', q);

    const fmt = (n: number | undefined): string => (n ?? 0).toFixed(3);
    console.log(`thresholds: floor ${STRONG_MIN_SCORE}, margin ${STRONG_MARGIN}\n`);
    for (const r of rows) {
      const detail =
        r.expected !== undefined
          ? `expected ${r.expected} ${fmt(r.expectedScore)}  best other ${fmt(r.bestOther)}  gap ${fmt((r.expectedScore ?? 0) - (r.bestOther ?? 0))}`
          : `top ${r.ranked[0]?.host} ${fmt(r.top)}  second ${fmt(r.ranked[1]?.score)}`;
      const ok =
        r.expected !== undefined
          ? r.strong.length === 1 && r.strong[0] === r.expected
          : r.strong.length === 0;
      console.log(`${ok ? 'ok ' : 'BAD'} ${r.kind.padEnd(9)} ${detail}  strong=[${r.strong.join(', ')}]  "${r.query}"`);
    }
    const fitted = rows.filter((r) => !r.kind.startsWith('valid'));
    const matching = fitted.filter((r) => r.expected).map((r) => r.expectedScore!);
    const nonMatching = fitted.filter((r) => r.expected).map((r) => r.bestOther!);
    const offTop = fitted.filter((r) => !r.expected).map((r) => r.top);
    const summary = (xs: number[]): string =>
      `min ${fmt(Math.min(...xs))}  median ${fmt([...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)])}  max ${fmt(Math.max(...xs))}`;
    console.log(`\nmatching page score:               ${summary(matching)}`);
    console.log(`best non-matching (on-topic query): ${summary(nonMatching)}`);
    console.log(`top page (off-topic query):         ${summary(offTop)}`);
    const correct = (r: Row): boolean =>
      r.expected !== undefined ? r.strong.length === 1 && r.strong[0] === r.expected : r.strong.length === 0;
    for (const [label, set] of [
      ['fitted', fitted],
      ['validation', rows.filter((r) => r.kind.startsWith('valid'))],
    ] as const) {
      console.log(`${label}: ${set.filter(correct).length}/${set.length} classified as intended`);
    }
    await writeFile(join(OUT, 'scores.json'), JSON.stringify(rows, null, 2));
  } finally {
    await context.close();
    await proxy.close();
    await rm(profile, { recursive: true, force: true });
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
