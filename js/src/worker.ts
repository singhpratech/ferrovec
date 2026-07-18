/**
 * The dedicated Web Worker.
 *
 * Instantiates a single {@link Engine} and dispatches the message protocol from
 * {@link WorkerRequest} to it, posting {@link WorkerResponse} back with the
 * originating correlation id. Deliberately thin — all real work lives in Engine.
 */

import { createCoreFromBytes } from './core-loader.ts';
import { Engine } from './engine.ts';
import { openStore } from './persistence.ts';
import type { WorkerRequest, WorkerResponse } from './protocol.ts';
import { decodeSnapshot } from './snapshot.ts';
import type { VectorCore } from './types.ts';

// In a dedicated worker `self` is a DedicatedWorkerGlobalScope; the DOM lib
// (also enabled) types it as `Window`, so narrow it explicitly.
const ctx = self as unknown as DedicatedWorkerGlobalScope;

let engine: Engine | null = null;

function requireEngine(): Engine {
  if (!engine) {
    throw new Error('engine is not open; send an "open" request first');
  }
  return engine;
}

/**
 * Build (or rehydrate) an {@link Engine} wired to an OPFS-backed store.
 *
 * When the store yielded bytes from a previous session we decode them and
 * rebuild the core via `fromBytes`; otherwise we let {@link Engine.create}
 * build a fresh core sized to the embedder. Either way the store is bound to
 * the engine's snapshot source before returning, so subsequent mutations
 * persist. Returns whether the resulting engine is actually persistent.
 */
async function open(request: Extract<WorkerRequest, { type: 'open' }>): Promise<boolean> {
  const store = await openStore(request.name, { persist: request.persist });

  let core: VectorCore | undefined;
  let initialTexts: Map<string, string> | undefined;
  if (store.initialBytes && store.initialBytes.length > 0) {
    const { core: coreBytes, texts } = decodeSnapshot(store.initialBytes);
    if (coreBytes.length > 0) {
      core = await createCoreFromBytes(coreBytes);
      initialTexts = texts;
    }
  }

  const created = await Engine.create({
    model: request.model,
    device: request.device,
    persister: store,
    core,
    initialTexts,
  });
  engine = created;
  // Bind to this specific instance, not the module `engine` global: `close`
  // nulls the global before the final flush runs, and that flush must still be
  // able to snapshot the engine it belongs to.
  store.bind(() => created.snapshot());
  return store.persistent;
}

async function handle(request: WorkerRequest): Promise<unknown> {
  switch (request.type) {
    case 'open': {
      const persistent = await open(request);
      return { ready: true, persistent };
    }
    case 'insert':
      return { id: await requireEngine().insert(request.text, request.docId) };
    case 'query':
      return requireEngine().query(request.text, request.k);
    case 'remove':
      return { removed: requireEngine().remove(request.docId) };
    case 'size':
      return { size: requireEngine().size() };
    case 'close': {
      const current = engine;
      engine = null;
      if (current) await current.close();
      return { closed: true };
    }
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
      };
      ctx.postMessage(response);
    },
  );
};
