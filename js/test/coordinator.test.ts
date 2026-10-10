/**
 * Coordinator lifecycle under Node, with a minimal fake `navigator.locks` (Node
 * 22 has `BroadcastChannel` but no Web Locks) so the coordinator takes the
 * leader path. OPFS is unavailable here, so the leader's store is in-memory;
 * the failing final commit is injected through the engine's persister.
 *
 * The real-OPFS version of this regression (an `EmptyOverwriteRefusedError`
 * from the slot store's guard) lives in `browser/durability.test.ts`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Coordinator } from '../src/coordinator.ts';
import { Engine } from '../src/engine.ts';
import { EmbeddingSpaceMismatchError, EmptyOverwriteRefusedError } from '../src/errors.ts';
import type { Embedder, Persister } from '../src/types.ts';

/**
 * Exclusive-only fake LockManager: grants, refuses (with `ifAvailable`), or
 * queues FIFO (abortable via `signal`), handing the lock straight to the next
 * waiter on release.
 */
class FakeLocks {
  readonly held = new Set<string>();
  readonly #queues = new Map<string, Array<() => void>>();

  async request(
    name: string,
    options: { ifAvailable?: boolean; signal?: AbortSignal },
    callback: (lock: { name: string } | null) => unknown,
  ): Promise<unknown> {
    if (this.held.has(name)) {
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
      // Handed over by the releasing holder: `held` stays set.
    } else {
      this.held.add(name);
    }
    try {
      return await callback({ name });
    } finally {
      const next = this.#queues.get(name)?.shift();
      if (next) next();
      else this.held.delete(name);
    }
  }
}

/** Records every BroadcastChannel the coordinator creates, and whether it was closed. */
const channels: Array<{ name: string; closed: boolean; close(): void }> = [];
class SpyChannel extends BroadcastChannel {
  closed = false;
  constructor(name: string) {
    super(name);
    channels.push(this);
  }
  override close(): void {
    this.closed = true;
    super.close();
  }
}

const embedder: Embedder = {
  id: 'fake-fnv1a-32',
  dims: 8,
  async embed(text: string): Promise<Float32Array> {
    const v = new Float32Array(8);
    v[text.length % 8] = 1;
    return v;
  },
};

test('leader close() releases the Web Lock and the channel even when the final commit throws', async (t) => {
  const locks = new FakeLocks();
  Object.defineProperty(navigator, 'locks', { value: locks, configurable: true });
  const RealChannel = globalThis.BroadcastChannel;
  globalThis.BroadcastChannel = SpyChannel;
  t.after(() => {
    delete (navigator as { locks?: unknown }).locks;
    globalThis.BroadcastChannel = RealChannel;
    for (const c of channels) if (!c.closed) c.close(); // never hang the runner
  });

  const failingPersister: Persister = {
    async append() {},
    async flush() {},
    async close() {
      throw new EmptyOverwriteRefusedError(3);
    },
  };

  const NAME = 'close-leak';
  const leader = await Coordinator.open({
    name: NAME,
    makeEngine: () => Engine.create({ embedder, persister: failingPersister }),
  });
  assert.equal(leader.role, 'leader');
  assert.equal(locks.held.has(`ferrovec-leader:${NAME}`), true);
  assert.equal(channels.length, 1);

  await assert.rejects(leader.close(), (err: unknown) => {
    assert.ok(err instanceof EmptyOverwriteRefusedError, 'the engine error is rethrown');
    return true;
  });
  // The lock callback's promise settles on the next turn after release().
  await new Promise((r) => setImmediate(r));
  assert.equal(locks.held.has(`ferrovec-leader:${NAME}`), false, 'Web Lock released');
  assert.equal(channels[0]!.closed, true, 'BroadcastChannel closed');

  // Proof by use: a second session immediately becomes leader of the same store.
  const next = await Coordinator.open({
    name: NAME,
    makeEngine: () => Engine.create({ embedder }),
  });
  assert.equal(next.role, 'leader');
  await next.close();
});

test('a follower still joining rejects open() promptly with the typed error when promotion fails permanently', async (t) => {
  const locks = new FakeLocks();
  Object.defineProperty(navigator, 'locks', { value: locks, configurable: true });
  const RealChannel = globalThis.BroadcastChannel;
  globalThis.BroadcastChannel = SpyChannel;
  t.after(() => {
    delete (navigator as { locks?: unknown }).locks;
    globalThis.BroadcastChannel = RealChannel;
    for (const c of channels) if (!c.closed) c.close();
  });

  const NAME = 'join-permfail';
  // A silent "leader": holds the Web Lock but never answers hello (no channel),
  // so the follower stays in its join handshake until it is promoted.
  let releaseHolder!: () => void;
  const holder = locks.request(`ferrovec-leader:${NAME}`, {}, () => new Promise<void>((r) => (releaseHolder = r)));

  const started = Date.now();
  const opening = Coordinator.open({
    name: NAME,
    requestTimeoutMs: 100,
    openTimeoutMs: 20_000, // the bug: open() used to wait this long
    makeEngine: async () => {
      throw new EmbeddingSpaceMismatchError(
        { model: 'stored-model', dims: 8, metric: 'cosine' },
        { model: 'fake-fnv1a-32', dims: 8, metric: 'cosine' },
      );
    },
  });
  // Let it join as a follower and queue for the lock, then hand the lock over.
  await new Promise((r) => setTimeout(r, 150));
  releaseHolder();
  await holder;

  await assert.rejects(opening, (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.equal(err.name, 'EmbeddingSpaceMismatchError', 'the typed name is copied');
    assert.match(err.message, /stored-model/);
    return true;
  });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 2000, `open() must reject promptly, took ${elapsed}ms`);
  await new Promise((r) => setImmediate(r));
  assert.equal(locks.held.has(`ferrovec-leader:${NAME}`), false, 'the follower released the lock');
});
