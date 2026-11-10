/**
 * End-to-end run of the built extension (`npm run build` first) in Playwright's
 * Chromium, new headless mode, with `--load-extension`:
 *
 *  1. visit eight fixture articles on distinct hosts, plus a page on a
 *     blocklisted host and a page with a password field;
 *  2. wait for indexing; check paraphrased queries rank the right page first
 *     through the search page UI;
 *  3. check the blocked page and the password page were not indexed;
 *  4. revisit an unchanged page: visit time bumps, nothing is re-embedded;
 *  5. restart the browser on the same profile: results persist;
 *  6. "Forget this site" through the UI: its results are gone, and its text is
 *     no longer anywhere in the profile directory;
 *  7. "Delete everything" through the UI;
 *  8. every network request Chromium made went through a logging proxy; none
 *     left for a non-fixture host unless Chromium's NetLog attributes it to the
 *     browser itself (no initiating origin), and no request was initiated by
 *     the extension at all.
 *
 * Writes test/e2e/.out/e2e-results.json and exits non-zero on any failure.
 */

import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { BrowserContext, Page } from 'playwright';

import { urlHash } from '../../src/lib/hash.ts';
import { ARTICLES, BLOCKED, LOGIN, fixtureUrl, renderFixture, type Fixture } from './fixtures.ts';
import {
  DIST,
  OUT,
  bg,
  dirSize,
  extensionId,
  launch,
  mb,
  sleep,
  startProxy,
  type Proxy,
} from './harness.ts';

interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}
const checks: Check[] = [];
function check(name: string, ok: boolean, detail?: string): void {
  checks.push({ name, ok, ...(detail === undefined ? {} : { detail }) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

interface Status {
  pending: number;
  busy: boolean;
  indexed: number;
  unchanged: number;
  jobMs: number[];
  jobChunks: number[];
  lastError: string | null;
  openMs: number | null;
}
interface PageRecord {
  url: string;
  host: string;
  visitedAt: string;
  chunks: number;
}
interface Stats {
  pages: number;
  passages: number;
  usageBytes: number | null;
  storeBytes: number | null;
  persistent: boolean;
}

const profileDir = join(OUT, 'profile');

/** A further article on its own host, for the pause/resume check. */
const PAUSED_PAGE: Fixture = { ...ARTICLES[3]!, host: 'paused.test', title: 'An article read while paused' };

async function hostDocuments(ui: Page): Promise<number> {
  return ui.evaluate(async () => (await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT' as chrome.runtime.ContextType] })).length);
}
const netlogs: string[] = [];

async function start(proxy: Proxy, label: string): Promise<{ context: BrowserContext; id: string; ui: Page }> {
  const netlog = join(OUT, `netlog-${label}.json`);
  netlogs.push(netlog);
  const context = await launch(profileDir, proxy.port, [`--log-net-log=${netlog}`]);
  const id = await extensionId(context);
  for (const sw of context.serviceWorkers()) {
    sw.on('console', (m) => console.log(`  [service worker ${m.type()}] ${m.text()}`));
  }
  const ui = await context.newPage();
  ui.on('console', (m) => {
    if (m.type() === 'error') console.log(`  [search page] ${m.text()}`);
  });
  await ui.goto(`chrome-extension://${id}/search.html`);
  return { context, id, ui };
}

/** Search through the real search page and return the result URLs in order. */
async function searchUi(ui: Page, id: string, q: string): Promise<{ urls: string[]; ms: number }> {
  const t0 = performance.now();
  await ui.goto(`chrome-extension://${id}/search.html?q=${encodeURIComponent(q)}`);
  await ui.waitForFunction(
    () =>
      document.body.dataset.state === 'ready' &&
      document.getElementById('results-heading')?.textContent === 'Results',
    undefined,
    { timeout: 60_000 },
  );
  const ms = Math.round(performance.now() - t0);
  const urls = await ui.$$eval('#results li', (lis) => lis.map((li) => (li as HTMLElement).dataset.url ?? ''));
  return { urls, ms };
}

/**
 * Open `f` in a tab and keep it open until Retrace has queued it (`ui` sees
 * its bookkeeping, or the host's job count rises) or, for a page that must
 * not be indexed, until well past the content script's 3 s idle timeout.
 */
async function visit(context: BrowserContext, ui: Page, f: Fixture, expectIndexed: boolean): Promise<void> {
  const tab = await context.newPage();
  tab.on('console', (m) => {
    if (m.text().includes('[retrace]')) console.log(`  [${f.host} ${m.type()}] ${m.text()}`);
  });
  const before = await bg<Status>(ui, { kind: 'status' });
  await tab.goto(fixtureUrl(f), { waitUntil: 'load' });
  if (!expectIndexed) {
    await sleep(4000);
  } else {
    const deadline = Date.now() + 30_000;
    for (;;) {
      const status = await bg<Status>(ui, { kind: 'status' });
      const pages = await bg<PageRecord[]>(ui, { kind: 'pages', limit: 100 });
      const record = pages.find((p) => p.url === fixtureUrl(f));
      const fresh = record && Date.parse(record.visitedAt) > Date.now() - 30_000;
      if (fresh || status.indexed > before.indexed || status.pending > before.pending) break;
      if (Date.now() > deadline) {
        console.log(`  ${f.host}: not queued within 30 s`);
        break;
      }
      await sleep(200);
    }
  }
  await tab.close();
}

async function waitForPages(ui: Page, n: number, timeoutMs = 120_000): Promise<PageRecord[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await bg(ui, { kind: 'wait-idle', timeoutMs: 60_000 });
    const pages = await bg<PageRecord[]>(ui, { kind: 'pages', limit: 100 });
    if (pages.length >= n || Date.now() > deadline) return pages;
    await sleep(250);
  }
}

/**
 * Is `relPath` (relative to the profile) part of Retrace's own storage? OPFS
 * (`File System`), and every store keyed by the extension's origin or id
 * (IndexedDB bookkeeping, chrome.storage.local, extension state). The browser's
 * HTTP cache, history and session files hold what any visited page leaves
 * behind, Retrace or not, and are reported separately.
 */
function isRetraceStorage(relPath: string, extId: string): boolean {
  return relPath.includes('File System') || relPath.includes(extId);
}

/** Search the files under `dir` for `needle` (UTF-8). */
async function filesContaining(dir: string, needle: string): Promise<string[]> {
  const hits: string[] = [];
  const bytes = Buffer.from(needle, 'utf8');
  const walk = async (d: string): Promise<void> => {
    for (const entry of await readdir(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) await walk(p);
      else if (entry.isFile()) {
        try {
          if ((await stat(p)).size > 200 * 1024 * 1024) continue;
          if ((await readFile(p)).includes(bytes)) hits.push(p.slice(dir.length + 1));
        } catch {
          /* locked or vanished */
        }
      }
    }
  };
  await walk(dir);
  return hits;
}

interface NetRequest {
  url: string;
  method: string;
  initiator: string | null;
}

/** URL requests in a Chromium NetLog with their initiator (`'not an origin'` = the browser itself). */
async function netlogRequests(path: string): Promise<NetRequest[]> {
  let text = await readFile(path, 'utf8');
  // A NetLog of a browser that was killed may lack its closing brackets.
  if (!text.trimEnd().endsWith('}')) text = text.replace(/,\s*$/, '') + ']}';
  const log = JSON.parse(text) as {
    constants: { logEventTypes: Record<string, number> };
    events: Array<{ type: number; params?: { url?: string; method?: string; initiator?: string } }>;
  };
  const startJob = log.constants.logEventTypes['URL_REQUEST_START_JOB'];
  return log.events
    .filter((e) => e.type === startJob && e.params?.url)
    .map((e) => ({ url: e.params!.url!, method: e.params!.method ?? '', initiator: e.params!.initiator ?? null }));
}

async function main(): Promise<void> {
  await stat(join(DIST, 'manifest.json')).catch(() => {
    throw new Error('dist/ is missing: run `npm run build` first');
  });
  await mkdir(OUT, { recursive: true });
  await rm(profileDir, { recursive: true, force: true });

  const pages = new Map<string, string>();
  for (const f of [...ARTICLES, BLOCKED, LOGIN, PAUSED_PAGE]) pages.set(fixtureUrl(f), renderFixture(f));
  const proxy = await startProxy(pages);
  const results: Record<string, unknown> = {};

  // ---- session 1: index ---------------------------------------------------
  let { context, id, ui } = await start(proxy, 'session1');
  console.log(`extension ${id}`);
  const tVisit = performance.now();
  for (const f of ARTICLES) await visit(context, ui, f, true);
  for (const f of [BLOCKED, LOGIN]) await visit(context, ui, f, false);
  const indexedPages = await waitForPages(ui, ARTICLES.length);
  const wallMs = Math.round(performance.now() - tVisit);
  const status1 = await bg<Status>(ui, { kind: 'status' });
  check('all eight articles indexed', indexedPages.length === ARTICLES.length, `${indexedPages.length} pages`);
  check('store host reported no error', status1.lastError === null, status1.lastError ?? undefined);
  results.indexing = {
    pages: indexedPages.length,
    passages: status1.jobChunks.reduce((a, b) => a + b, 0),
    modelLoadAndOpenMs: status1.openMs,
    perPageMs: status1.jobMs,
    passagesPerPage: status1.jobChunks,
    meanPerPageMs: Math.round(status1.jobMs.reduce((a, b) => a + b, 0) / status1.jobMs.length),
    wallClockForAllVisitsMs: wallMs,
  };

  const hosts = indexedPages.map((p) => p.host);
  check('blocklisted host not indexed', !hosts.includes(BLOCKED.host));
  check('password page not indexed', !hosts.includes(LOGIN.host));

  // ---- paraphrased queries through the search page -------------------------
  const queryResults: Array<{ query: string; expected: string; got: string[]; ms: number }> = [];
  for (const f of ARTICLES) {
    const { urls, ms } = await searchUi(ui, id, f.query!);
    queryResults.push({ query: f.query!, expected: fixtureUrl(f), got: urls.slice(0, 3), ms });
    check(`"${f.query}" → ${f.host} first`, urls[0] === fixtureUrl(f), `top: ${urls.slice(0, 3).join(', ')}; ${ms} ms`);
  }
  results.queries = queryResults;

  const bankQuery = await searchUi(ui, id, 'current account balance overdraft card transactions');
  check('blocked page absent from results', !bankQuery.urls.some((u) => u.includes(BLOCKED.host)));
  const loginQuery = await searchUi(ui, id, 'sign in to the gardening forum seed swaps');
  check('password page absent from results', !loginQuery.urls.some((u) => u.includes(LOGIN.host)));

  // ---- unchanged revisit ----------------------------------------------------
  const bread = ARTICLES.find((f) => f.host === 'bread.test')!;
  const before = indexedPages.find((p) => p.host === bread.host)!;
  await visit(context, ui, bread, true);
  await bg(ui, { kind: 'wait-idle', timeoutMs: 30_000 });
  const after = (await bg<PageRecord[]>(ui, { kind: 'pages', limit: 100 })).find((p) => p.host === bread.host)!;
  const status2 = await bg<Status>(ui, { kind: 'status' });
  check(
    'unchanged revisit bumps visitedAt without re-indexing',
    Date.parse(after.visitedAt) > Date.parse(before.visitedAt) && status2.indexed === status1.indexed,
    `visitedAt ${before.visitedAt} → ${after.visitedAt}; index jobs ${status1.indexed} → ${status2.indexed}`,
  );

  const stats1 = await bg<Stats>(ui, { kind: 'stats' });
  results.storeAfterIndexing = stats1;
  check('store is persistent (OPFS)', stats1.persistent);

  // ---- session 2: restart on the same profile ------------------------------
  await context.close();
  ({ context, id, ui } = await start(proxy, 'session2'));
  const tReopen = performance.now();
  const reopened = await searchUi(ui, id, ARTICLES[0]!.query!);
  const firstQueryAfterRestartMs = Math.round(performance.now() - tReopen);
  check('results persist across a browser restart', reopened.urls[0] === fixtureUrl(ARTICLES[0]!), `top: ${reopened.urls[0]}`);
  const stats2 = await bg<Stats>(ui, { kind: 'stats' });
  check('passage count unchanged after restart', stats2.passages === stats1.passages, `${stats1.passages} → ${stats2.passages}`);
  const status3 = await bg<Status>(ui, { kind: 'status' });
  results.restart = { firstQueryAfterRestartMs, openMs: status3.openMs };

  // ---- forget this site, through the UI -------------------------------------
  await ui.goto(`chrome-extension://${id}/search.html#privacy`);
  await ui.fill('#forget-host', bread.host);
  await ui.click('#forget-site-form button[type=submit]');
  await ui.waitForFunction(() => /^Forgot /.test(document.getElementById('forget-note')?.textContent ?? ''), undefined, {
    timeout: 60_000,
  });
  const forgetNote = await ui.textContent('#forget-note');
  const afterForget = await searchUi(ui, id, bread.query!);
  check('"Forget this site" removes its results', !afterForget.urls.some((u) => u.includes(bread.host)), forgetNote ?? '');
  const stats3 = await bg<Stats>(ui, { kind: 'stats' });
  check('pages count drops by one', stats3.pages === stats2.pages - 1, `${stats2.pages} → ${stats3.pages}`);
  const exported = await bg<{ passages: Array<{ text: string }> }>(ui, { kind: 'export' });
  check('export no longer contains the forgotten text', !exported.passages.some((p) => p.text.includes('hooch')));

  // Is anything of the forgotten page still on disk? OPFS and the extension's
  // own stores live in the profile directory.
  const forgottenStatus = await bg<{ compactMs: number[] }>(ui, { kind: 'status' });
  // Next session: a 3 s idle timeout, to exercise the host closing and coming back.
  await ui.evaluate(() => localStorage.setItem('retrace.hostIdleMs', '3000'));
  await context.close();
  const breadUrlHash = await urlHash(fixtureUrl(bread));
  const needles: Record<string, string> = {
    'passage text': 'called hooch',
    'passage id (vector tombstone)': `${breadUrlHash}:0`,
    url: 'bread.test/sourdough-starter',
    title: bread.title,
  };
  // The store (OPFS) must hold none of it. Text and passage ids must be gone
  // from every Retrace file. The URL and title also lived in the bookkeeping
  // record (IndexedDB); the record is deleted, but LevelDB keeps deleted
  // entries' bytes in its log until it compacts on its own schedule: recorded,
  // reported as a known limit, not asserted.
  const residue: Record<string, { retraceIndexedDb: string[]; browserOwnFiles: string[] }> = {};
  for (const [what, needle] of Object.entries(needles)) {
    const hits = await filesContaining(profileDir, needle);
    const inStore = hits.filter((h) => h.includes('File System'));
    const inRetrace = hits.filter((h) => isRetraceStorage(h, id));
    residue[what] = {
      retraceIndexedDb: inRetrace.filter((h) => !h.includes('File System')),
      browserOwnFiles: hits.filter((h) => !isRetraceStorage(h, id)),
    };
    const textOrId = what.startsWith('passage');
    const offending = textOrId ? inRetrace : inStore;
    check(
      `forgotten ${what} gone from ${textOrId ? "all of Retrace's storage" : 'the store (OPFS)'}`,
      offending.length === 0,
      offending.join(', ') || 'none',
    );
  }
  results.forget = { compactMs: forgottenStatus.compactMs, residue };

  // ---- session 3: delete everything ----------------------------------------
  ({ context, id, ui } = await start(proxy, 'session3'));

  // Pause: badge shows it, pages are not indexed; resume indexes again.
  await bg(ui, { kind: 'set-settings', patch: { paused: true } });
  await sleep(300);
  const badgePaused = await ui.evaluate(() => chrome.action.getBadgeText({}));
  await visit(context, ui, PAUSED_PAGE, false);
  const whilePaused = await bg<PageRecord[]>(ui, { kind: 'pages', limit: 100 });
  check('paused: badge says "off"', badgePaused === 'off', JSON.stringify(badgePaused));
  check('paused: a visited page is not indexed', !whilePaused.some((p) => p.host === PAUSED_PAGE.host));
  await bg(ui, { kind: 'set-settings', patch: { paused: false } });
  await sleep(300);
  const badgeResumed = await ui.evaluate(() => chrome.action.getBadgeText({}));
  await visit(context, ui, PAUSED_PAGE, true);
  await bg(ui, { kind: 'wait-idle', timeoutMs: 30_000 });
  const afterResume = await bg<PageRecord[]>(ui, { kind: 'pages', limit: 100 });
  check('resumed: badge cleared and the page is indexed', badgeResumed === '' && afterResume.some((p) => p.host === PAUSED_PAGE.host));

  // Idle: the offscreen store host closes itself, and the next request brings it back.
  await sleep(5000);
  const docsWhenIdle = await hostDocuments(ui);
  const afterIdle = await searchUi(ui, id, PAUSED_PAGE.query!);
  const docsAfterSearch = await hostDocuments(ui);
  check(
    'idle store host closes and is recreated on demand',
    // PAUSED_PAGE shares the aqueducts article's text, so the two tie for first.
    docsWhenIdle === 0 && docsAfterSearch === 1 && afterIdle.urls.slice(0, 2).includes(fixtureUrl(PAUSED_PAGE)),
    `offscreen documents: idle ${docsWhenIdle}, after search ${docsAfterSearch}; top ${afterIdle.urls.slice(0, 2).join(', ')}`,
  );

  // Forget the last hour (every page here was visited in it).
  const lastHour = await bg<{ pages: number; passages: number }>(ui, {
    kind: 'forget-since',
    since: new Date(Date.now() - 3600_000).toISOString(),
  });
  const statsHour = await bg<Stats>(ui, { kind: 'stats' });
  check('"Forget the last hour" removes everything visited in it', statsHour.pages === 0 && statsHour.passages === 0, `${JSON.stringify(lastHour)} → ${JSON.stringify(statsHour)}`);

  // Something to delete again.
  await visit(context, ui, ARTICLES[0]!, true);
  await bg(ui, { kind: 'wait-idle', timeoutMs: 30_000 });
  await ui.goto(`chrome-extension://${id}/search.html#privacy`);
  ui.once('dialog', (d) => void d.accept());
  await ui.click('#delete-all');
  await ui.waitForFunction(
    () => /^Deleted everything/.test(document.getElementById('forget-note')?.textContent ?? ''),
    undefined,
    { timeout: 60_000 },
  );
  const stats4 = await bg<Stats>(ui, { kind: 'stats' });
  check('"Delete everything" empties the store', stats4.passages === 0 && stats4.pages === 0, JSON.stringify(stats4));
  await context.close();
  const anyArticleOnDisk = (await filesContaining(profileDir, 'Schwarzschild radius')).filter((h) =>
    isRetraceStorage(h, id),
  );
  check(
    'no article text left in Retrace\'s storage after "Delete everything"',
    anyArticleOnDisk.length === 0,
    anyArticleOnDisk.join(', ') || 'none',
  );

  await proxy.close();

  // ---- network ------------------------------------------------------------------
  const isFixture = (u: string): boolean => /^(http:\/\/)?[a-z0-9.-]+\.test(?::\d+)?(\/|$)/.test(u);
  const offHost = proxy.log.filter((e) => !isFixture(e.url));
  const requests = (await Promise.all(netlogs.map(netlogRequests))).flat();
  const byExtension = requests.filter((r) => r.initiator?.startsWith('chrome-extension://'));
  const offHostFromContent = requests.filter(
    (r) => !isFixture(r.url) && r.initiator !== null && r.initiator !== 'not an origin',
  );
  const browserOwn = [...new Set(requests.filter((r) => !isFixture(r.url)).map((r) => new URL(r.url).origin))];
  check('no network request initiated by the extension', byExtension.length === 0, byExtension.map((r) => r.url).join(', ') || 'none');
  check(
    'every off-host request was the browser itself (NetLog initiator: not an origin)',
    offHostFromContent.length === 0,
    offHostFromContent.map((r) => `${r.url} from ${r.initiator}`).join(', ') || `browser-only: ${browserOwn.join(', ')}`,
  );
  results.network = {
    proxyRequests: proxy.log.length,
    fixtureRequests: proxy.log.filter((e) => isFixture(e.url)).length,
    offHostAttemptsRefusedByProxy: offHost.map((e) => `${e.method} ${e.url.slice(0, 80)}`),
    netlogRequests: requests.length,
    initiatedByExtension: byExtension.length,
    browserInternalOrigins: browserOwn,
  };

  // ---- sizes ---------------------------------------------------------------------
  results.distBytes = await dirSize(DIST);
  results.checks = checks;
  await writeFile(join(OUT, 'e2e-results.json'), JSON.stringify(results, null, 2));

  const failed = checks.filter((c) => !c.ok);
  console.log('');
  console.log(`index: ${JSON.stringify(results.indexing)}`);
  console.log(`store after ${stats1.pages} pages / ${stats1.passages} passages: OPFS ${mb(stats1.storeBytes)}, origin usage ${mb(stats1.usageBytes)}`);
  console.log(`restart: first query ${firstQueryAfterRestartMs} ms (store open + model load ${status3.openMs} ms)`);
  console.log(`dist: ${mb(results.distBytes as number)}`);
  console.log(`network: ${JSON.stringify(results.network)}`);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  if (failed.length) process.exit(1);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
