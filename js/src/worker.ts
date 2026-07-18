/**
 * The dedicated Web Worker.
 *
 * Instantiates a single {@link Coordinator} for the opened store and dispatches
 * the message protocol from {@link WorkerRequest} to it, posting
 * {@link WorkerResponse} back with the originating correlation id. The
 * coordinator handles cross-tab leader election (M6): this worker is either the
 * leader that owns the {@link Engine} + OPFS persistence, a follower proxying to
 * the leader, or solo when coordination is unavailable. Deliberately thin — all
 * real work lives in Coordinator/Engine.
 */

import { Coordinator } from './coordinator.ts';
import { Engine } from './engine.ts';
import type { RoleChangeEvent, WorkerRequest, WorkerResponse } from './protocol.ts';

// In a dedicated worker `self` is a DedicatedWorkerGlobalScope; the DOM lib
// (also enabled) types it as `Window`, so narrow it explicitly.
const ctx = self as unknown as DedicatedWorkerGlobalScope;

let store: Coordinator | null = null;

function requireStore(): Coordinator {
  if (!store) {
    throw new Error('store is not open; send an "open" request first');
  }
  return store;
}

/**
 * Open the coordinated store. The {@link Coordinator} elects a leader via the
 * Web Locks API; whichever worker wins builds the authoritative {@link Engine}
 * here (real transformers embedder + wasm core, rehydrated from OPFS when a
 * prior snapshot exists). Followers build no engine and proxy to the leader.
 */
async function open(request: Extract<WorkerRequest, { type: 'open' }>): Promise<Coordinator> {
  // Re-opening in the same worker: close the previous coordinator first so its
  // Web Lock + OPFS handle are released rather than leaked when `store` is
  // overwritten below.
  if (store) {
    const prev = store;
    store = null;
    await prev.close();
  }
  const coordinator = await Coordinator.open({
    name: request.name,
    persist: request.persist,
    makeEngine: ({ core, initialTexts, persister }) =>
      Engine.create({
        model: request.model,
        device: request.device,
        core,
        initialTexts,
        persister,
      }),
  });
  // Keep `db.role` live on the main thread across a failover promotion.
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
