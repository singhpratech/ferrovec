/**
 * Real-browser durability test (headless Chromium via Playwright) for the
 * Phase 0 guarantees, driving the *real* coordinator / A-B slot store / FVS2
 * snapshot / engine / wasm code through the fake-embedder `opfs.worker.ts`:
 *
 *   1. two commits land in alternating slots (seq 1 in slot-a, seq 2 in slot-b);
 *   2. a torn newest slot (truncated to half) is detected and the previous
 *      commit is recovered — not an error, not empty — and the next commit
 *      repairs the torn slot;
 *   3. both slots torn → open rejects with `StoreCorruptError` (never silently
 *      empty);
 *   4. reopening with a different model rejects with
 *      `EmbeddingSpaceMismatchError` and leaves the store untouched;
 *   5. `destroy` deletes the store so the next open starts empty;
 *   6. a leader whose final commit throws (`EmptyOverwriteRefusedError`) still
 *      releases its Web Lock on close: another worker leads immediately and
 *      sees the untouched on-disk data;
 *   7. a follower whose promotion fails permanently (model mismatch) stops
 *      contending: its ops reject fast with the typed error and a tab with the
 *      right model becomes leader.
 *
 * Every open happens in a fresh worker (≈ a page reload). The slot debounce is
 * set very long so commits happen only at close, making sequence numbers
 * deterministic.
 *
 * Run with `npm run test:browser`. Skips (does not fail) if Chromium can't launch.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { serveFixture } from './serve.ts';

/** Runs inside the Chromium page; returns a plain record of observations. */
function durabilityScenario(): Promise<Record<string, unknown>> {
  const origin = location.origin;
  const SLOW = 60_000; // debounce: commit only on close

  type Rpc = (msg: Record<string, unknown>) => Promise<any>;

  function spawn(): { call: Rpc; done: () => void } {
    const w = new Worker(new URL('./opfs.worker.js', origin + '/'), { type: 'module' });
    let nextId = 0;
    const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
    w.onmessage = (e: MessageEvent): void => {
      const { id, ok, result, error, errorName } = e.data;
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      if (ok) {
        p.resolve(result);
      } else {
        const err = new Error(error);
        if (errorName) err.name = errorName;
        p.reject(err);
      }
    };
    return {
      call: (msg) =>
        new Promise((resolve, reject) => {
          const id = nextId++;
          pending.set(id, { resolve, reject });
          w.postMessage({ ...msg, id });
        }),
      done: () => w.terminate(),
    };
  }

  /** One worker lifetime: run `fn` against it, then terminate. */
  async function withWorker<T>(fn: (call: Rpc) => Promise<T>): Promise<T> {
    const w = spawn();
    try {
      return await fn(w.call);
    } finally {
      w.done();
    }
  }

  /** Open in a fresh worker; resolve to the size, or capture the error. */
  async function openOutcome(
    name: string,
    extra: Record<string, unknown> = {},
  ): Promise<{ ok: boolean; size?: number; persistent?: boolean; errorName?: string; message?: string }> {
    return withWorker(async (call) => {
      try {
        const opened = await call({ type: 'open', name, persist: true, debounceMs: SLOW, ...extra });
        const size = (await call({ type: 'size' })).size;
        await call({ type: 'close' });
        return { ok: true, size, persistent: opened.persistent };
      } catch (err) {
        return { ok: false, errorName: (err as Error).name, message: (err as Error).message };
      }
    });
  }

  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  /** Settle an RPC into a plain record (errors keep their restored name). */
  const settle = (p: Promise<any>): Promise<Record<string, unknown>> =>
    p.then(
      (value) => ({ ok: true, value }),
      (err: Error) => ({ ok: false, errorName: err.name, message: err.message }),
    );

  const slots = (name: string): Promise<any> => withWorker((call) => call({ type: 'slots', name }));
  const corrupt = (name: string, slot: 'a' | 'b', truncateTo: number): Promise<any> =>
    withWorker((call) => call({ type: 'corrupt', name, slot, truncateTo }));

  return (async () => {
    const r: Record<string, unknown> = {};
    const NAME = 'durability-' + Date.now();

    // ---- 1. two commits → two slots ----
    await withWorker(async (call) => {
      await call({ type: 'open', name: NAME, persist: true, debounceMs: SLOW });
      for (const [docId, text] of [
        ['cat', 'the cat sat on the mat'],
        ['feline', 'a feline napped on a rug'],
        ['quark', 'quantum chromodynamics describes quarks'],
      ]) {
        await call({ type: 'insert', text, docId });
      }
      await call({ type: 'close' });
    });
    r.slotsAfterFirst = await slots(NAME);
    await withWorker(async (call) => {
      await call({ type: 'open', name: NAME, persist: true, debounceMs: SLOW });
      r.reopenSize = (await call({ type: 'size' })).size;
      await call({ type: 'insert', text: 'a dog chased the ball', docId: 'dog' });
      await call({ type: 'close' });
    });
    const s2: any = await slots(NAME);
    r.slotsAfterSecond = s2;

    // ---- 2. tear the newest slot (seq 2) to half its size → recover seq 1 ----
    const newest: 'a' | 'b' = s2.a.sequence === 2 ? 'a' : 'b';
    r.tornSlot = newest;
    await corrupt(NAME, newest, Math.floor(s2[newest].size / 2));
    r.afterTear = await openOutcome(NAME);
    await withWorker(async (call) => {
      await call({ type: 'open', name: NAME, persist: true, debounceMs: SLOW });
      r.recoveredQuery = (await call({ type: 'query', text: 'the cat sat on the mat', k: 1 })).results;
      await call({ type: 'insert', text: 'a dog chased the ball', docId: 'dog' });
      await call({ type: 'close' });
    });
    r.slotsAfterRepair = await slots(NAME);
    r.afterRepair = await openOutcome(NAME);

    // ---- 3. tear BOTH slots → StoreCorruptError, never silently empty ----
    const s3: any = await slots(NAME);
    await corrupt(NAME, 'a', Math.floor(s3.a.size / 2));
    await corrupt(NAME, 'b', Math.floor(s3.b.size / 2));
    r.bothTorn = await openOutcome(NAME);
    r.bothTornSlots = await slots(NAME); // still on disk, not overwritten
    // destroy is the escape hatch from a corrupt store.
    await withWorker((call) => call({ type: 'destroy', name: NAME }));
    r.afterDestroyCorrupt = await openOutcome(NAME);

    // ---- 4. model mismatch → typed error; store untouched ----
    const M = 'model-' + Date.now();
    await withWorker(async (call) => {
      await call({ type: 'open', name: M, persist: true, debounceMs: SLOW, model: 'fake-fnv1a-32' });
      await call({ type: 'insert', text: 'the cat sat on the mat', docId: 'cat' });
      await call({ type: 'insert', text: 'a feline napped on a rug', docId: 'feline' });
      await call({ type: 'close' });
    });
    const beforeMismatch = await slots(M);
    r.mismatch = await openOutcome(M, { model: 'other-model' });
    r.slotsUnchangedByMismatch = JSON.stringify(await slots(M)) === JSON.stringify(beforeMismatch);
    r.rightModel = await openOutcome(M, { model: 'fake-fnv1a-32' });

    // ---- 5. destroy → reopen empty (and destroying a missing store is a no-op) ----
    await withWorker((call) => call({ type: 'destroy', name: M }));
    r.afterDestroy = await openOutcome(M);
    r.destroyMissing = await withWorker((call) => call({ type: 'destroy', name: 'never-existed-' + Date.now() }));
    // destroy refuses while this worker has a store open.
    r.destroyWhileOpen = await withWorker(async (call) => {
      await call({ type: 'open', name: M, persist: true, debounceMs: SLOW });
      try {
        await call({ type: 'destroy', name: M });
        return 'resolved';
      } catch (err) {
        return (err as Error).message;
      } finally {
        await call({ type: 'close' });
      }
    });

    // ---- 6. a throwing final commit must still release the Web Lock ----
    const E = 'emptyclose-' + Date.now();
    await withWorker(async (call) => {
      await call({ type: 'open', name: E, persist: true, debounceMs: SLOW });
      await call({ type: 'insert', text: 'the cat sat on the mat', docId: 'cat' });
      await call({ type: 'insert', text: 'a feline napped on a rug', docId: 'feline' });
      await call({ type: 'close' });
    });
    const leakB = spawn(); // stays alive: a leaked lock would stay held
    try {
      r.emptyCloseOpen = await leakB.call({
        type: 'open',
        name: E,
        persist: true,
        debounceMs: SLOW,
        emptySnapshot: true,
      });
      await leakB.call({ type: 'insert', text: 'a dog chased the ball', docId: 'dog' }); // dirty, no removes
      r.emptyClose = await settle(leakB.call({ type: 'close' }));
      r.afterEmptyClose = await withWorker(async (call) =>
        settle(
          (async () => {
            const opened = await call({ type: 'open', name: E, persist: true, debounceMs: SLOW, openTimeoutMs: 5000 });
            const size = (await call({ type: 'size' })).size;
            await call({ type: 'close' });
            return { role: opened.role, size };
          })(),
        ),
      );
    } finally {
      leakB.done();
    }

    // ---- 7. permanent promotion failure: stop contending, fail fast ----
    const P = 'permfail-' + Date.now();
    const permA = spawn();
    const permB = spawn();
    try {
      await permA.call({ type: 'open', name: P, persist: true, debounceMs: SLOW, model: 'fake-fnv1a-32' });
      await permA.call({ type: 'insert', text: 'the cat sat on the mat', docId: 'cat' });
      await permA.call({ type: 'insert', text: 'a feline napped on a rug', docId: 'feline' });
      await permA.call({ type: 'flush' });
      const openedB = await permB.call({
        type: 'open',
        name: P,
        persist: true,
        debounceMs: SLOW,
        model: 'other-model',
        opTimeoutMs: 10_000,
      });
      r.permBOpenRole = openedB.role;

      permA.done(); // killed without closing: B is next in the lock queue
      const t0 = performance.now();
      const deadline = t0 + 3000;
      let outcome: Record<string, unknown> = { timedOut: true };
      // An op racing A's teardown may still be answered by A; keep asking until
      // one rejects or the 3 s budget runs out.
      while (performance.now() < deadline) {
        const res = await Promise.race([
          settle(permB.call({ type: 'size' })),
          sleep(Math.max(0, deadline - performance.now())).then(() => ({ timedOut: true })),
        ]);
        if ('timedOut' in res || res.ok === false) {
          outcome = res;
          break;
        }
        await sleep(50);
      }
      r.permBOp = { ...outcome, ms: Math.round(performance.now() - t0) };
      // Every later op fails immediately too, and B never became leader.
      const t1 = performance.now();
      r.permBOp2 = { ...(await settle(permB.call({ type: 'size' }))), ms: Math.round(performance.now() - t1) };
      r.permBRole = (await permB.call({ type: 'role' })).role;

      // B released the lock and stopped contending: C (right model) leads.
      r.permC = await withWorker(async (call) =>
        settle(
          (async () => {
            const opened = await call({
              type: 'open',
              name: P,
              persist: true,
              debounceMs: SLOW,
              model: 'fake-fnv1a-32',
              openTimeoutMs: 5000,
            });
            const size = (await call({ type: 'size' })).size;
            await call({ type: 'close' });
            return { role: opened.role, size };
          })(),
        ),
      );
      r.permBRoleAfterC = (await permB.call({ type: 'role' })).role;
      await permB.call({ type: 'close' });
    } finally {
      permA.done();
      permB.done();
    }

    return r;
  })();
}

