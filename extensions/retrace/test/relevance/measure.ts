/**
 * Real-content relevance measurement (not part of the offline e2e).
 *
 *   node test/relevance/fetch.ts                      # once: cache the pages
 *   npm run build
 *   node test/relevance/measure.ts [variant]          # variant: passage (default) | title
 *
 * 1. Index: a fresh profile; every cached page is opened in a tab, so the real
 *    content script (Readability) extracts it and the real store host chunks
 *    and embeds it. The proxy serves the cached HTML; nothing else is fetched.
 * 2. Export what was indexed (passage texts per page) to
 *    .results/indexed-<variant>.json, so each query's evidence can be checked
 *    against what the 12-passage cap actually kept.
 * 3. Run every query in queries.ts through the service worker (k = 60, as the
 *    search page does) and save the raw passage hits to
 *    .results/hits-<variant>.json for analyze.ts.
 *
 * `variant` selects what is embedded per passage (see src/lib/embed.ts):
 * the passage alone, or "title. passage". It is set through the extension's
 * `retrace.embedFormat` localStorage override before the store host starts.
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { BrowserContext, Page } from 'playwright';

import type { Hit } from '../../src/lib/types.ts';
import { bg, extensionId, launch, sleep, startProxy } from '../e2e/harness.ts';
import { CACHE, RESULTS, cachePath } from './cache.ts';
import { PAGES, servedUrl } from './pages.ts';
import { ALL_QUERIES } from './queries.ts';

const variant = process.argv[2] ?? 'passage';
if (variant !== 'passage' && variant !== 'title') throw new Error(`unknown variant ${variant}`);

interface PageRecord {
  url: string;
  visitedAt: string;
}

async function visit(context: BrowserContext, ui: Page, url: string): Promise<boolean> {
  const tab = await context.newPage();
  const startedAt = Date.now();
  try {
    await tab.goto(url, { waitUntil: 'load', timeout: 60_000 });
  } catch {
    // Subresources are refused by the proxy; the document itself is what matters.
  }
  // Keep the tab open until this page itself is indexed (its bookkeeping record
  // appears), so the measurement never depends on the content script's
  // close-time fallback.
  const deadline = Date.now() + 90_000;
  let ok = false;
  while (Date.now() < deadline) {
    const pages = await bg<PageRecord[]>(ui, { kind: 'pages', limit: 200 });
    if (pages.some((p) => p.url === url && Date.parse(p.visitedAt) >= startedAt)) {
      ok = true;
      break;
    }
    await sleep(250);
  }
  await tab.close();
  return ok;
}

async function main(): Promise<void> {
  await mkdir(RESULTS, { recursive: true });
  const served = new Map<string, string>();
  for (const page of PAGES) served.set(servedUrl(page), await readFile(cachePath(page), 'utf8'));
  const manifest = JSON.parse(await readFile(join(CACHE, 'manifest.json'), 'utf8')) as Record<string, { fetchedAt: string }>;

  const proxy = await startProxy(served);
  const profile = join(RESULTS, `profile-${variant}`);
  await rm(profile, { recursive: true, force: true });
  const context = await launch(profile, proxy.port);
  try {
    const id = await extensionId(context);
    // Set the embedding format before anything starts the store host.
    const setup = await context.newPage();
    await setup.goto(`chrome-extension://${id}/manifest.json`);
    await setup.evaluate((v) => localStorage.setItem('retrace.embedFormat', v), variant);
    await setup.close();

    const ui = await context.newPage();
    await ui.goto(`chrome-extension://${id}/search.html`);
    const t0 = performance.now();
    const missed: string[] = [];
    for (const page of PAGES) {
      if (!(await visit(context, ui, servedUrl(page)))) missed.push(page.id);
    }
    await bg(ui, { kind: 'wait-idle', timeoutMs: 600_000 });
    const indexMs = performance.now() - t0;
    const status = await bg<{ lastError: string | null; jobChunks: number[] }>(ui, { kind: 'status' });
    console.log(`indexed in ${(indexMs / 1000).toFixed(0)} s; not indexed: ${missed.join(', ') || 'none'}; lastError: ${status.lastError}`);

    // What was actually indexed, per page.
    const exported = await bg<{ passages: Array<{ id: string; text: string; metadata?: { url?: string; title?: string } }> }>(ui, {
      kind: 'export',
    });
    const byUrl = new Map(PAGES.map((p) => [servedUrl(p), p.id]));
    const indexed: Record<string, { title: string; passages: string[] }> = {};
    for (const row of exported.passages) {
      const pageId = byUrl.get(row.metadata?.url ?? '') ?? row.metadata?.url ?? '?';
      indexed[pageId] ??= { title: row.metadata?.title ?? '', passages: [] };
      indexed[pageId]!.passages.push(row.text);
    }
    await writeFile(join(RESULTS, `indexed-${variant}.json`), JSON.stringify(indexed, null, 2));
    console.log(`${exported.passages.length} passages from ${Object.keys(indexed).length} pages`);

    // Queries.
    const hits: Record<string, Hit[]> = {};
    for (const q of ALL_QUERIES) hits[q.query] = await bg<Hit[]>(ui, { kind: 'search', q: q.query, k: 60 });
    await writeFile(
      join(RESULTS, `hits-${variant}.json`),
      JSON.stringify(
        {
          variant,
          measuredAt: new Date().toISOString(),
          fetchedAt: manifest,
          pages: Object.fromEntries(PAGES.map((p) => [p.id, servedUrl(p)])),
          passages: exported.passages.length,
          indexSeconds: Math.round(indexMs / 1000),
          hits,
        },
        null,
        1,
      ),
    );
    console.log(`${ALL_QUERIES.length} queries → .results/hits-${variant}.json`);
  } finally {
    await context.close();
    await proxy.close();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
