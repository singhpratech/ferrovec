/**
 * Regression tests for the M6 concurrency defects fixed for 0.3.0.
 *
 * Runs real workers in a headless-Chromium page (secure context ⇒ OPFS sync
 * access + Web Locks + BroadcastChannel), driving the *real*
 * coordinator/persistence/engine code via the fault-injection knobs added to
 * `opfs.worker.ts`. Each scenario targets one defect:
 *
 *   - HIGH-1  leader-init failure must release the Web Lock (no origin deadlock);
 *   - HIGH-2  a failed promotion must re-queue, never leave zero leaders;
 *   - HIGH-3  a follower must not be `welcome`d before the leader's engine exists;
 *   - MEDIUM-1 retries racing a slow op must not double-execute an auto-id insert;
 *   - MEDIUM-2 a follower's open() must be bounded against a frozen leader.
 *
 * (HIGH-4 — a promoted leader must not degrade an intact on-disk index to empty —
 * is covered by the failover round-trip in `coord.test.ts`, which asserts all
 * pre- and post-failover items survive; the promotion there opens with
 * `requireLock`, which now throws rather than falling back to memory.)
 *
 * Run with `npm run test:browser`. Skips (does not fail) if Chromium can't launch.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { serveFixture } from './serve.ts';

/**
 * Runs one named defect scenario inside the Chromium page and returns a plain
 * result object. Everything here is stringified and executed in the browser.
 */
