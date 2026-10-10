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
import { EmptyOverwriteRefusedError } from '../src/errors.ts';
import type { Embedder, Persister } from '../src/types.ts';

/** Exclusive-only fake LockManager: grants or (with ifAvailable) refuses; no queue. */
class FakeLocks {
  readonly held = new Set<string>();

  async request(
    name: string,
    options: { ifAvailable?: boolean; signal?: AbortSignal },
    callback: (lock: { name: string } | null) => unknown,
  ): Promise<unknown> {
    if (this.held.has(name)) {
      if (options.ifAvailable) return callback(null);
      throw new Error('FakeLocks: queued requests are not supported by this fake');
    }
    this.held.add(name);
    try {
      return await callback({ name });
    } finally {
      this.held.delete(name);
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
    markDirty() {},
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
