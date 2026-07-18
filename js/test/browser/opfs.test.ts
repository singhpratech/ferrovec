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
 *   3. hold the store open in one worker and open the same name in a second —
 *      asserting the exclusive-lock contention degrades to in-memory without
 *      crashing.
 *
 * Run with `npm run test:browser`. Skips (does not fail) if Chromium can't launch.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, writeFile, copyFile } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';

const here = dirname(fileURLToPath(import.meta.url));

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
};

const INDEX_HTML = '<!doctype html><html><head><meta charset="utf-8"><title>opfs</title></head><body>ok</body></html>';

/** Bundle the worker + assets into a temp dir and serve it over localhost. */
async function serveFixture(): Promise<{ server: Server; origin: string; dir: string }> {
  const { build } = await import('esbuild');
  const dir = await mkdtemp(join(tmpdir(), 'ferrovec-opfs-'));

  await build({
    entryPoints: [join(here, 'opfs.worker.ts')],
    outfile: join(dir, 'opfs.worker.js'),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    // core-loader's Node branch dynamically imports these; the branch is dead in
    // a browser, so leave the (never-executed) imports unresolved rather than
    // failing the bundle.
    external: ['node:fs/promises', 'node:url'],
  });

  // The wasm glue fetches `ferrovec_bg.wasm` relative to the (bundled) worker
  // module URL, so place it alongside the worker bundle.
  await copyFile(join(here, '../../src/core/ferrovec_bg.wasm'), join(dir, 'ferrovec_bg.wasm'));
  await writeFile(join(dir, 'index.html'), INDEX_HTML);

  const server = createServer(async (req, res) => {
    try {
      const path = req.url === '/' || !req.url ? '/index.html' : req.url.split('?')[0]!;
      const body = await readFile(join(dir, path));
      res.setHeader('Content-Type', MIME[extname(path)] ?? 'application/octet-stream');
      res.end(body);
    } catch {
      res.statusCode = 404;
      res.end('not found');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return { server, origin: `http://localhost:${port}`, dir };
}

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

    // ---- Phase 3: exclusive-lock contention → in-memory fallback, no crash ----
    const LOCK = 'lock-' + Date.now();
    const a = makeWorker();
    const ca = rpc(a);
    const openA = await ca({ type: 'open', name: LOCK, persist: true });
    const b = makeWorker();
    const cb = rpc(b);
    const openB = await cb({ type: 'open', name: LOCK, persist: true });
    await cb({ type: 'insert', text: 'still works in memory', docId: 'x' });
    const sizeB = (await cb({ type: 'size' })).size;
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
      openAPersistent: openA.persistent,
      openBPersistent: openB.persistent,
      sizeB,
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

    // Phase 3: exclusive-lock fallback.
    assert.equal(r.openAPersistent, true, 'lock holder is persistent');
    assert.equal(r.openBPersistent, false, 'contended open must degrade to in-memory, not crash');
    assert.equal(r.sizeB, 1, 'the degraded in-memory store must still be functional');
  } finally {
    await browser.close();
    server.close();
  }
});
