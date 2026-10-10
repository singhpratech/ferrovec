/**
 * End-to-end test of the GitHub Pages live demo (`docs/live.html`).
 *
 * Serves `docs/` from a tiny static server on `http://localhost` (a secure
 * context: OPFS sync access + Web Locks) and drives the page in a Playwright
 * persistent context, so OPFS and the model cache survive reloads exactly as
 * they do for a visitor. The page runs the real shipped code path (built by
 * `npm run build:live`): the real transformers.js MiniLM model is downloaded
 * once into the test's temp profile.
 *
 * Every assertion reads the evidence the page computed itself (each evidence
 * line carries `data-kind` + `data-json`), so the test checks the same numbers
 * a visitor sees.
 *
 * Not part of `npm test` (it needs the network for the first model download).
 * Run: `npm run build:live && npm run test:live`. Env: `BROWSER`
 * (`chromium` | `firefox`, default chromium), `S2_RUNS` (default 5).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import type { BrowserContext, Page } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const DOCS = join(here, '../../../docs');
const BROWSER = (process.env.BROWSER ?? 'chromium') as 'chromium' | 'firefox';
const S2_RUNS = Number(process.env.S2_RUNS ?? 5);
const MODEL_TIMEOUT_MS = 5 * 60_000;
const STEP_TIMEOUT_MS = 90_000;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.json': 'application/json',
};

/** A minimal static file server for `docs/`. */
async function serveDocs(): Promise<{ server: Server; origin: string }> {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://x');
      let path = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
      if (path.endsWith('/')) path += 'index.html';
      const file = join(DOCS, path);
      if (!file.startsWith(DOCS) || !(await stat(file)).isFile()) throw new Error('not found');
      res.setHeader('Content-Type', MIME[extname(file)] ?? 'application/octet-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.end(await readFile(file));
    } catch {
      res.statusCode = 404;
      res.end('not found');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, origin: `http://localhost:${(server.address() as AddressInfo).port}` };
}

interface Ev {
  kind: string;
  [k: string]: unknown;
}

/** The last evidence line of `kind` on the page (parsed `data-json`). */
async function lastEvidence(page: Page, kind: string, timeout = STEP_TIMEOUT_MS): Promise<Ev> {
  const loc = page.locator(`[data-kind="${kind}"]`).last();
  await loc.waitFor({ state: 'attached', timeout });
  return JSON.parse((await loc.getAttribute('data-json')) ?? '{}') as Ev;
}
async function lineText(page: Page, kind: string): Promise<string> {
  return ((await page.locator(`[data-kind="${kind}"]`).last().textContent()) ?? '').trim();
}

/** Wait until the store is open and controls are enabled. */
async function waitReady(page: Page, timeout = STEP_TIMEOUT_MS): Promise<void> {
  await page.waitForFunction(
    () => {
      const t = document.getElementById('st-model')?.textContent ?? '';
      const btn = document.getElementById('s1-save') as HTMLButtonElement | null;
      return (t.startsWith('ready') || t.startsWith('not loaded')) && btn !== null && !btn.disabled;
    },
    undefined,
    { timeout },
  );
}

/** Click something that makes the page reload itself, and wait for the new document to be ready. */
async function clickAndAwaitReload(page: Page, selector: string): Promise<void> {
  const loaded = page.waitForEvent('load', { timeout: STEP_TIMEOUT_MS });
  await page.click(selector);
  await loaded;
  await waitReady(page);
}

const report: Record<string, unknown> = { browser: BROWSER };

