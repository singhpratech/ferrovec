/**
 * Browser test worker (fake embedder).
 *
 * Mirrors the production `src/worker.ts` orchestration — a {@link Coordinator}
 * that elects a leader (Web Locks), owns the OPFS-backed {@link Engine} when it
 * wins, and proxies to the leader over a BroadcastChannel when it does not — but
 * injects a deterministic in-worker embedder so the OPFS + cross-tab tests
 * exercise the *real* coordination/persistence code path (coordinator.ts,
 * persistence.ts, snapshot.ts, engine.ts, the wasm core's `toBytes`/`fromBytes`)
 * without downloading model weights. Driven over postMessage by the tests in
 * `opfs.test.ts` / `coord.test.ts` running in Chromium.
 */

import { Coordinator } from '../../src/coordinator.ts';
import { Engine } from '../../src/engine.ts';
import type { Embedder } from '../../src/types.ts';

const ctx = self as unknown as DedicatedWorkerGlobalScope;
const DIMS = 32;

/** Deterministic FNV-1a bag-of-tokens embedder (identical text → identical vec). */
function fakeEmbedder(slowEmbedMs = 0): Embedder {
  return {
    dims: DIMS,
    async embed(text: string): Promise<Float32Array> {
      // Simulate a slow (e.g. wasm-warmup) embed so a follower's request times
      // out and retries while the leader is still executing — exercises the
      // in-flight dedupe (MEDIUM-1: no double auto-id insert).
      if (slowEmbedMs > 0) await new Promise((r) => setTimeout(r, slowEmbedMs));
      const acc = new Array<number>(DIMS).fill(0);
      for (const token of text.toLowerCase().split(/\s+/).filter(Boolean)) {
        let h = 2166136261 >>> 0;
        for (let i = 0; i < token.length; i++) {
          h ^= token.charCodeAt(i);
          h = Math.imul(h, 16777619) >>> 0;
        }
        const idx = h % DIMS;
        acc[idx] = (acc[idx] ?? 0) + 1;
      }
      let norm = 0;
      for (const x of acc) norm += x * x;
      norm = Math.sqrt(norm) || 1;
      return Float32Array.from(acc, (x) => x / norm);
    },
  };
}

let store: Coordinator | null = null;

function requireStore(): Coordinator {
  if (!store) throw new Error('not open');
  return store;
}

interface Req {
  id: number;
  type: string;
  name?: string;
  persist?: boolean;
  text?: string;
  docId?: string;
  k?: number;
  // ---- fault-injection knobs (used by coord-defects.test.ts) ----
  /** Make the next N `makeEngine` calls throw (tests leader-init/promotion failure). */
  failEngineTimes?: number;
  /** Delay before `makeEngine` resolves, in ms (tests role-after-engine + open bound). */
  slowEngineMs?: number;
  /** Delay inside every `embed`, in ms (tests in-flight dedupe of retries). */
  slowEmbedMs?: number;
  /** Follower join-handshake bound, in ms. */
  openTimeoutMs?: number;
  /** Follower per-op bound, in ms. */
  opTimeoutMs?: number;
}

// Module-level so it survives across a failover *promotion* (a follower builds
// no engine at open; its first makeEngine call is the promotion attempt).
let failEngineRemaining = 0;

async function open(req: Req): Promise<{ persistent: boolean; role: string }> {
  if (typeof req.failEngineTimes === 'number') failEngineRemaining = req.failEngineTimes;
  const coordinator = await Coordinator.open({
    name: req.name ?? 'test',
    persist: req.persist,
    debounceMs: 50,
    requestTimeoutMs: 250,
    openTimeoutMs: req.openTimeoutMs,
    opTimeoutMs: req.opTimeoutMs,
    makeEngine: async ({ core, initialTexts, persister }) => {
      if (req.slowEngineMs && req.slowEngineMs > 0) {
        await new Promise((r) => setTimeout(r, req.slowEngineMs));
      }
      if (failEngineRemaining > 0) {
        failEngineRemaining--;
        throw new Error('injected engine build failure');
      }
      return Engine.create({ embedder: fakeEmbedder(req.slowEmbedMs), core, initialTexts, persister });
    },
  });
  store = coordinator;
  return { persistent: coordinator.persistent, role: coordinator.role };
}

async function handle(req: Req): Promise<unknown> {
  switch (req.type) {
    case 'open':
      return open(req);
    case 'insert':
      return { id: await requireStore().insert(req.text ?? '', req.docId) };
    case 'query':
      return { results: await requireStore().query(req.text ?? '', req.k ?? 5) };
    case 'size':
      return { size: await requireStore().size() };
    case 'flush':
      await requireStore().flush();
      return { flushed: true };
    case 'role':
      return { role: requireStore().role };
    case 'close': {
      const cur = store;
      store = null;
      if (cur) await cur.close();
      return { closed: true };
    }
    default:
      throw new Error(`unknown ${req.type}`);
  }
}

ctx.onmessage = (event: MessageEvent<Req>): void => {
  const req = event.data;
  handle(req).then(
    (result) => ctx.postMessage({ id: req.id, ok: true, result }),
    (err: unknown) =>
      ctx.postMessage({ id: req.id, ok: false, error: err instanceof Error ? err.message : String(err) }),
  );
};
