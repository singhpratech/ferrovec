/**
 * Real-browser OPFS persistence test (headless Chromium via Playwright).
 *
 * This is the load-bearing M4 test: it proves a store's data survives a
 * simulated reload. We bundle the fake-embedder worker (`opfs.worker.ts`, which
 * drives the *real* persistence/snapshot/engine/wasm code), serve it over
 * `http://localhost` (a secure context, so OPFS sync access is enabled), and in
 * Chromium:
 *
 *   1. open a store, insert two items, close (releasing the OPFS lock);
 *   2. spawn a *fresh* worker (≈ a page reload), reopen the same store name, and
 *      assert size + vectors + the id→text sidecar all persisted;
 *   3. list(): insert (some before a checkpoint, some only in the write-ahead
 *      log, one upsert), close, reopen in a fresh worker, and assert `list`
 *      returns the same ids and texts in the same order;
 *   4. hold the store open in one worker and open the same name in a second —
 *      asserting M6 leader election: worker A is the leader, worker B a
 *      follower, and a write proxied through B is visible to a query on A (one
 *      shared store, no divergence). Cross-*page* coordination + failover live
 *      in `coord.test.ts`.
 *
 * Run with `npm run test:browser`. Skips (does not fail) if Chromium can't launch.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { serveFixture } from './serve.ts';

/** The scenario that runs inside the Chromium page, driving workers over postMessage. */
function browserScenario(): Promise<unknown> {
  // Everything here is stringified and executed in the browser.
  const origin = location.origin;

  function makeWorker(): Worker {
    return new Worker(new URL('./opfs.worker.js', origin + '/'), { type: 'module' });
  }

  function rpc(w: Worker): (msg: Record<string, unknown>) => Promise<any> {
    let nextId = 0;
    const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
    w.onmessage = (e: MessageEvent) => {
      const { id, ok, result, error } = e.data;
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      ok ? p.resolve(result) : p.reject(new Error(error));
    };
    return (msg) =>
      new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        w.postMessage({ ...msg, id });
      });
  }

  return (async () => {
    const NAME = 'roundtrip-' + Date.now();

    // ---- Phase 1: write + close (release lock) ----
    const w1 = makeWorker();
    const c1 = rpc(w1);
    const open1 = await c1({ type: 'open', name: NAME, persist: true });
    await c1({ type: 'insert', text: 'the cat sat on the mat', docId: 'cat' });
    await c1({ type: 'insert', text: 'a feline napped on a rug', docId: 'feline' });
    const sizeBefore = (await c1({ type: 'size' })).size;
    await c1({ type: 'close' });
    w1.terminate();

    // ---- Phase 2: reopen fresh worker (≈ reload), assert persistence ----
    const w2 = makeWorker();
    const c2 = rpc(w2);
    const open2 = await c2({ type: 'open', name: NAME, persist: true });
    const sizeAfter = (await c2({ type: 'size' })).size;
    const q = (await c2({ type: 'query', text: 'the cat sat on the mat', k: 1 })).results;
    await c2({ type: 'close' });
    w2.terminate();

    // ---- Phase 2b: list() returns the same documents, in order, after a reopen ----
    const LIST = 'list-' + Date.now();
    const l1 = makeWorker();
    const cl1 = rpc(l1);
    await cl1({ type: 'open', name: LIST, persist: true });
    await cl1({ type: 'insert', text: 'alpha one', docId: 'a' });
    await cl1({ type: 'insert', text: 'bravo two', docId: 'b' });
    await cl1({ type: 'insert', text: 'charlie three' }); // auto id
    await cl1({ type: 'flush' }); // checkpoint: the above are in the snapshot
    await cl1({ type: 'insert', text: 'alpha rewritten', docId: 'a' }); // upsert, log only
    await cl1({ type: 'insert', text: 'delta four', docId: 'd' }); // log only
    const listBefore = (await cl1({ type: 'list' })).documents;
    await cl1({ type: 'close' });
    l1.terminate();
    const l2 = makeWorker();
    const cl2 = rpc(l2);
    await cl2({ type: 'open', name: LIST, persist: true });
    const listAfter = (await cl2({ type: 'list' })).documents;
    const listPage = (await cl2({ type: 'list', offset: 1, limit: 2 })).documents;
    await cl2({ type: 'close' });
    l2.terminate();

    // ---- Phase 3: M6 leader election — same store, two workers, one writer ----
    const LOCK = 'lock-' + Date.now();
    const a = makeWorker();
    const ca = rpc(a);
    const openA = await ca({ type: 'open', name: LOCK, persist: true });
    const b = makeWorker();
    const cb = rpc(b);
    const openB = await cb({ type: 'open', name: LOCK, persist: true });
    // Write through the follower (B); it proxies to the leader (A)'s engine.
    await cb({ type: 'insert', text: 'still works via the leader', docId: 'x' });
    const sizeB = (await cb({ type: 'size' })).size;
    // The leader (A) must see the follower's write — one shared store.
    const sizeA = (await ca({ type: 'size' })).size;
    const qA = (await ca({ type: 'query', text: 'still works via the leader', k: 1 })).results;
    await ca({ type: 'close' });
    await cb({ type: 'close' });
    a.terminate();
    b.terminate();

    return {
      open1Persistent: open1.persistent,
      sizeBefore,
      open2Persistent: open2.persistent,
      sizeAfter,
      topId: q[0]?.id ?? null,
      topText: q[0]?.text ?? null,
      topScore: q[0]?.score ?? null,
      openARole: openA.role,
      openBRole: openB.role,
      openAPersistent: openA.persistent,
      openBPersistent: openB.persistent,
      sizeB,
      sizeA,
      crossTopId: qA[0]?.id ?? null,
      listBefore,
      listAfter,
      listPage,
    };
  })();
}