test('durability: A/B slots, torn-write recovery, corruption, model mismatch, destroy', async (t) => {
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

    const r = (await page.evaluate(durabilityScenario)) as Record<string, any>;
    assert.deepEqual(errors, [], `page errors: ${errors.join('; ')}`);

    // 1. alternating slots
    assert.equal(r.slotsAfterFirst.a.sequence, 1, 'first commit → slot-a seq 1');
    assert.equal(r.slotsAfterFirst.b.size, 0, 'slot-b untouched after one commit');
    assert.equal(r.reopenSize, 3);
    assert.equal(r.slotsAfterSecond.a.sequence, 1, 'seq 1 survives in slot-a');
    assert.equal(r.slotsAfterSecond.b.sequence, 2, 'second commit → slot-b seq 2');
    assert.equal(r.slotsAfterSecond.b.count, 4);

    // 2. torn newest slot → previous commit recovered, then repaired
    assert.equal(r.tornSlot, 'b');
    assert.equal(r.afterTear.ok, true, `torn slot must not fail open: ${r.afterTear.message}`);
    assert.equal(r.afterTear.size, 3, 'seq 1 recovered — not empty, not an error');
    assert.equal(r.afterTear.persistent, true);
    assert.equal(r.recoveredQuery[0]?.id, 'cat', 'recovered vectors + texts are intact');
    assert.equal(r.recoveredQuery[0]?.text, 'the cat sat on the mat');
    assert.equal(r.slotsAfterRepair.b.sequence, 2, 'the next commit rewrote the torn slot');
    assert.equal(r.slotsAfterRepair.a.sequence, 1);
    assert.equal(r.afterRepair.size, 4);

    // 3. both torn → StoreCorruptError, data left in place; destroy recovers
    assert.equal(r.bothTorn.ok, false);
    assert.equal(r.bothTorn.errorName, 'StoreCorruptError', String(r.bothTorn.message));
    assert.ok(r.bothTornSlots.a.size > 0 && r.bothTornSlots.b.size > 0, 'corrupt slots not overwritten');
    assert.equal(r.bothTornSlots.a.sequence, null);
    assert.equal(r.bothTornSlots.b.sequence, null);
    assert.equal(r.afterDestroyCorrupt.ok, true);
    assert.equal(r.afterDestroyCorrupt.size, 0);

    // 4. model mismatch
    assert.equal(r.mismatch.ok, false);
    assert.equal(r.mismatch.errorName, 'EmbeddingSpaceMismatchError', String(r.mismatch.message));
    assert.match(r.mismatch.message, /fake-fnv1a-32/);
    assert.match(r.mismatch.message, /other-model/);
    assert.equal(r.slotsUnchangedByMismatch, true, 'a mismatched open must not write');
    assert.equal(r.rightModel.ok, true);
    assert.equal(r.rightModel.size, 2, 'data intact when reopened with the right model');

    // 5. destroy
    assert.equal(r.afterDestroy.ok, true);
    assert.equal(r.afterDestroy.size, 0);
    assert.equal(r.afterDestroy.persistent, true);
    assert.deepEqual(r.destroyMissing, { destroyed: true });
    assert.match(String(r.destroyWhileOpen), /cannot destroy/);

    // 6. a throwing final commit still releases the Web Lock
    assert.equal(r.emptyCloseOpen.role, 'leader');
    assert.equal(r.emptyClose.ok, false, 'close must reject when the final commit is refused');
    assert.equal(r.emptyClose.errorName, 'EmptyOverwriteRefusedError', String(r.emptyClose.message));
    assert.equal(r.afterEmptyClose.ok, true, `next worker must open: ${r.afterEmptyClose.message}`);
    assert.equal(r.afterEmptyClose.value.role, 'leader', 'the lock was released, so the next worker leads');
    assert.equal(r.afterEmptyClose.value.size, 2, 'on-disk data untouched by the refused commit');

    // 7. permanent promotion failure
    assert.equal(r.permBOpenRole, 'follower', 'a mismatched model may join as a follower');
    assert.equal(r.permBOp.timedOut, undefined, `B op must reject within 3 s: ${JSON.stringify(r.permBOp)}`);
    assert.equal(r.permBOp.ok, false);
    assert.equal(r.permBOp.errorName, 'EmbeddingSpaceMismatchError', String(r.permBOp.message));
    assert.match(String(r.permBOp.message), /other-model/);
    assert.equal(r.permBOp2.ok, false);
    assert.equal(r.permBOp2.errorName, 'EmbeddingSpaceMismatchError');
    assert.ok(r.permBOp2.ms < 1000, `later ops fail immediately (took ${r.permBOp2.ms}ms)`);
    assert.equal(r.permBRole, 'follower', 'B never became leader');
    assert.equal(r.permC.ok, true, `C must open: ${r.permC.message}`);
    assert.equal(r.permC.value.role, 'leader', 'B released the lock and stopped contending');
    assert.equal(r.permC.value.size, 2);
    assert.equal(r.permBRoleAfterC, 'follower');
  } finally {
    await browser.close();
    server.close();
  }
});
