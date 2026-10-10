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
 * `opfs.test.ts` / `coord.test.ts` / `durability.test.ts` running in Chromium.
 *
 * Durability test hooks (only legal while no store is open in this worker):
 * `corrupt` truncates one slot file (or `wal.bin`) in place (a simulated torn
 * write), `slots` reports each slot's size, decoded sequence and count plus the
 * write-ahead log's size, base sequence and record count, and `destroy` mirrors
 * the production worker's store deletion. `open` also reports every
 * `console.warn` the store emitted while opening (e.g. a torn log tail cut off),
 * which the chaos harness counts.
 */

import { Coordinator } from '../../src/coordinator.ts';
import { Engine } from '../../src/engine.ts';
import { destroyStore, sanitizeName } from '../../src/persistence.ts';
import { decodeSnapshot } from '../../src/snapshot.ts';
import type { Durability, Embedder } from '../../src/types.ts';
import { decodeWalHeader, scanWal } from '../../src/wal.ts';

const ctx = self as unknown as DedicatedWorkerGlobalScope;
const DIMS = 32;

/** The fake embedder's model id unless an `open` request names another. */
const FAKE_MODEL = 'fake-fnv1a-32';

/** Deterministic FNV-1a bag-of-tokens embedder (identical text → identical vec). */
function fakeEmbedder(slowEmbedMs = 0, id = FAKE_MODEL): Embedder {
  return {
    id,
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
  /** Model id reported by the fake embedder (and expected of the store). */
  model?: string;
  /** Durability mode for `open`. Defaults to the store's default (`'strict'`). */
  durability?: Durability;
  /** Checkpoint after this many log records (store default when omitted). */
  checkpointRecords?: number;
  /** Checkpoint after this many log bytes (store default when omitted). */
  checkpointBytes?: number;
  /** `corrupt`: which file to truncate — a slot, or the write-ahead log. */
  slot?: 'a' | 'b' | 'wal';
  /** `corrupt`: new length of the file. */
  truncateTo?: number;
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
  /**
   * Make the leader's snapshot producer report `count: 0` regardless of the
   * index's contents: over a non-empty on-disk store with no removes, the next
   * commit (e.g. the final one in close) trips the empty-overwrite guard.
   */
  emptySnapshot?: boolean;
}

// Module-level so it survives across a failover *promotion* (a follower builds
// no engine at open; its first makeEngine call is the promotion attempt).
let failEngineRemaining = 0;

async function open(req: Req): Promise<{ persistent: boolean; role: string; warnings: string[] }> {
  if (typeof req.failEngineTimes === 'number') failEngineRemaining = req.failEngineTimes;
  // Capture what the store warns about while opening (torn log tail, discarded
  // log header, ...) so a harness can count recoveries; still forward to the
  // real console.
  const warnings: string[] = [];
  const realWarn = console.warn;
  console.warn = (...args: unknown[]): void => {
    warnings.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' '));
    realWarn.apply(console, args);
  };
  try {
    store = await openCoordinator(req);
  } finally {
    console.warn = realWarn;
  }
  return { persistent: store.persistent, role: store.role, warnings };
}

function openCoordinator(req: Req): Promise<Coordinator> {
  return Coordinator.open({
    name: req.name ?? 'test',
    persist: req.persist,
    durability: req.durability,
    checkpointRecords: req.checkpointRecords,
    checkpointBytes: req.checkpointBytes,
    expectedModel: req.model ?? FAKE_MODEL,
    requestTimeoutMs: 250,
    openTimeoutMs: req.openTimeoutMs,
    opTimeoutMs: req.opTimeoutMs,
    makeEngine: async ({ core, initialTexts, initialMeta, replay, persister }) => {
      if (req.slowEngineMs && req.slowEngineMs > 0) {
        await new Promise((r) => setTimeout(r, req.slowEngineMs));
      }
      if (failEngineRemaining > 0) {
        failEngineRemaining--;
        throw new Error('injected engine build failure');
      }
      const engine = await Engine.create({
        embedder: fakeEmbedder(req.slowEmbedMs, req.model ?? FAKE_MODEL),
        core,
        initialTexts,
        initialMeta,
        replay,
        persister,
      });
      if (req.emptySnapshot) {
        const real = engine.snapshot.bind(engine);
        engine.snapshot = () => {
          const snap = real();
          return { ...snap, meta: { ...snap.meta, count: 0 } };
        };
      }
      return engine;
    },
  });
}

