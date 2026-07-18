/**
 * Browser test worker (fake embedder).
 *
 * Mirrors the production `src/worker.ts` orchestration — {@link openStore} →
 * decode snapshot → rehydrate/create core → {@link Engine} bound to the store —
 * but injects a deterministic in-worker embedder so the OPFS round-trip test
 * exercises the *real* persistence code path (persistence.ts, snapshot.ts,
 * engine.ts, the wasm core's `toBytes`/`fromBytes`) without downloading model
 * weights. Driven over postMessage by `opfs.test.ts` running in Chromium.
 */

import { createCoreFromBytes } from '../../src/core-loader.ts';
import { Engine } from '../../src/engine.ts';
import { openStore } from '../../src/persistence.ts';
import { decodeSnapshot } from '../../src/snapshot.ts';
import type { Embedder, VectorCore } from '../../src/types.ts';

const ctx = self as unknown as DedicatedWorkerGlobalScope;
const DIMS = 32;

/** Deterministic FNV-1a bag-of-tokens embedder (identical text → identical vec). */
function fakeEmbedder(): Embedder {
  return {
    dims: DIMS,
    async embed(text: string): Promise<Float32Array> {
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

let engine: Engine | null = null;

function requireEngine(): Engine {
  if (!engine) throw new Error('not open');
  return engine;
}

interface Req {
  id: number;
  type: string;
  name?: string;
  persist?: boolean;
  text?: string;
  docId?: string;
  k?: number;
}

async function open(req: Req): Promise<boolean> {
  const store = await openStore(req.name ?? 'test', { persist: req.persist, debounceMs: 50 });

  let core: VectorCore | undefined;
  let initialTexts: Map<string, string> | undefined;
  if (store.initialBytes && store.initialBytes.length > 0) {
    const decoded = decodeSnapshot(store.initialBytes);
    if (decoded.core.length > 0) {
      core = await createCoreFromBytes(decoded.core);
      initialTexts = decoded.texts;
    }
  }

  const created = await Engine.create({ embedder: fakeEmbedder(), core, initialTexts, persister: store });
  engine = created;
  store.bind(() => created.snapshot());
  return store.persistent;
}

async function handle(req: Req): Promise<unknown> {
  switch (req.type) {
    case 'open':
      return { persistent: await open(req) };
    case 'insert':
      return { id: await requireEngine().insert(req.text ?? '', req.docId) };
    case 'query':
      return { results: await requireEngine().query(req.text ?? '', req.k ?? 5) };
    case 'size':
      return { size: requireEngine().size() };
    case 'close': {
      const cur = engine;
      engine = null;
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
