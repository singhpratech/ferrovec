/**
 * `compact()`: removed and replaced documents leave the store's bytes, not
 * just its results. Engine level against the real wasm core (tombstoned ids
 * and vectors disappear from `toBytes()`), the fallbacks for injected cores
 * and persisters without the optional hooks, follower → leader routing, and
 * the main-thread proxy message. The slot-store side (`rewrite()` writes both
 * slots) is in slotstore.test.ts.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Engine } from '../src/engine.ts';
import { createCore } from '../src/core-loader.ts';
import { Coordinator } from '../src/coordinator.ts';
import { Ferrovec } from '../src/ferrovec.ts';
import type { Embedder, Persister, VectorCore } from '../src/types.ts';

const DIMS = 16;

/** Deterministic embedder: each character bumps one dimension. */
const embedder: Embedder = {
  id: 'fake-chars-16',
  dims: DIMS,
  async embed(text: string): Promise<Float32Array> {
    const v = new Float32Array(DIMS);
    for (let i = 0; i < text.length; i++) v[text.charCodeAt(i) % DIMS]! += 1;
    let n = 0;
    for (const x of v) n += x * x;
    n = Math.sqrt(n) || 1;
    return v.map((x) => x / n);
  },
};

function spyPersister(withRewrite: boolean): Persister & { calls: string[] } {
  const calls: string[] = [];
  const p: Persister & { calls: string[] } = {
    calls,
    async append() {},
    async flush() {
      calls.push('flush');
    },
    async close() {},
  };
  if (withRewrite) {
    p.rewrite = async () => {
      calls.push('rewrite');
    };
  }
  return p;
}

const has = (bytes: Uint8Array, s: string): boolean => Buffer.from(bytes).includes(Buffer.from(s, 'utf8'));

test('Engine.compact drops removed and replaced entries from the core bytes; results unchanged', async () => {
  const persister = spyPersister(true);
  const engine = await Engine.create({ embedder, core: await createCore(DIMS), persister });
  await engine.insert('alpha bravo charlie', 'keep-1');
  await engine.insert('delta echo foxtrot', 'removed-doc-id');
  await engine.insert('golf hotel india', 'upserted-doc');
  await engine.insert('juliet kilo lima', 'upserted-doc'); // replaces: old node tombstoned
  assert.equal(await engine.remove('removed-doc-id'), true);

  const before = engine.snapshot().core;
  assert.ok(has(before, 'removed-doc-id'), 'precondition: a removed id lingers as a tombstone');
  const queryBefore = await engine.query('juliet kilo', 3);
  const listBefore = engine.list();

  await engine.compact();

  const after = engine.snapshot().core;
  assert.ok(!has(after, 'removed-doc-id'), 'the removed id is gone from the serialized index');
  assert.ok(after.length < before.length, `bytes shrink (${before.length} → ${after.length})`);
  assert.equal(engine.size(), 2);
  assert.deepEqual(await engine.query('juliet kilo', 3), queryBefore, 'same results');
  assert.deepEqual(engine.list(), listBefore, 'same list');
  assert.deepEqual(persister.calls, ['rewrite'], 'every slot rewritten, not a conditional flush');

  // Still fully usable afterwards.
  await engine.insert('mike november', 'new-after-compact');
  assert.equal((await engine.query('mike november', 1))[0]?.id, 'new-after-compact');
});

test('Engine.compact without the optional hooks: injected core without compact(), persister without rewrite()', async () => {
  const real = await createCore(DIMS);
  const bare: VectorCore = {
    insert: (id, v) => real.insert(id, v),
    search: (q, k) => real.search(q, k),
    remove: (id) => real.remove(id),
    len: () => real.len(),
    isEmpty: () => real.isEmpty(),
    dims: () => real.dims(),
    toBytes: () => real.toBytes(),
  };
  const persister = spyPersister(false);
  const engine = await Engine.create({ embedder, core: bare, persister });
  await engine.insert('alpha', 'a');
  await engine.compact();
  assert.deepEqual(persister.calls, ['flush'], 'falls back to flush()');
  assert.equal(engine.size(), 1);
});

/** Minimal exclusive Web Locks fake, enough for one leader + one follower. */
class FakeLocks {
  readonly #held = new Set<string>();
  readonly #queues = new Map<string, Array<() => void>>();
  async request(
    name: string,
    options: { ifAvailable?: boolean; signal?: AbortSignal },
    callback: (lock: { name: string } | null) => unknown,
  ): Promise<unknown> {
    if (this.#held.has(name)) {
      if (options.ifAvailable) return callback(null);
      await new Promise<void>((resolve, reject) => {
        const queue = this.#queues.get(name) ?? [];
        this.#queues.set(name, queue);
        queue.push(resolve);
        options.signal?.addEventListener('abort', () => {
          const i = queue.indexOf(resolve);
          if (i >= 0) queue.splice(i, 1);
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
    } else {
      this.#held.add(name);
    }
    try {
      return await callback({ name });
    } finally {
      const next = this.#queues.get(name)?.shift();
      if (next) next();
      else this.#held.delete(name);
    }
  }
}

test('Coordinator.compact on a follower runs on the leader', async (t) => {
  Object.defineProperty(navigator, 'locks', { value: new FakeLocks(), configurable: true });
  t.after(() => {
    delete (navigator as { locks?: unknown }).locks;
  });
  const leaderPersister = spyPersister(true);
  const leader = await Coordinator.open({
    name: 'compact-proxy',
    requestTimeoutMs: 200,
    makeEngine: () => Engine.create({ embedder, persister: leaderPersister }),
  });
  const follower = await Coordinator.open({
    name: 'compact-proxy',
    requestTimeoutMs: 200,
    makeEngine: () => Engine.create({ embedder }),
  });
  assert.equal(leader.role, 'leader');
  assert.equal(follower.role, 'follower');

  await follower.insert('one', 'a');
  await follower.insert('two', 'b');
  await follower.remove('a');
  await follower.compact();
  assert.deepEqual(leaderPersister.calls, ['rewrite']);
  assert.deepEqual(await follower.list(), [{ id: 'b', text: 'two' }]);

  await follower.close();
  await leader.close();
});

test('Ferrovec.compact sends a compact request to the worker', async () => {
  const posted: Array<Record<string, unknown>> = [];
  class RecordingWorker {
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onerror: ((event: unknown) => void) | null = null;
    postMessage(message: Record<string, unknown>): void {
      posted.push(message);
      const result = message.type === 'open' ? { ready: true, persistent: false, role: 'solo' } : { compacted: true };
      queueMicrotask(() => this.onmessage?.({ data: { id: message.id, ok: true, result } }));
    }
    terminate(): void {}
  }
  const g = globalThis as unknown as { Worker?: unknown };
  const original = g.Worker;
  g.Worker = RecordingWorker;
  try {
    const db = await Ferrovec.open('x', { requestPersistentStorage: false });
    await db.compact();
    assert.deepEqual(
      posted.map((m) => m.type),
      ['open', 'compact'],
    );
  } finally {
    g.Worker = original;
  }
});