/** The store's OPFS directory (must already exist). */
async function storeDir(name: string): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  const base = await root.getDirectoryHandle('ferrovec');
  return base.getDirectoryHandle(sanitizeName(name));
}

interface SyncHandle {
  truncate(n: number): void;
  flush(): void;
  close(): void;
}

/** Test hook: truncate a slot file (or the log) in place, simulating a torn write. */
async function corrupt(req: Req): Promise<{ corrupted: true }> {
  if (store) throw new Error('corrupt is only legal with no store open in this worker');
  const dir = await storeDir(req.name ?? 'test');
  const file = await dir.getFileHandle(req.slot === 'wal' ? 'wal.bin' : `slot-${req.slot ?? 'a'}.bin`);
  const handle = await (
    file as unknown as { createSyncAccessHandle(): Promise<SyncHandle> }
  ).createSyncAccessHandle();
  try {
    handle.truncate(req.truncateTo ?? 0);
    handle.flush();
  } finally {
    handle.close();
  }
  return { corrupted: true };
}

interface SlotInfo {
  size: number;
  sequence: number | null;
  count: number | null;
}
interface WalInfo {
  size: number;
  /** Header base sequence; `null` when the log has no valid header. */
  base: number | null;
  records: number;
}

/**
 * Read a store file's bytes. A just-terminated worker's sync access handle is
 * released asynchronously and blocks `getFile()` meanwhile, so retry briefly.
 * Resolves `null` if the file does not exist.
 */
async function readStoreFile(dir: FileSystemDirectoryHandle, name: string): Promise<Uint8Array | null> {
  for (let attempt = 0; ; attempt++) {
    try {
      const handle = await dir.getFileHandle(name);
      return new Uint8Array(await (await handle.getFile()).arrayBuffer());
    } catch (err) {
      if ((err as { name?: string })?.name === 'NotFoundError') return null;
      if (attempt >= 100) throw err;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}

/** Test hook: each slot's size, decoded sequence and count, and the log's shape. */
async function slots(req: Req): Promise<{ a: SlotInfo; b: SlotInfo; wal: WalInfo }> {
  if (store) throw new Error('slots is only legal with no store open in this worker');
  const dir = await storeDir(req.name ?? 'test');
  const out: Record<string, SlotInfo> = {};
  for (const slot of ['a', 'b']) {
    const bytes = (await readStoreFile(dir, `slot-${slot}.bin`)) ?? new Uint8Array(0);
    let sequence: number | null = null;
    let count: number | null = null;
    try {
      const decoded = decodeSnapshot(bytes);
      sequence = Number(decoded.sequence);
      count = decoded.meta?.count ?? null;
    } catch {
      /* torn / empty */
    }
    out[slot] = { size: bytes.length, sequence, count };
  }
  const walBytes = (await readStoreFile(dir, 'wal.bin')) ?? new Uint8Array(0);
  const wal: WalInfo = { size: walBytes.length, base: null, records: 0 };
  try {
    const header = decodeWalHeader(walBytes);
    wal.base = Number(header.baseSequence);
    wal.records = scanWal(walBytes, header.dims).records.length;
  } catch {
    /* empty / header-less log */
  }
  return { a: out.a!, b: out.b!, wal };
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
    case 'corrupt':
      return corrupt(req);
    case 'slots':
      return slots(req);
    case 'destroy':
      if (store) throw new Error('cannot destroy a store while one is open in this worker');
      await destroyStore(req.name ?? 'test');
      return { destroyed: true };
    default:
      throw new Error(`unknown ${req.type}`);
  }
}

ctx.onmessage = (event: MessageEvent<Req>): void => {
  const req = event.data;
  handle(req).then(
    (result) => ctx.postMessage({ id: req.id, ok: true, result }),
    (err: unknown) =>
      ctx.postMessage({
        id: req.id,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        errorName: err instanceof Error ? err.name : undefined,
      }),
  );
};
