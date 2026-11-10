/**
 * Scale benchmark of the built extension: index a few thousand passages
 * through the real path (service worker → offscreen store host → ferrovec
 * worker → OPFS), then measure what a long-lived store does.
 *
 *   node test/e2e/bench.ts [pages=320]
 *
 * Pages are synthetic (deterministic text sampled from the fixture articles'
 * vocabulary, varied lengths, up to 12 passages each), sent to the service
 * worker the way the content script sends them, with backpressure so the host
 * queue never drops a job. Reports:
 *
 * - per-page index time, in buckets of 40 pages as the store grows (p50/p95/max:
 *   a strict-mode store checkpoints, i.e. rewrites the whole snapshot, every
 *   ~2000 log records or 4 MiB of log, which shows up as max);
 * - store size on disk (OPFS) along the way;
 * - query latency at full size;
 * - churn: re-index 20% of the pages with changed text, size before/after
 *   compaction, and how long compaction takes;
 * - restart: time to reopen the store (model load + snapshot + log replay)
 *   and answer the first query.
 *
 * Writes test/e2e/.out/bench-results.json.
 */

import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Page } from 'playwright';

import { ARTICLES } from './fixtures.ts';
import { OUT, bg, dirSize, DIST, extensionId, launch, mb, percentile, sleep, startProxy } from './harness.ts';

const PAGES = Number(process.argv[2] ?? 320);
const BUCKET = 40;
const MAX_IN_FLIGHT = 40;

/** Deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const VOCAB = [
  ...new Set(
    ARTICLES.flatMap((a) => a.paragraphs)
      .join(' ')
      .toLowerCase()
      .replace(/[^a-z\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2),
  ),
];

function syntheticPage(i: number, version = 0): { url: string; title: string; text: string } {
  const r = rng(i * 7919 + version * 104729 + 1);
  const pick = (): string => VOCAB[Math.floor(r() * VOCAB.length)]!;
  // 400 to 3000 words: 2 to 12 passages after chunking (most pages hit the cap).
  const targetWords = 400 + Math.floor(r() * 2600);
  const paragraphs: string[] = [];
  let words = 0;
  while (words < targetWords) {
    const sentences: string[] = [];
    const n = 3 + Math.floor(r() * 4);
    for (let s = 0; s < n; s++) {
      const len = 10 + Math.floor(r() * 16);
      const ws = Array.from({ length: len }, pick);
      ws[0] = ws[0]![0]!.toUpperCase() + ws[0]!.slice(1);
      sentences.push(`${ws.join(' ')}.`);
      words += len;
    }
    paragraphs.push(sentences.join(' '));
  }
  return {
    url: `http://bench${i % 37}.test/article/${i}`,
    title: `Synthetic article ${i}${version ? ` (rev ${version})` : ''}`,
    text: paragraphs.join('\n'),
  };
}

interface Status {
  pending: number;
  busy: boolean;
  indexed: number;
  jobMs: number[];
  jobChunks: number[];
  lastError: string | null;
  openMs: number | null;
  compactMs: number[];
}
interface Stats {
  pages: number;
  passages: number;
  storeBytes: number | null;
  storeFiles: Record<string, number> | null;
  usageBytes: number | null;
}

async function sendPage(ui: Page, page: { url: string; title: string; text: string }): Promise<void> {
  await bg(ui, { kind: 'page', page: { ...page, lang: 'en' } });
}

/** Send pages with backpressure: never more than MAX_IN_FLIGHT waiting in the host queue. */
async function indexAll(ui: Page, pages: Array<{ url: string; title: string; text: string }>, onBucket?: (done: number) => Promise<void>): Promise<void> {
  const base = (await bg<Status>(ui, { kind: 'status' })).indexed;
  let sent = 0;
  let nextBucket = BUCKET;
  while (sent < pages.length) {
    const status = await bg<Status>(ui, { kind: 'status' });
    if (status.lastError) throw new Error(status.lastError);
    const done = status.indexed - base;
    if (onBucket && done >= nextBucket) {
      await onBucket(done);
      nextBucket += BUCKET;
    }
    const room = MAX_IN_FLIGHT - status.pending;
    for (let i = 0; i < room && sent < pages.length; i++) await sendPage(ui, pages[sent++]!);
    await sleep(200);
  }
  await bg(ui, { kind: 'wait-idle', timeoutMs: 600_000 });
  if (onBucket) await onBucket((await bg<Status>(ui, { kind: 'status' })).indexed - base);
}

