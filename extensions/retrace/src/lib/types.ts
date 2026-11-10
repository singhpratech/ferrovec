/** Shared data shapes and the message protocol between Retrace's contexts. */

/** Metadata stored with every passage in the ferrovec store. */
export interface ChunkMeta {
  [key: string]: string | number;
  url: string;
  title: string;
  host: string;
  /** ISO time of the visit that (re)indexed this passage. */
  visitedAt: string;
  /** 0-based passage index within the page. */
  chunk: number;
  /** Number of passages indexed for the page. */
  of: number;
}

/** One ranked passage, as the store host returns it to the UI. */
export interface Hit {
  id: string;
  text: string;
  score: number;
  meta: ChunkMeta;
  /** Latest visit of the page from bookkeeping (newer than `meta.visitedAt` after an unchanged revisit). */
  lastVisitedAt?: string;
}

/** Bookkeeping entry per normalised URL. */
export interface PageRecord {
  url: string;
  /** Prefix of every passage id of this page: ids are `${urlHash}:${i}`. */
  urlHash: string;
  /** SHA-256 of the extracted text; `''` when unknown (rebuilt from the store). */
  hash: string;
  /** Number of passages stored for the page. */
  chunks: number;
  title: string;
  host: string;
  /** ISO time of the latest visit. */
  visitedAt: string;
  /** ISO time the passages were last written. */
  indexedAt: string;
}

export interface Settings {
  paused: boolean;
  /** Blocklist patterns (see blocklist.ts). */
  blocklist: string[];
}

/** What the content script extracts from a page. */
export interface ExtractedPage {
  url: string;
  title: string;
  text: string;
  lang: string;
}

/** A page ready for the store host: normalised, hashed, accepted by the privacy rules. */
export interface IndexJob {
  url: string;
  urlHash: string;
  host: string;
  title: string;
  text: string;
  textHash: string;
  visitedAt: string;
}

export interface Stats {
  pages: number;
  passages: number;
  /** `navigator.storage.estimate().usage` for the extension origin (store + bookkeeping + caches). */
  usageBytes: number | null;
  quotaBytes: number | null;
  /** Bytes of the ferrovec store's files in OPFS, when they can be measured. */
  storeBytes: number | null;
  /** Per-file sizes in OPFS (snapshot slots, write-ahead log). */
  storeFiles: Record<string, number> | null;
  persistent: boolean;
}

export interface HostStatus {
  open: boolean;
  /** Index jobs waiting. */
  pending: number;
  busy: boolean;
  /** Index jobs completed since the host started (re-indexes included). */
  indexed: number;
  /** Jobs skipped because the text had not changed. */
  unchanged: number;
  /** Jobs dropped because the queue was full. */
  dropped: number;
  /** Milliseconds per completed index job, oldest first (last 500). */
  jobMs: number[];
  /** Passages per completed index job, aligned with `jobMs`. */
  jobChunks: number[];
  /** The last error the host hit, if any. */
  lastError: string | null;
  /** Milliseconds `Ferrovec.open` took (model load + rehydrate), once open. */
  openMs: number | null;
  /** Milliseconds of each `compact()` the host ran (forget operations, tombstone cleanup). */
  compactMs: number[];
}

export interface ExportData {
  format: 'retrace-export';
  version: 1;
  exportedAt: string;
  model: string;
  pages: PageRecord[];
  passages: Array<{ id: string; text: string; metadata?: Record<string, unknown> }>;
}

export interface ForgetResult {
  pages: number;
  passages: number;
}

/** Requests the service worker forwards to the store host. */
export type HostRequest =
  | { op: 'index'; job: IndexJob }
  | { op: 'search'; q: string; k: number }
  | { op: 'stats' }
  | { op: 'status' }
  | { op: 'pages'; limit: number }
  | { op: 'forget-host'; host: string }
  | { op: 'forget-since'; since: string }
  | { op: 'delete-all' }
  | { op: 'export' }
  | { op: 'wait-idle'; timeoutMs: number }
  | { op: 'ping' };

/** Requests UI pages and the content script send to the service worker. */
export type BackgroundRequest =
  | { kind: 'page'; page: ExtractedPage }
  | { kind: 'search'; q: string; k?: number }
  | { kind: 'stats' }
  | { kind: 'status' }
  | { kind: 'pages'; limit?: number }
  | { kind: 'forget-host'; host: string }
  | { kind: 'forget-since'; since: string }
  | { kind: 'delete-all' }
  | { kind: 'export' }
  | { kind: 'wait-idle'; timeoutMs?: number }
  | { kind: 'get-settings' }
  | { kind: 'set-settings'; patch: Partial<Settings> }
  | { kind: 'host-closed' };

/** Outcome of a `page` message. */
export type PageOutcome =
  | { status: 'queued' }
  | { status: 'unchanged' }
  | { status: 'skipped'; reason: 'paused' | 'blocked' | 'incognito' | 'not-http' | 'too-short' };

/** Envelope every cross-context response travels in. */
export type Reply<T = unknown> = { ok: true; result: T } | { ok: false; error: string; name?: string };
