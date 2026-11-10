/**
 * Per-URL bookkeeping: normalised URL → {@link PageRecord}, in IndexedDB so
 * both the service worker (cheap "unchanged revisit" check) and the store host
 * (writes after indexing) can reach it. It is a cache of what the store holds
 * and can be rebuilt from `db.list()` ({@link recordsFromList}) if lost.
 */

import type { ChunkMeta, PageRecord } from './types.ts';

const DB_NAME = 'retrace-bookkeeping';
const STORE = 'pages';

let dbPromise: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = (): void => {
      request.result.createObjectStore(STORE, { keyPath: 'url' });
    };
    request.onsuccess = (): void => {
      const db = request.result;
      // Another context deleting/upgrading the database: let it, reopen next time.
      db.onversionchange = (): void => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    request.onerror = (): void => {
      dbPromise = null;
      reject(request.error ?? new Error('indexedDB.open failed'));
    };
  });
  return dbPromise;
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = (): void => resolve();
    tx.onerror = (): void => reject(tx.error ?? new Error('transaction failed'));
    tx.onabort = (): void => reject(tx.error ?? new Error('transaction aborted'));
  });
}

function result<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = (): void => resolve(request.result);
    request.onerror = (): void => reject(request.error ?? new Error('request failed'));
  });
}

export async function getPage(url: string): Promise<PageRecord | undefined> {
  const db = await open();
  return result(db.transaction(STORE).objectStore(STORE).get(url) as IDBRequest<PageRecord | undefined>);
}

export async function putPage(record: PageRecord): Promise<void> {
  const db = await open();
  const tx = db.transaction(STORE, 'readwrite');
  tx.objectStore(STORE).put(record);
  await done(tx);
}

/** Record a revisit of an unchanged page: newer `visitedAt` (and title), nothing else. */
export async function touchPage(url: string, visitedAt: string, title?: string): Promise<boolean> {
  const db = await open();
  const tx = db.transaction(STORE, 'readwrite');
  const store = tx.objectStore(STORE);
  const existing = (await result(store.get(url))) as PageRecord | undefined;
  if (existing) {
    if (Date.parse(visitedAt) > Date.parse(existing.visitedAt)) existing.visitedAt = visitedAt;
    if (title) existing.title = title;
    store.put(existing);
  }
  await done(tx);
  return existing !== undefined;
}

export async function allPages(): Promise<PageRecord[]> {
  const db = await open();
  return result(db.transaction(STORE).objectStore(STORE).getAll() as IDBRequest<PageRecord[]>);
}

export async function getPages(urls: readonly string[]): Promise<Map<string, PageRecord>> {
  const db = await open();
  const store = db.transaction(STORE).objectStore(STORE);
  const found = await Promise.all(
    urls.map((u) => result(store.get(u) as IDBRequest<PageRecord | undefined>)),
  );
  const out = new Map<string, PageRecord>();
  for (const record of found) if (record) out.set(record.url, record);
  return out;
}

export async function deletePages(urls: readonly string[]): Promise<void> {
  if (urls.length === 0) return;
  const db = await open();
  const tx = db.transaction(STORE, 'readwrite');
  const store = tx.objectStore(STORE);
  for (const url of urls) store.delete(url);
  await done(tx);
}

export async function putPages(records: readonly PageRecord[]): Promise<void> {
  if (records.length === 0) return;
  const db = await open();
  const tx = db.transaction(STORE, 'readwrite');
  const store = tx.objectStore(STORE);
  for (const record of records) store.put(record);
  await done(tx);
}

export async function clearPages(): Promise<void> {
  const db = await open();
  const tx = db.transaction(STORE, 'readwrite');
  tx.objectStore(STORE).clear();
  await done(tx);
}

export async function countPages(): Promise<number> {
  const db = await open();
  return result(db.transaction(STORE).objectStore(STORE).count());
}

/**
 * Rebuild bookkeeping from the store's own rows (`db.list()` pages): one
 * record per URL found in passage metadata. The text hash is unknown, so it is
 * left `''` and the next visit re-indexes the page, which is the safe choice.
 */
export function recordsFromList(
  rows: ReadonlyArray<{ id: string; metadata?: Record<string, unknown> }>,
): PageRecord[] {
  const byUrl = new Map<string, PageRecord>();
  for (const row of rows) {
    const meta = row.metadata as Partial<ChunkMeta> | undefined;
    if (!meta || typeof meta.url !== 'string') continue;
    const prefix = row.id.slice(0, row.id.lastIndexOf(':'));
    const visitedAt = typeof meta.visitedAt === 'string' ? meta.visitedAt : new Date(0).toISOString();
    const chunk = typeof meta.chunk === 'number' ? meta.chunk : 0;
    const existing = byUrl.get(meta.url);
    if (!existing) {
      byUrl.set(meta.url, {
        url: meta.url,
        urlHash: prefix,
        hash: '',
        chunks: Math.max(chunk + 1, typeof meta.of === 'number' ? meta.of : 0),
        title: typeof meta.title === 'string' ? meta.title : meta.url,
        host: typeof meta.host === 'string' ? meta.host : '',
        visitedAt,
        indexedAt: visitedAt,
      });
      continue;
    }
    existing.chunks = Math.max(existing.chunks, chunk + 1);
    if (Date.parse(visitedAt) > Date.parse(existing.visitedAt)) {
      existing.visitedAt = visitedAt;
      existing.indexedAt = visitedAt;
    }
  }
  return [...byUrl.values()];
}