async function main(): Promise<void> {
  await rm(join(OUT, 'bench-profile'), { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });
  const proxy = await startProxy(new Map());
  const profile = join(OUT, 'bench-profile');
  let context = await launch(profile, proxy.port);
  let id = await extensionId(context);
  let ui = await context.newPage();
  await ui.goto(`chrome-extension://${id}/search.html`);

  const pages = Array.from({ length: PAGES }, (_, i) => syntheticPage(i));
  const growth: Array<{ pages: number; passages: number; storeBytes: number | null }> = [];
  const t0 = performance.now();
  await indexAll(ui, pages, async () => {
    const s = await bg<Stats>(ui, { kind: 'stats' });
    growth.push({ pages: s.pages, passages: s.passages, storeBytes: s.storeBytes });
    console.log(`  ${s.pages} pages, ${s.passages} passages, OPFS ${mb(s.storeBytes)}`);
  });
  const totalMs = performance.now() - t0;
  const status = await bg<Status>(ui, { kind: 'status' });
  const stats = await bg<Stats>(ui, { kind: 'stats' });

  const buckets: Array<{ pages: string; passages: number; p50: number; p95: number; max: number; msPerPassage: number }> = [];
  for (let i = 0; i < status.jobMs.length; i += BUCKET) {
    const ms = status.jobMs.slice(i, i + BUCKET);
    const chunks = status.jobChunks.slice(i, i + BUCKET);
    const passages = chunks.reduce((a, b) => a + b, 0);
    buckets.push({
      pages: `${i + 1}-${i + ms.length}`,
      passages,
      p50: percentile(ms, 50),
      p95: percentile(ms, 95),
      max: Math.max(...ms),
      msPerPassage: Math.round((ms.reduce((a, b) => a + b, 0) / passages) * 10) / 10,
    });
  }

  // Query latency at full size (through the service worker, k = 60 like the search page).
  const queries = ARTICLES.map((a) => a.query!).concat(ARTICLES.map((a) => a.title));
  const queryMs: number[] = [];
  for (const q of queries) {
    const t = performance.now();
    await bg(ui, { kind: 'search', q, k: 60 });
    queryMs.push(performance.now() - t);
  }

  // Churn: 20% of pages change; their old passages become tombstones.
  const churn = pages.slice(0, Math.floor(PAGES / 5)).map((p, i) => ({ ...syntheticPage(i, 1), url: p.url }));
  const beforeChurn = await bg<Stats>(ui, { kind: 'stats' });
  await indexAll(ui, churn);
  const afterChurn = await bg<Stats>(ui, { kind: 'stats' });
  // Forget one synthetic host: removes its passages and compacts the store.
  const tForget = performance.now();
  const forgot = await bg<{ pages: number; passages: number }>(ui, { kind: 'forget-host', host: 'bench0.test' });
  const forgetMs = performance.now() - tForget;
  const afterCompact = await bg<Stats>(ui, { kind: 'stats' });
  const compactMs = (await bg<Status>(ui, { kind: 'status' })).compactMs;

  // Restart: reopen the store from OPFS and answer one query.
  await context.close();
  context = await launch(profile, proxy.port);
  id = await extensionId(context);
  ui = await context.newPage();
  await ui.goto(`chrome-extension://${id}/search.html`);
  const tReopen = performance.now();
  await bg(ui, { kind: 'search', q: ARTICLES[0]!.query!, k: 60 });
  const firstQueryAfterRestartMs = performance.now() - tReopen;
  const reopenStatus = await bg<Status>(ui, { kind: 'status' });
  const reopenStats = await bg<Stats>(ui, { kind: 'stats' });
  await context.close();
  await proxy.close();

  const results = {
    pages: stats.pages,
    passages: stats.passages,
    totalIndexSeconds: Math.round(totalMs / 100) / 10,
    passagesPerSecond: Math.round((stats.passages / (totalMs / 1000)) * 10) / 10,
    perPageMs: {
      p50: percentile(status.jobMs, 50),
      p95: percentile(status.jobMs, 95),
      max: Math.max(...status.jobMs),
    },
    buckets,
    growth,
    storeBytes: stats.storeBytes,
    usageBytes: stats.usageBytes,
    bytesPerPassage: stats.storeBytes ? Math.round(stats.storeBytes / stats.passages) : null,
    queryMs: { p50: Math.round(percentile(queryMs, 50)), p95: Math.round(percentile(queryMs, 95)) },
    churn: {
      reindexedPages: churn.length,
      before: beforeChurn,
      afterReindex: afterChurn,
      forgot,
      forgetWithCompactMs: Math.round(forgetMs),
      compactMs,
      afterCompact,
    },
    restart: {
      openMs: reopenStatus.openMs,
      firstQueryAfterRestartMs: Math.round(firstQueryAfterRestartMs),
      passages: reopenStats.passages,
    },
    distBytes: await dirSize(DIST),
  };
  await writeFile(join(OUT, 'bench-results.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
