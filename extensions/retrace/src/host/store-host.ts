/**
 * The store host: owns the one {@link Ferrovec} client (its worker, the wasm
 * core, the model, the OPFS store) and serialises every write to it.
 *
 * Platform-neutral: on Chrome it runs in the offscreen document (see
 * `offscreen.ts`); a Firefox port would run it in the background page. It
 * reaches the outside world only through the request handler it exposes.
 *
 * - Index jobs go through one FIFO queue, processed one at a time, so inserts
 *   are serialised and a burst of page visits never piles onto the embedder.
 *   A newer job for a URL already waiting replaces the waiting one, and the
 *   queue is bounded ({@link MAX_PENDING}); jobs beyond it are dropped and
 *   counted (they are re-indexed on the next visit).
 * - Forget / delete operations run through the same queue, so they never
 *   interleave with a half-indexed page.
 * - Searches do not queue: they run concurrently with indexing.
 * - After {@link HostOptions.idleMs} without work the host closes the store
 *   (checkpointing it) and reports itself closed so the platform can free it.
 */

import { Ferrovec, type FerrovecOptions } from 'ferrovec';

import {
  allPages,
  clearPages,
  countPages,
  deletePages,
  getPage,
  getPages,
  putPage,
  putPages,
  recordsFromList,
  touchPage,
} from '../lib/bookkeeping.ts';
import { chunkText } from '../lib/chunk.ts';
import { chunkId } from '../lib/hash.ts';
import type {
  ChunkMeta,
  ExportData,
  ForgetResult,
  Hit,
  HostRequest,
  HostStatus,
  IndexJob,
  PageRecord,
  Stats,
} from '../lib/types.ts';

export const STORE_NAME = 'retrace';
export const MODEL = 'Xenova/all-MiniLM-L6-v2';
/** Most index jobs allowed to wait; older ones beyond this are dropped. */
export const MAX_PENDING = 200;
const TIMING_WINDOW = 500;
const LIST_PAGE = 1000;
/**
 * Re-indexing a changed page replaces its passages, and ferrovec keeps the
 * replaced vectors as tombstones until `compact()`. Once this many passages
 * have been replaced or removed, the host compacts before it goes idle.
 */
export const COMPACT_AFTER_REPLACED = 2000;
const REPLACED_KEY = 'retrace.replacedSinceCompact';

export class HostClosedError extends Error {
  override name = 'HostClosedError';
}

export interface HostOptions {
  /** Base URL the bundled `models/` and `ort/` directories are served from. */
  assetBase: string;
  /** Close the store after this long without work. */
  idleMs: number;
  /** Called once the host has closed itself for idleness. */
  onClosed: () => void;
}

type Task =
  | { kind: 'index'; job: IndexJob }
  | {
      kind: 'run';
      run: () => Promise<unknown>;
      resolve: (value: unknown) => void;
      reject: (err: unknown) => void;
    };

export function ferrovecOptions(assetBase: string): FerrovecOptions {
  const asset = (path: string): string => new URL(path, assetBase).href;
  return {
    model: MODEL,
    device: 'wasm',
    durability: 'strict',
    transformers: {
      dtype: 'q8',
      env: {
        allowRemoteModels: false,
        allowLocalModels: true,
        localModelPath: asset('models/'),
        useBrowserCache: false,
        useWasmCache: false,
        wasmPaths: {
          mjs: asset('ort/ort-wasm-simd-threaded.mjs'),
          wasm: asset('ort/ort-wasm-simd-threaded.wasm'),
        },
        numThreads: 1,
      },
    },
  };
}