test(`live demo end to end (${BROWSER})`, async (t) => {
  let playwright: typeof import('playwright');
  try {
    playwright = await import('playwright');
  } catch {
    t.skip('playwright not installed');
    return;
  }
  try {
    await stat(join(DOCS, 'live/index.js'));
  } catch {
    assert.fail('docs/live/ is not built; run `npm run build:live` first');
  }

  const { server, origin } = await serveDocs();
  const userDataDir = await mkdtemp(join(tmpdir(), `ferrovec-live-${BROWSER}-`));
  let context: BrowserContext;
  try {
    context = await playwright[BROWSER].launchPersistentContext(userDataDir, { headless: true });
  } catch (err) {
    server.close();
    await rm(userDataDir, { recursive: true, force: true });
    t.skip(`${BROWSER} could not launch: ${(err as Error).message}`);
    return;
  }
  report.browserVersion = context.browser()?.version() ?? null;

  // Network accounting: what the page downloads, and proof no request carries user text.
  const bytesByHost: Record<string, number> = {};
  const requestBodies: string[] = [];
  const requestUrls: string[] = [];
  context.on('request', (req) => {
    requestUrls.push(req.url());
    const body = req.postData();
    if (body) requestBodies.push(body);
  });
  context.on('requestfinished', (req) => {
    void req
      .sizes()
      .then((s) => {
        const host = new URL(req.url()).host;
        bytesByHost[host] = (bytesByHost[host] ?? 0) + s.responseBodySize;
      })
      .catch(() => {});
  });

  const pageErrors: string[] = [];
  const watch = (p: Page): Page => {
    p.on('pageerror', (e) => pageErrors.push(String(e)));
    return p;
  };

  try {
    const page = watch(context.pages()[0] ?? (await context.newPage()));

    await t.test('first open: model loads, store seeds, controls enable', async () => {
      const t0 = Date.now();
      await page.goto(`${origin}/live.html`);
      await waitReady(page, MODEL_TIMEOUT_MS);
      report.firstOpenMs = Date.now() - t0;
      report.modelStatus = (await page.textContent('#st-model'))?.trim();
      assert.match((await page.textContent('#st-role')) ?? '', /leader|solo/);
      assert.equal((await page.textContent('#st-persistent'))?.trim(), 'true');
      const docs = Number(((await page.textContent('#st-docs')) ?? '').replace(/,/g, ''));
      assert.ok(docs >= 30, `expected the 30-note seed corpus, got ${docs}`);
      const visits = await lastEvidence(page, 's7-visits');
      assert.equal(visits.next, 1);
    });

    await t.test('scene 1: notes survive a reload', async () => {
      await page.click('[data-goto="1"]');
      for (const note of [
        'Ask the landlord about the boiler service before winter.',
        'The spare key is with Priya in flat 3B until Sunday.',
        'Idea for the garden: move the raspberry canes to the sunny fence.',
      ]) {
        await page.fill('#s1-text', note);
        await page.click('#s1-save');
        await page.locator('#s1-save:not([disabled])').waitFor();
      }
      await clickAndAwaitReload(page, '#s1-reload');
      const reopen = await lastEvidence(page, 's1-reopen');
      const verify = await lastEvidence(page, 's1-verify');
      report.scene1 = { reopenMs: Math.round(reopen.ms as number), size: reopen.size, ...verify };
      assert.equal(verify.checked, 3);
      assert.equal(verify.found, 3);
      assert.equal(verify.lost, 0);
    });

    await t.test(`scene 2: kill the tab mid-write, ${S2_RUNS} runs, lost == 0`, async () => {
      await page.click('[data-goto="2"]');
      const runs: Ev[] = [];
      for (let i = 0; i < S2_RUNS; i++) {
        await clickAndAwaitReload(page, '#s2-run');
        const r = await lastEvidence(page, 's2-result');
        const tail = await lastEvidence(page, 's2-tail');
        const inflight = await lastEvidence(page, 's2-inflight');
        runs.push({ ...r, tornBytes: tail.tornBytes, inflightPresent: inflight.present });
        assert.equal(r.lost, 0, `run ${i + 1}: ${await lineText(page, 's2-result')}`);
        assert.equal(r.found, r.acked);
        assert.ok((r.acked as number) >= 5 && (r.acked as number) <= 55);
      }
      report.scene2 = runs.map((r) => ({
        acked: r.acked,
        found: r.found,
        lost: r.lost,
        reloadDuringInsert: (r.killAfter as number) + 1,
        reopenMs: Math.round(r.reopenMs as number),
        tornBytes: r.tornBytes,
        inflightPresent: r.inflightPresent,
        top1Misses: r.top1Misses,
      }));
    });

    let leaderPage = page;
    await t.test('scene 3: two tabs, one store, failover', async () => {
      await leaderPage.click('[data-goto="3"]');
      await leaderPage.waitForFunction(() => /leader|solo/.test(document.getElementById('s3-role')?.textContent ?? ''));
      const popupP = context.waitForEvent('page', { timeout: STEP_TIMEOUT_MS });
      await leaderPage.click('#s3-open');
      const second = watch(await popupP);
      await second.waitForLoadState();
      await waitReady(second);
      assert.equal((await second.textContent('#s3-role'))?.trim(), 'follower');
      assert.ok(second.url().endsWith('#tab2'));

      // Insert from both tabs; each tab's polled count follows the other's writes.
      const countOn = async (p: Page): Promise<number> =>
        Number(((await p.textContent('#s3-count')) ?? '').replace(/,/g, '')) || 0;
      await leaderPage.click('#s3-insert');
      const fromLeader = await lastEvidence(leaderPage, 's3-insert');
      await leaderPage.waitForTimeout(1500); // let the 1 s poll catch up
      const before = await countOn(leaderPage);
      await second.click('#s3-insert');
      const fromFollower = await lastEvidence(second, 's3-insert');
      assert.equal(fromFollower.role, 'follower');
      await leaderPage.waitForFunction(
        (n) => Number((document.getElementById('s3-count')?.textContent ?? '').replace(/,/g, '')) >= n,
        before + 1,
        { timeout: 10_000 },
      );
      const leaderCountAfter = await countOn(leaderPage);
      // The follower learned the leader's insert over the page channel.
      await second.locator('#ev-3 .ev-line', { hasText: String(fromLeader.id) }).first().waitFor({ timeout: 10_000 });

      const closedAt = Date.now();
      await leaderPage.close();
      const role = await lastEvidence(second, 's3-role', STEP_TIMEOUT_MS);
      const flipMs = Date.now() - closedAt;
      assert.equal(role.from, 'follower');
      assert.equal(role.to, 'leader');
      const promoted = await lastEvidence(second, 's3-promoted', STEP_TIMEOUT_MS);
      assert.equal(promoted.ok, true, JSON.stringify(promoted));
      assert.equal(promoted.expected, fromLeader.id);
      report.scene3 = {
        secondTabRole: 'follower',
        leaderCountBeforeFollowerInsert: before,
        leaderCountAfterFollowerInsert: leaderCountAfter,
        roleFlip: `${role.from} -> ${role.to}`,
        flipObservedMsAfterClose: flipMs,
        roleLine: await lineText(second, 's3-role'),
        promotedLine: await lineText(second, 's3-promoted'),
      };
      leaderPage = second;
    });

    // Scenes 4 and 5 need this to be the only demo tab. (Open the blank page
    // first: Firefox's persistent context cannot open one after its last page closes.)
    const solo = watch(await context.newPage());
    await leaderPage.close();

    await t.test('scene 4: crash mid-checkpoint recovers; torn newest / both are refused', async () => {
      await solo.goto(`${origin}/live.html#scene-4`);
      await waitReady(solo);

      await clickAndAwaitReload(solo, '#s4-crash');
      const torn = await lastEvidence(solo, 's4-torn');
      const recovered = await lastEvidence(solo, 's4-recovered');
      const verify = await lastEvidence(solo, 's4-verify');
      assert.equal(verify.checked, 3);
      assert.equal(verify.found, 3);
      assert.equal(verify.lost, 0);
      assert.notEqual(torn.target, torn.newest);
      const crash = {
        tornLine: await lineText(solo, 's4-torn'),
        recoveredLine: await lineText(solo, 's4-recovered'),
        verifyLine: await lineText(solo, 's4-verify'),
        size: recovered.size,
      };

      await solo.click('#s4-newest');
      const refusedNewest = await lastEvidence(solo, 's4-refused');
      assert.equal(refusedNewest.name, 'StoreCorruptError');
      assert.match(String(refusedNewest.message), /wal-ahead-of-snapshot/);
      const newestMsg = refusedNewest.message;
      await solo.click('#s4-destroy');
      await lastEvidence(solo, 'reseeded');
      await waitReady(solo);
      await solo.evaluate(() => { document.getElementById('ev-4')!.replaceChildren(); });

      await solo.click('#s4-both');
      const refusedBoth = await lastEvidence(solo, 's4-refused');
      assert.equal(refusedBoth.name, 'StoreCorruptError');
      const tears = await solo.locator('[data-kind="s4-tear"]').count();
      assert.equal(tears, 2);
      await solo.click('#s4-destroy');
      const reseeded = await lastEvidence(solo, 'reseeded');
      assert.equal(reseeded.size, 30);
      await waitReady(solo);
      report.scene4 = { crash, tearNewest: newestMsg, tearBoth: refusedBoth.message };
    });

    await t.test('scene 5: wrong model refused before any download, store untouched', async () => {
      await solo.click('[data-goto="5"]');
      await solo.click('#s5-run');
      const refused = await lastEvidence(solo, 's5-refused');
      const reopen = await lastEvidence(solo, 's5-reopen');
      assert.equal(refused.name, 'EmbeddingSpaceMismatchError');
      assert.equal(refused.bgeFiles, 0);
      assert.equal(reopen.sizeAfter, reopen.sizeBefore);
      assert.ok(!requestUrls.some((u) => u.includes('bge-small')), 'a bge-small file was requested');
      report.scene5 = { refusedMs: Math.round(refused.ms as number), name: refused.name, sizeBefore: reopen.sizeBefore, sizeAfter: reopen.sizeAfter };
    });

    await t.test('scenes 6 and 7: render, insert, search', async () => {
      await solo.click('[data-goto="6"]');
      const secret = 'Zephyrine lagoon clause';
      const doc = [
        '# Leave policy (internal)',
        `Bereavement leave is five paid days for immediate family. ${secret} 77.`,
        'Sick leave does not require a doctor note for absences of up to three days.',
        'Sabbaticals of up to three months are available after five years of service.',
        'Jury duty is fully paid and does not count against vacation.',
      ].join('\n\n');
      await solo.setInputFiles('#s6-file', { name: 'policy.md', mimeType: 'text/markdown', buffer: Buffer.from(doc) });
      const ingest = await lastEvidence(solo, 's6-ingest');
      assert.equal(ingest.paragraphs, 5);
      await solo.locator('#s6-search:not([disabled])').waitFor();
      await solo.fill('#s6-q', 'time off when a relative dies');
      await solo.click('#s6-search');
      const search = await lastEvidence(solo, 's6-search');
      assert.equal(search.n, 5);
      assert.equal(search.top, 'file-policy-2');
      assert.ok(!requestBodies.some((b) => b.includes(secret)) && !requestUrls.some((u) => u.includes('Zephyrine')), 'user text left the page');

      await solo.click('[data-goto="7"]');
      await solo.click('#s7-remember');
      await lastEvidence(solo, 's7-remember');
      await solo.locator('[data-ask]:not([disabled])').first().waitFor();
      await solo.click('[data-ask]');
      const recall = await lastEvidence(solo, 's7-recall');
      assert.ok((recall.n as number) >= 1);
      const visits = await lastEvidence(solo, 's7-visits');
      assert.ok((visits.next as number) > 1, await lineText(solo, 's7-visits'));
      report.scene6 = { paragraphs: ingest.paragraphs, ingestMs: Math.round(ingest.ms as number), top: search.top };
      report.scene7 = { visits: visits.next, recalled: recall.n };
    });

    report.downloadBytesByHost = bytesByHost;
    report.pageErrors = pageErrors;
    assert.deepEqual(pageErrors, []);
  } finally {
    console.log(`[live] ${JSON.stringify(report, null, 2)}`);
    await context.close();
    server.close();
    await rm(userDataDir, { recursive: true, force: true });
  }
});