test('OPFS round-trip: data persists across a simulated reload', async (t) => {
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
  try {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(origin + '/');

    const r = (await page.evaluate(browserScenario)) as Record<string, unknown>;

    assert.deepEqual(errors, [], `page errors: ${errors.join('; ')}`);

    // Phase 1/2: persistence round-trip.
    assert.equal(r.open1Persistent, true, 'first open should be persistent (OPFS available)');
    assert.equal(r.sizeBefore, 2, 'two items inserted before reload');
    assert.equal(r.open2Persistent, true, 'reopened store should be persistent');
    assert.equal(r.sizeAfter, 2, 'ALL items must survive the reload (the point of M4)');
    assert.equal(r.topId, 'cat', 'persisted vector must still rank its own text first');
    assert.equal(r.topText, 'the cat sat on the mat', 'id→text sidecar must persist too');
    assert.ok((r.topScore as number) > 0.99, `expected ~1 score, got ${r.topScore}`);

    // Phase 2b: list() across a reopen (snapshot + log replay).
    const expectedList = [
      { id: 'a', text: 'alpha rewritten' },
      { id: 'b', text: 'bravo two' },
      { id: 'auto-0', text: 'charlie three' },
      { id: 'd', text: 'delta four' },
    ];
    assert.deepEqual(r.listBefore, expectedList, 'insertion order; the upsert keeps its position');
    assert.deepEqual(r.listAfter, expectedList, 'same ids, texts, and order after close + reopen');
    assert.deepEqual(r.listPage, expectedList.slice(1, 3), 'offset/limit page after reopen');

    // Phase 3: M6 leader election — exactly one writer, one shared store.
    assert.equal(r.openARole, 'leader', 'first opener wins the Web Lock and leads');
    assert.equal(r.openBRole, 'follower', 'second opener joins as a follower, not a rival writer');
    assert.equal(r.openAPersistent, true, 'leader owns the persistent OPFS store');
    assert.equal(r.openBPersistent, true, 'follower shares the leader’s persistent store');
    assert.equal(r.sizeB, 1, 'follower sees the shared store size (its own proxied write)');
    assert.equal(r.sizeA, 1, 'leader sees the follower’s write — one shared store, no divergence');
    assert.equal(r.crossTopId, 'x', 'a write proxied through the follower is queryable on the leader');
  } finally {
    await browser.close();
    server.close();
  }
});
