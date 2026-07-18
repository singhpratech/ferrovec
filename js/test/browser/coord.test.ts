/**
 * Real two-page cross-tab coordination test (headless Chromium via Playwright).
 *
 * This is the load-bearing M6 test. It opens the SAME store name in **two pages
 * of one browser context** — so they genuinely share OPFS, the Web Locks
 * manager, and BroadcastChannel across page boundaries, exactly as two real tabs
 * would — and asserts the single-writer leader-election invariants:
 *
 *   1. both pages are functional; exactly one is `leader`, one is `follower`;
 *   2. a write in one tab is visible to a `query` from the other (consistency);
 *   3. a write proxied through the follower reaches the one shared store;
 *   4. FAILOVER — close the leader page; the follower is promoted to leader,
 *      inserts more, and closes cleanly; a fresh page then sees ALL data (from
 *      before *and* after failover), proving one writer / no corruption.
 *
 * Run with `npm run test:browser`. Skips (does not fail) if Chromium can't launch.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { serveFixture } from './serve.ts';

/** Installs `window.__rpc(msg)` in a page, backed by a fresh store worker. */
function bootstrapPage(origin: string): void {
  const w = new Worker(new URL('./opfs.worker.js', origin + '/'), { type: 'module' });
  let nextId = 0;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  w.onmessage = (e: MessageEvent): void => {
    const { id, ok, result, error } = e.data as {
      id: number;
      ok: boolean;
      result: unknown;
      error: string;
    };
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    ok ? p.resolve(result) : p.reject(new Error(error));
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).__rpc = (msg: Record<string, unknown>): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      w.postMessage({ ...msg, id });
    });
}

test('two-page cross-tab: leader election, consistency, and failover', async (t) => {
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    t.skip('playwright not installed');
    return;
  }

  let browser;
  try {
    browser = await chromium.launch();
  } catch (err) {
    t.skip(`chromium could not launch: ${(err as Error).message}`);
    return;
  }

  const { server, origin } = await serveFixture();

  // One browser CONTEXT, two pages: same origin ⇒ shared OPFS + Web Locks +
  // BroadcastChannel across the two pages, just like two real tabs.
  const context = await browser.newContext();
  const NAME = 'coord-' + Date.now();

  // Typed shims for the page-side `window.__rpc` we install via bootstrapPage.
  const rpc = <T = any>(page: import('playwright').Page, msg: Record<string, unknown>): Promise<T> =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    page.evaluate((m) => (window as any).__rpc(m), msg) as Promise<T>;

  try {
    const pageA = await context.newPage();
    const pageB = await context.newPage();
    const errors: string[] = [];
    pageA.on('pageerror', (e) => errors.push('A: ' + String(e)));
    pageB.on('pageerror', (e) => errors.push('B: ' + String(e)));
    await pageA.goto(origin + '/');
    await pageB.goto(origin + '/');
    await pageA.evaluate(bootstrapPage, origin);
    await pageB.evaluate(bootstrapPage, origin);

    // ---- 1. Open the SAME store in both pages; assert one leader, one follower.
    const openA = await rpc<{ persistent: boolean; role: string }>(pageA, {
      type: 'open',
      name: NAME,
      persist: true,
    });
    const openB = await rpc<{ persistent: boolean; role: string }>(pageB, {
      type: 'open',
      name: NAME,
      persist: true,
    });

    const roles = [openA.role, openB.role].sort();
    assert.deepEqual(roles, ['follower', 'leader'], `expected one leader + one follower, got ${roles}`);
    assert.equal(openA.persistent, true, 'page A shares the persistent store');
    assert.equal(openB.persistent, true, 'page B shares the persistent store');

    // Identify leader/follower pages by their reported role.
    const leaderPage = openA.role === 'leader' ? pageA : pageB;
    const followerPage = openA.role === 'leader' ? pageB : pageA;

    // ---- 2. Consistency: leader write visible to follower query, and vice-versa.
    await rpc(leaderPage, { type: 'insert', text: 'alpha from the leader', docId: 'alpha' });
    const fromFollower = await rpc<{ results: Array<{ id: string }> }>(followerPage, {
      type: 'query',
      text: 'alpha from the leader',
      k: 1,
    });
    assert.equal(fromFollower.results[0]?.id, 'alpha', "follower must see the leader's write");

    // ---- 3. Follower write reaches the one shared store (proxied to leader).
    await rpc(followerPage, { type: 'insert', text: 'beta from the follower', docId: 'beta' });
    const fromLeader = await rpc<{ results: Array<{ id: string }> }>(leaderPage, {
      type: 'query',
      text: 'beta from the follower',
      k: 1,
    });
    assert.equal(fromLeader.results[0]?.id, 'beta', "leader must see the follower's proxied write");

    const sharedSize = await rpc<{ size: number }>(leaderPage, { type: 'size' });
    assert.equal(sharedSize.size, 2, 'exactly one shared store holds both writes (no divergence)');

    // Force the leader to flush both writes to index.bin BEFORE we kill it, so
    // the pre-failover data is provably on disk (a killed tab may not flush).
    await rpc(leaderPage, { type: 'flush' });

    // ---- 4. FAILOVER: close the leader tab; the follower must be promoted.
    await leaderPage.close();

    // Poll the follower's role until the Web Lock releases and it promotes.
    const deadline = Date.now() + 8000;
    let promotedRole = 'follower';
    while (Date.now() < deadline) {
      promotedRole = (await rpc<{ role: string }>(followerPage, { type: 'role' })).role;
      if (promotedRole === 'leader') break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(promotedRole, 'leader', 'the surviving follower must be promoted to leader on failover');

    // Insert MORE data through the promoted leader, then close it cleanly.
    await rpc(followerPage, { type: 'insert', text: 'gamma after failover', docId: 'gamma' });
    await rpc(followerPage, { type: 'close' });

    // ---- Reopen a FRESH page and assert ALL data survived (before + after).
    const pageC = await context.newPage();
    pageC.on('pageerror', (e) => errors.push('C: ' + String(e)));
    await pageC.goto(origin + '/');
    await pageC.evaluate(bootstrapPage, origin);
    const openC = await rpc<{ persistent: boolean; role: string }>(pageC, {
      type: 'open',
      name: NAME,
      persist: true,
    });
    assert.equal(openC.persistent, true, 'fresh reopen is persistent (data on disk)');

    const finalSize = (await rpc<{ size: number }>(pageC, { type: 'size' })).size;
    const ids: string[] = [];
    for (const q of ['alpha', 'beta', 'gamma']) {
      const r = await rpc<{ results: Array<{ id: string }> }>(pageC, {
        type: 'query',
        text: q + ' probe',
        k: 5,
      });
      for (const hit of r.results) ids.push(hit.id);
    }

    assert.equal(finalSize, 3, 'ALL three items (2 pre-failover + 1 post) must persist across failover');
    for (const id of ['alpha', 'beta', 'gamma']) {
      assert.ok(ids.includes(id), `item "${id}" must survive failover + reload; got [${[...new Set(ids)].join(', ')}]`);
    }

    assert.deepEqual(errors, [], `page errors: ${errors.join('; ')}`);
  } finally {
    await browser.close();
    server.close();
  }
});