function runDefectScenario(mode: string): Promise<Record<string, unknown>> {
  const origin = location.origin;
  const makeWorker = (): Worker =>
    new Worker(new URL('./opfs.worker.js', origin + '/'), { type: 'module' });

  function rpc(w: Worker): (msg: Record<string, unknown>) => Promise<any> {
    let nextId = 0;
    const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
    w.onmessage = (e: MessageEvent): void => {
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
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
  const NAME = `${mode}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  return (async (): Promise<Record<string, unknown>> => {
    if (mode === 'high1') {
      // A wins the lock but its engine build throws → open() must reject AND the
      // Web Lock must be released. A's worker stays alive (holding the leaked
      // lock if unfixed); B must still become leader.
      const a = makeWorker();
      const ca = rpc(a);
      let aOpenRejected = false;
      try {
        await ca({ type: 'open', name: NAME, persist: true, failEngineTimes: 1 });
      } catch {
        aOpenRejected = true;
      }
      const b = makeWorker();
      const cb = rpc(b);
      // Generous open bound: under the fix B leads within ~1s; the large budget
      // only avoids a spurious timeout under CPU contention (3 browsers run
      // concurrently). A regression (A leaks the lock) still fails — B never
      // becomes leader — just later.
      const openB = await cb({ type: 'open', name: NAME, persist: true, openTimeoutMs: 20000 });
      const sizeB = (await cb({ type: 'size' })).size;
      await cb({ type: 'close' });
      a.terminate();
      b.terminate();
      return { aOpenRejected, bRole: openB.role, bPersistent: openB.persistent, sizeB };
    }

    if (mode === 'high2') {
      // A is a healthy leader; B is a follower whose FIRST promotion attempt's
      // engine build fails once. On failover B must re-queue and promote on the
      // second attempt — never silently drop out leaving zero leaders.
      const a = makeWorker();
      const ca = rpc(a);
      const openA = await ca({ type: 'open', name: NAME, persist: true });
      const b = makeWorker();
      const cb = rpc(b);
      const openB = await cb({ type: 'open', name: NAME, persist: true, failEngineTimes: 1 });
      await ca({ type: 'close' });
      a.terminate();
      let bRole = 'follower';
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        bRole = (await cb({ type: 'role' })).role;
        if (bRole === 'leader') break;
        await sleep(100);
      }
      const sizeB = (await cb({ type: 'size' })).size;
      await cb({ type: 'close' });
      b.terminate();
      return { openARole: openA.role, openBRole: openB.role, bRole, sizeB };
    }

    if (mode === 'high3') {
      // A acquires the lock but takes ~800ms to build its engine. B opens during
      // the build: it must NOT get a premature welcome{persistent:false} — it
      // must wait for A's engine and resolve as a persistent follower.
      const a = makeWorker();
      const ca = rpc(a);
      const aOpenP = ca({ type: 'open', name: NAME, persist: true, slowEngineMs: 800 });
      await sleep(100); // A holds the lock and is mid-build
      const b = makeWorker();
      const cb = rpc(b);
      // Generous bound: B must be welcomed only AFTER A's ~800ms engine build; the
      // large budget avoids a spurious timeout under contention. The assertion is
      // on persistent===true, which a HIGH-3 regression breaks regardless of load.
      const openB = await cb({ type: 'open', name: NAME, persist: true, openTimeoutMs: 20000 });
      const openA = await aOpenP;
      // A follower op still works and reaches the one shared store.
      await cb({ type: 'insert', text: 'via follower', docId: 'z' });
      const sizeA = (await ca({ type: 'size' })).size;
      await ca({ type: 'close' });
      await cb({ type: 'close' });
      a.terminate();
      b.terminate();
      return {
        openARole: openA.role,
        openBRole: openB.role,
        openBPersistent: openB.persistent,
        sizeA,
      };
    }

    if (mode === 'medium1') {
      // Leader A embeds slowly (700ms) so the follower's 250ms request times out
      // and retries while the first insert is still executing. A single auto-id
      // insert must execute exactly once (size 1), not once per retry.
      const a = makeWorker();
      const ca = rpc(a);
      const openA = await ca({ type: 'open', name: NAME, persist: true, slowEmbedMs: 700 });
      const b = makeWorker();
      const cb = rpc(b);
      await cb({ type: 'open', name: NAME, persist: true });
      const id = (await cb({ type: 'insert', text: 'race me' })).id; // no docId ⇒ auto-id
      // The follower's insert resolves as soon as the FIRST execution completes;
      // any duplicate executions started by retries finish ~one slow-embed later.
      // Wait for them to settle before measuring, so a regression (each retry
      // starting its own auto-id insert) would show up as size > 1.
      await sleep(1500);
      const size = (await ca({ type: 'size' })).size;
      await ca({ type: 'close' });
      await cb({ type: 'close' });
      a.terminate();
      b.terminate();
      return { openARole: openA.role, size, id };
    }

    if (mode === 'medium2open') {
      // The page itself holds the leader Web Lock forever — a deterministic stand-in
      // for a frozen leader tab that holds the lock but never answers hello. A
      // worker opening the same store can never acquire the lock nor be welcomed,
      // so its open() must reject on its bound instead of hanging forever.
      const lockBox: { release: (() => void) | null } = { release: null };
      const acquired = new Promise<void>((resolve) => {
        void navigator.locks.request(`ferrovec-leader:${NAME}`, { mode: 'exclusive' }, () => {
          resolve();
          return new Promise<void>((rel) => {
            lockBox.release = rel;
          });
        });
      });
      await acquired; // the lock is now provably held by the page
      const b = makeWorker();
      const cb = rpc(b);
      const start = Date.now();
      let bOpenError: string | null = null;
      try {
        await cb({ type: 'open', name: NAME, persist: true, openTimeoutMs: 800 });
      } catch (e: any) {
        bOpenError = String(e?.message ?? e);
      }
      const elapsed = Date.now() - start;
      lockBox.release?.();
      b.terminate();
      return { bOpenError, elapsed };
    }

    if (mode === 'medium2op') {
      // A leader exists, then leaves; B is a follower whose promotion ALWAYS fails,
      // so no leader ever returns. A follower op must reject on its bound rather
      // than spinning silently forever (and B must keep re-queuing, never crashing).
      const a = makeWorker();
      const ca = rpc(a);
      const openA = await ca({ type: 'open', name: NAME, persist: true });
      const b = makeWorker();
      const cb = rpc(b);
      await cb({ type: 'open', name: NAME, persist: true, failEngineTimes: 9999, opTimeoutMs: 900 });
      await ca({ type: 'close' }); // leader gone; B can never promote past the failure
      a.terminate();
      const start = Date.now();
      let opError: string | null = null;
      try {
        await cb({ type: 'size' });
      } catch (e: any) {
        opError = String(e?.message ?? e);
      }
      const elapsed = Date.now() - start;
      await cb({ type: 'close' });
      b.terminate();
      return { openARole: openA.role, opError, elapsed };
    }

    throw new Error(`unknown mode ${mode}`);
  })();
}

test('M6 defect regressions: lock release, promotion re-queue, engine-first, dedupe, bounds', async (t) => {
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

    // HIGH-1 — leader-init failure releases the Web Lock (no origin deadlock).
    const h1 = (await page.evaluate(runDefectScenario, 'high1')) as Record<string, unknown>;
    assert.equal(h1.aOpenRejected, true, 'HIGH-1: a failed leader init must reject open()');
    assert.equal(h1.bRole, 'leader', 'HIGH-1: the lock must be released so B can lead (no deadlock)');
    assert.equal(h1.bPersistent, true, 'HIGH-1: B opens the real persistent store');
    assert.equal(h1.sizeB, 0, 'HIGH-1: B starts from the (empty) on-disk index');

    // HIGH-2 — a failed promotion re-queues; never zero leaders.
    const h2 = (await page.evaluate(runDefectScenario, 'high2')) as Record<string, unknown>;
    assert.equal(h2.openARole, 'leader', 'HIGH-2: A is the initial leader');
    assert.equal(h2.openBRole, 'follower', 'HIGH-2: B starts as a follower');
    assert.equal(h2.bRole, 'leader', 'HIGH-2: B must re-queue after a failed promotion and become leader');

    // HIGH-3 — no welcome before the leader engine exists.
    const h3 = (await page.evaluate(runDefectScenario, 'high3')) as Record<string, unknown>;
    assert.equal(h3.openARole, 'leader', 'HIGH-3: A leads once its engine is built');
    assert.equal(h3.openBRole, 'follower', 'HIGH-3: B joins as a follower');
    assert.equal(
      h3.openBPersistent,
      true,
      'HIGH-3: B must wait for the engine and get welcome{persistent:true}, not a premature false',
    );
    assert.equal(h3.sizeA, 1, 'HIGH-3: the follower op reaches the one shared store');

    // MEDIUM-1 — retries racing a slow op must not double-execute.
    const m1 = (await page.evaluate(runDefectScenario, 'medium1')) as Record<string, unknown>;
    assert.equal(m1.openARole, 'leader', 'MEDIUM-1: A leads');
    assert.equal(m1.size, 1, 'MEDIUM-1: a single auto-id insert must execute exactly once despite retries');

    // MEDIUM-2a — a follower open() is bounded against a frozen leader (lock held,
    // never answers).
    const m2o = (await page.evaluate(runDefectScenario, 'medium2open')) as Record<string, unknown>;
    assert.ok(
      typeof m2o.bOpenError === 'string' && /timed out/i.test(m2o.bOpenError as string),
      `MEDIUM-2: open() must reject with a timeout, got ${JSON.stringify(m2o.bOpenError)}`,
    );
    assert.ok(
      (m2o.elapsed as number) < 5000,
      `MEDIUM-2: open() must reject promptly on its bound, took ${m2o.elapsed}ms`,
    );

    // MEDIUM-2b — a follower op is bounded when no leader ever returns.
    const m2p = (await page.evaluate(runDefectScenario, 'medium2op')) as Record<string, unknown>;
    assert.equal(m2p.openARole, 'leader', 'MEDIUM-2: A is the initial leader');
    assert.ok(
      typeof m2p.opError === 'string' && /timed out/i.test(m2p.opError as string),
      `MEDIUM-2: a follower op must reject with a timeout, got ${JSON.stringify(m2p.opError)}`,
    );
    assert.ok(
      (m2p.elapsed as number) < 5000,
      `MEDIUM-2: a follower op must reject promptly on its bound, took ${m2p.elapsed}ms`,
    );

    assert.deepEqual(errors, [], `page errors: ${errors.join('; ')}`);
  } finally {
    await browser.close();
    server.close();
  }
});