export class StoreHost {
  readonly #options: HostOptions;
  #db: Promise<Ferrovec> | null = null;
  #queue: Task[] = [];
  #busy = false;
  #closing = false;
  #closed = false;
  #idleTimer: ReturnType<typeof setTimeout> | null = null;
  #inflight = 0;
  /** Set while delete-all destroys the store; opens wait for it. */
  #resetting: Promise<unknown> | null = null;
  #status = {
    indexed: 0,
    unchanged: 0,
    dropped: 0,
    jobMs: [] as number[],
    jobChunks: [] as number[],
    lastError: null as string | null,
    openMs: null as number | null,
    compactMs: [] as number[],
  };
  #persistent = false;

  constructor(options: HostOptions) {
    this.#options = options;
  }

  // -------------------------------------------------------------------------
  // Request entry point
  // -------------------------------------------------------------------------

  async handle(req: HostRequest): Promise<unknown> {
    if (req.op === 'ping') return { closed: this.#closed || this.#closing };
    if (this.#closed || this.#closing) throw new HostClosedError('store host is closed');
    this.#inflight++;
    this.#cancelIdle();
    try {
      return await this.#dispatch(req);
    } finally {
      this.#inflight--;
      this.#scheduleIdle();
    }
  }

  async #dispatch(req: HostRequest): Promise<unknown> {
    switch (req.op) {
      case 'index':
        this.#enqueueIndex(req.job);
        this.#pump();
        return { queued: true, pending: this.#pendingCount() };
      case 'search':
        return this.#search(req.q, req.k);
      case 'status':
        return this.#statusSnapshot();
      case 'stats':
        return this.#stats();
      case 'pages': {
        const pages = await allPages();
        pages.sort((a, b) => Date.parse(b.visitedAt) - Date.parse(a.visitedAt));
        return pages.slice(0, req.limit);
      }
      case 'forget-host':
        return this.#serial(() => this.#forget((m) => hostIs(m.host, req.host), (p) => hostIs(p.host, req.host)));
      case 'forget-since': {
        const since = Date.parse(req.since);
        if (Number.isNaN(since)) throw new TypeError(`bad time: ${req.since}`);
        return this.#serial(() =>
          this.#forget(
            (m) => Date.parse(m.visitedAt) >= since,
            (p) => Date.parse(p.visitedAt) >= since,
          ),
        );
      }
      case 'delete-all':
        return this.#serial(() => this.#deleteAll());
      case 'export':
        return this.#serial(() => this.#export());
      case 'wait-idle':
        return this.#waitIdle(req.timeoutMs);
      default:
        throw new TypeError(`unknown host op ${(req as { op: string }).op}`);
    }
  }

  // -------------------------------------------------------------------------
  // Store lifecycle
  // -------------------------------------------------------------------------

  async #open(): Promise<Ferrovec> {
    while (this.#resetting) await this.#resetting.catch(() => undefined);
    this.#db ??= (async () => {
      const t0 = performance.now();
      const db = await Ferrovec.open(STORE_NAME, ferrovecOptions(this.#options.assetBase));
      this.#status.openMs = Math.round(performance.now() - t0);
      this.#persistent = db.persistent;
      await this.#rebuildBookkeepingIfLost(db);
      return db;
    })().catch((err: unknown) => {
      this.#db = null;
      this.#status.lastError = `open failed: ${errorText(err)}`;
      throw err;
    });
    return this.#db;
  }

  /** Bookkeeping is a cache: if it is empty while the store is not, rebuild it from the store. */
  async #rebuildBookkeepingIfLost(db: Ferrovec): Promise<void> {
    if ((await countPages()) > 0 || (await db.size()) === 0) return;
    const rows = await listAll(db);
    await putPages(recordsFromList(rows));
  }

  #scheduleIdle(): void {
    this.#cancelIdle();
    if (!this.#isIdle()) return;
    this.#idleTimer = setTimeout(() => void this.#closeForIdle(), this.#options.idleMs);
  }

  #cancelIdle(): void {
    if (this.#idleTimer !== null) clearTimeout(this.#idleTimer);
    this.#idleTimer = null;
  }

  #isIdle(): boolean {
    return !this.#busy && this.#queue.length === 0 && this.#inflight === 0;
  }

  async #closeForIdle(): Promise<void> {
    if (!this.#isIdle() || this.#closing || this.#closed) return;
    if (this.#db && replacedSinceCompact() >= COMPACT_AFTER_REPLACED) {
      // Reclaim tombstones while nobody is waiting; the idle timer re-arms after.
      void this.#serial(() => this.#compact()).catch((err: unknown) => {
        this.#status.lastError = `compact failed: ${errorText(err)}`;
      });
      return;
    }
    this.#closing = true;
    try {
      const db = await this.#db?.catch(() => null);
      await db?.close();
    } finally {
      this.#closed = true;
      this.#closing = false;
      this.#options.onClosed();
    }
  }

  #waitIdle(timeoutMs: number): Promise<HostStatus> {
    return new Promise((resolve, reject) => {
      // `handle()` counts this request as in flight; idle means "no other work".
      const check = (): boolean => !this.#busy && this.#queue.length === 0;
      if (check()) return resolve(this.#statusSnapshot());
      const timer = setTimeout(() => reject(new Error('wait-idle timed out')), timeoutMs);
      const poll = setInterval(() => {
        if (!check()) return;
        clearInterval(poll);
        clearTimeout(timer);
        resolve(this.#statusSnapshot());
      }, 50);
    });
  }

  // -------------------------------------------------------------------------
  // The queue
  // -------------------------------------------------------------------------

  #pendingCount(): number {
    return this.#queue.filter((t) => t.kind === 'index').length;
  }

  #enqueueIndex(job: IndexJob): void {
    const waiting = this.#queue.findIndex((t) => t.kind === 'index' && t.job.url === job.url);
    if (waiting >= 0) {
      this.#queue[waiting] = { kind: 'index', job };
      return;
    }
    this.#queue.push({ kind: 'index', job });
    while (this.#pendingCount() > MAX_PENDING) {
      const oldest = this.#queue.findIndex((t) => t.kind === 'index');
      this.#queue.splice(oldest, 1);
      this.#status.dropped++;
    }
  }

  /** Run `fn` in queue order (after every job queued before it). */
  #serial<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.#queue.push({
        kind: 'run',
        run: fn,
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      this.#pump();
    });
  }

  #pump(): void {
    if (this.#busy) return;
    const task = this.#queue.shift();
    if (!task) {
      this.#scheduleIdle();
      return;
    }
    this.#busy = true;
    this.#cancelIdle();
    const run = async (): Promise<void> => {
      if (task.kind === 'index') {
        try {
          await this.#index(task.job);
        } catch (err) {
          this.#status.lastError = `index ${task.job.url}: ${errorText(err)}`;
          console.error('[retrace] indexing failed', task.job.url, err);
        }
      } else {
        try {
          task.resolve(await task.run());
        } catch (err) {
          task.reject(err);
        }
      }
    };
    void run().finally(() => {
      this.#busy = false;
      this.#pump();
    });
  }

  // -------------------------------------------------------------------------
  // Operations
  // -------------------------------------------------------------------------

  async #index(job: IndexJob): Promise<void> {
    const db = await this.#open();
    const t0 = performance.now();
    const previous = await getPage(job.url);
    if (previous && previous.hash === job.textHash) {
      await touchPage(job.url, job.visitedAt, job.title);
      this.#status.unchanged++;
      return;
    }
    const chunks = chunkText(job.text);
    const of = chunks.length;
    for (let i = 0; i < of; i++) {
      const metadata: ChunkMeta = {
        url: job.url,
        title: job.title,
        host: job.host,
        visitedAt: job.visitedAt,
        chunk: i,
        of,
      };
      await db.insert(chunks[i]!.text, { id: chunkId(job.urlHash, i), metadata });
    }
    // The page shrank: drop the passages past its new end.
    for (let i = of; i < (previous?.chunks ?? 0); i++) {
      await db.remove(chunkId(previous?.urlHash ?? job.urlHash, i));
    }
    // Every passage the page had before is now a tombstone in the index.
    if (previous) addReplaced(previous.chunks);
    await putPage({
      url: job.url,
      urlHash: job.urlHash,
      hash: job.textHash,
      chunks: of,
      title: job.title,
      host: job.host,
      visitedAt: job.visitedAt,
      indexedAt: new Date().toISOString(),
    });
    this.#status.indexed++;
    pushWindow(this.#status.jobMs, Math.round(performance.now() - t0));
    pushWindow(this.#status.jobChunks, of);
  }

  async #search(q: string, k: number): Promise<Hit[]> {
    const text = q.trim();
    if (!text) return [];
    const db = await this.#open();
    const rows = await db.query(text, Math.max(1, Math.min(k, 500)));
    const hits: Hit[] = [];
    for (const row of rows) {
      const meta = row.metadata as ChunkMeta | undefined;
      if (!meta || typeof meta.url !== 'string') continue;
      hits.push({ id: row.id, text: row.text ?? '', score: row.score, meta });
    }
    const visits = await getPages([...new Set(hits.map((h) => h.meta.url))]);
    for (const hit of hits) {
      const visitedAt = visits.get(hit.meta.url)?.visitedAt;
      if (visitedAt) hit.lastVisitedAt = visitedAt;
    }
    return hits;
  }

  /**
   * Remove every passage whose metadata matches, and every bookkeeping record
   * that matches. Scans the store itself (not just bookkeeping), so passages
   * are found even if bookkeeping is stale. Waiting index jobs for a matching
   * page are dropped too.
   */
  async #forget(
    matchPassage: (meta: ChunkMeta) => boolean,
    matchPage: (page: PageRecord) => boolean,
  ): Promise<ForgetResult> {
    const db = await this.#open();
    const rows = await listAll(db);
    const ids: string[] = [];
    const urls = new Set<string>();
    for (const row of rows) {
      const meta = row.metadata as ChunkMeta | undefined;
      if (meta && matchPassage(meta)) {
        ids.push(row.id);
        urls.add(meta.url);
      }
    }
    for (const page of await allPages()) if (matchPage(page)) urls.add(page.url);
    let passages = 0;
    for (const id of ids) if (await db.remove(id)) passages++;
    await deletePages([...urls]);
    this.#queue = this.#queue.filter(
      (t) =>
        t.kind !== 'index' ||
        !(matchPage({ ...t.job, hash: t.job.textHash, chunks: 0, indexedAt: t.job.visitedAt }) || urls.has(t.job.url)),
    );
    // Really delete: rebuild the index without the removed passages and
    // rewrite both snapshot slots and the log, so no file of the store still
    // holds their text, vectors or ids.
    if (passages > 0) await this.#compact();
    return { pages: urls.size, passages };
  }

  async #compact(): Promise<void> {
    const db = await this.#open();
    const t0 = performance.now();
    await db.compact();
    pushWindow(this.#status.compactMs, Math.round(performance.now() - t0));
    resetReplaced();
  }

  async #deleteAll(): Promise<ForgetResult> {
    const db = await this.#open();
    const passages = await db.size();
    const pages = await countPages();
    this.#queue = this.#queue.filter((t) => t.kind !== 'index');
    this.#db = null;
    const reset = (async () => {
      await db.close();
      await Ferrovec.destroy(STORE_NAME);
      await clearPages();
      resetReplaced();
    })();
    this.#resetting = reset;
    try {
      await reset;
    } finally {
      this.#resetting = null;
    }
    return { pages, passages };
  }

  async #export(): Promise<ExportData> {
    const db = await this.#open();
    const passages = (await listAll(db)).map((row) => ({
      id: row.id,
      text: row.text,
      ...(row.metadata ? { metadata: row.metadata } : {}),
    }));
    return {
      format: 'retrace-export',
      version: 1,
      exportedAt: new Date().toISOString(),
      model: MODEL,
      pages: await allPages(),
      passages,
    };
  }

  async #stats(): Promise<Stats> {
    const db = await this.#open();
    let usageBytes: number | null = null;
    let quotaBytes: number | null = null;
    try {
      const estimate = await navigator.storage.estimate();
      usageBytes = estimate.usage ?? null;
      quotaBytes = estimate.quota ?? null;
    } catch {
      /* unavailable */
    }
    return {
      pages: await countPages(),
      passages: await db.size(),
      usageBytes,
      quotaBytes,
      ...(await opfsFiles()),
      persistent: this.#persistent,
    };
  }

  #statusSnapshot(): HostStatus {
    return {
      open: this.#db !== null,
      pending: this.#pendingCount(),
      busy: this.#busy,
      indexed: this.#status.indexed,
      unchanged: this.#status.unchanged,
      dropped: this.#status.dropped,
      jobMs: [...this.#status.jobMs],
      jobChunks: [...this.#status.jobChunks],
      lastError: this.#status.lastError,
      openMs: this.#status.openMs,
      compactMs: [...this.#status.compactMs],
    };
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function hostIs(host: string, wanted: string): boolean {
  const w = wanted.trim().toLowerCase();
  return w !== '' && (host === w || host.endsWith(`.${w}`));
}

/** Replaced/removed passages since the last compaction (survives the host closing). */
function replacedSinceCompact(): number {
  try {
    return Number(localStorage.getItem(REPLACED_KEY) ?? '0') || 0;
  } catch {
    return 0;
  }
}

function addReplaced(n: number): void {
  try {
    localStorage.setItem(REPLACED_KEY, String(replacedSinceCompact() + n));
  } catch {
    /* no storage: compaction then only follows forget operations */
  }
}

function resetReplaced(): void {
  try {
    localStorage.removeItem(REPLACED_KEY);
  } catch {
    /* ignore */
  }
}

function pushWindow(list: number[], value: number): void {
  list.push(value);
  if (list.length > TIMING_WINDOW) list.splice(0, list.length - TIMING_WINDOW);
}

function errorText(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

async function listAll(db: Ferrovec): Promise<Awaited<ReturnType<Ferrovec['list']>>> {
  const out: Awaited<ReturnType<Ferrovec['list']>> = [];
  for (let offset = 0; ; offset += LIST_PAGE) {
    const page = await db.list({ offset, limit: LIST_PAGE });
    out.push(...page);
    if (page.length < LIST_PAGE) return out;
  }
}

/**
 * Sizes of the files under the OPFS root (ferrovec's store: two snapshot
 * slots and the write-ahead log), and their total; nulls when unmeasurable.
 */
async function opfsFiles(): Promise<{ storeBytes: number | null; storeFiles: Record<string, number> | null }> {
  try {
    const root = await navigator.storage.getDirectory();
    const files: Record<string, number> = {};
    const walk = async (dir: FileSystemDirectoryHandle, prefix: string): Promise<void> => {
      // `values()` is missing from older DOM typings.
      const entries = (dir as unknown as { values(): AsyncIterable<FileSystemHandle> }).values();
      for await (const entry of entries) {
        if (entry.kind === 'file') files[prefix + entry.name] = (await (entry as FileSystemFileHandle).getFile()).size;
        else await walk(entry as FileSystemDirectoryHandle, `${prefix}${entry.name}/`);
      }
    };
    await walk(root, '');
    return { storeBytes: Object.values(files).reduce((a, b) => a + b, 0), storeFiles: files };
  } catch {
    return { storeBytes: null, storeFiles: null };
  }
}
