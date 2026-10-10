/**
 * Worker for the "notebook that remembers" demo page (`docs/remember.html`).
 *
 * Identical to the production worker (`src/worker.ts`) — the same Coordinator,
 * Engine, slot store and write-ahead log — with one addition: when the page
 * opens the store with the model id {@link HASHED_MODEL}, the engine is given
 * an in-worker hashed-trigram embedder instead of transformers.js, so the page
 * loads instantly with no model download. Any other model id (the page offers
 * MiniLM) goes through the production path, transformers.js included.
 *
 * The hashed embedder is lexical, not semantic: it hashes character trigrams
 * and words of the text into a fixed-width vector. Finding a note by a few of
 * its words works well; finding "cat" by "kitten" does not. The page says so.
 */

import { Coordinator } from '../src/coordinator.ts';
import { Engine } from '../src/engine.ts';
import { destroyStore } from '../src/persistence.ts';
import type { RoleChangeEvent, WorkerRequest, WorkerResponse } from '../src/protocol.ts';
import type { Embedder } from '../src/types.ts';

const ctx = self as unknown as DedicatedWorkerGlobalScope;

/** Model id the page passes to get the instant, download-free embedder. */
export const HASHED_MODEL = 'hashed-trigram-v1';
const HASHED_DIMS = 256;

function fnv1a(s: string, seed = 2166136261): number {
  let h = seed >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

/** Feature-hashed character trigrams + words, L2-normalised. Deterministic. */
function hashedEmbedder(): Embedder {
  return {
    id: HASHED_MODEL,
    dims: HASHED_DIMS,
    async embed(text: string): Promise<Float32Array> {
      const v = new Float32Array(HASHED_DIMS);
      const norm = text.toLowerCase().replace(/\s+/g, ' ').trim();
      const padded = ` ${norm} `;
      for (let i = 0; i + 3 <= padded.length; i++) {
        const h = fnv1a(padded.slice(i, i + 3));
        v[h % HASHED_DIMS] += (h & 0x80000000) ? -1 : 1;
      }
      for (const word of norm.split(' ')) {
        if (!word) continue;
        const h = fnv1a(word, 0x9747b28c);
        v[h % HASHED_DIMS] += (h & 0x80000000) ? -2 : 2;
      }
      let sum = 0;
      for (const x of v) sum += x * x;
      const inv = 1 / (Math.sqrt(sum) || 1);
      for (let i = 0; i < v.length; i++) v[i] *= inv;
      return v;
    },
  };
}

let store: Coordinator | null = null;

function requireStore(): Coordinator {
  if (!store) throw new Error('store is not open; send an "open" request first');
  return store;
}

async function open(request: Extract<WorkerRequest, { type: 'open' }>): Promise<Coordinator> {
  if (store) {
    const prev = store;
    store = null;
    await prev.close();
  }
  const model = request.model ?? HASHED_MODEL;
  const coordinator = await Coordinator.open({
    name: request.name,
    persist: request.persist,
    durability: request.durability,
    expectedModel: model,
    makeEngine: ({ core, initialTexts, initialMeta, replay, persister }) =>
      Engine.create({
        ...(model === HASHED_MODEL ? { embedder: hashedEmbedder() } : { model, device: request.device }),
        core,
        initialTexts,
        initialMeta,
        replay,
        persister,
      }),
  });
  coordinator.onRoleChange = (role): void => {
    const event: RoleChangeEvent = { type: 'event', event: 'role', role };
    ctx.postMessage(event);
  };
  store = coordinator;
  return coordinator;
}

async function handle(request: WorkerRequest): Promise<unknown> {
  switch (request.type) {
    case 'open': {
      const coordinator = await open(request);
      return { ready: true, persistent: coordinator.persistent, role: coordinator.role };
    }
    case 'insert':
      return { id: await requireStore().insert(request.text, request.docId) };
    case 'query':
      return requireStore().query(request.text, request.k);
    case 'remove':
      return { removed: await requireStore().remove(request.docId) };
    case 'size':
      return { size: await requireStore().size() };
    case 'list':
      return { documents: await requireStore().list({ offset: request.offset, limit: request.limit }) };
    case 'flush':
      await requireStore().flush();
      return { flushed: true };
    case 'role':
      return { role: requireStore().role };
    case 'close': {
      const current = store;
      store = null;
      if (current) await current.close();
      return { closed: true };
    }
    case 'destroy':
      if (store) throw new Error('cannot destroy a store while one is open in this worker');
      await destroyStore(request.name);
      return { destroyed: true };
  }
}

ctx.onmessage = (event: MessageEvent<WorkerRequest>): void => {
  const request = event.data;
  handle(request).then(
    (result) => {
      const response: WorkerResponse = { id: request.id, ok: true, result };
      ctx.postMessage(response);
    },
    (error: unknown) => {
      const response: WorkerResponse = {
        id: request.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        ...(error instanceof Error ? { errorName: error.name } : {}),
      };
      ctx.postMessage(response);
    },
  );
};
