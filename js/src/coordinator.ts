/**
 * Cross-tab / cross-worker coordination for a single persistent store (M6).
 *
 * Today's OPFS persistence (M4) is backed by a `FileSystemSyncAccessHandle`,
 * which holds an **exclusive lock** on `index.bin`. If a second tab opens the
 * same store the handle throws and that tab silently degrades to in-memory — so
 * two tabs on one store diverge. M6 fixes this with **single-writer leader
 * election** so any number of tabs safely share one persistent store.
 *
 * ## Model: proxy (single writer, always consistent)
 *
 * We chose the **proxy** model (over a replica model) because it is trivially
 * consistent and directly verifiable: there is exactly one authoritative
 * {@link Engine}, so every reader sees every writer's effect immediately, and
 * there is no snapshot-hydration/merge machinery to get subtly wrong.
 *
 * - **One leader owns the store.** Election is via the **Web Locks API**: each
 *   store worker requests an exclusive lock named `ferrovec-leader:<name>`. The
 *   holder opens the OPFS store (see {@link openStore}) and owns the only
 *   {@link Engine} + persistence. Exactly one writer exists at a time, so the
 *   old lock-contention crash can never happen.
 * - **Followers** (did not win the lock) hold no core. They forward
 *   `insert`/`query`/`remove`/`size`/`flush` to the leader over a
 *   {@link BroadcastChannel} (`ferrovec-coord:<name>`) as correlation-id
 *   request/response messages and return the leader's answers.
 * - **Failover.** When the leader tab closes or crashes, its Web Lock releases;
 *   a waiting follower's queued `locks.request` callback runs and it *promotes*:
 *   it opens the OPFS store (rehydrating from `index.bin`) and becomes the new
 *   leader. In-flight follower requests are retried and transparently answered
 *   by the new leader. Because the promoting tab **holds the exclusive lock**, it
 *   is the legitimate owner of `index.bin`: OPFS contention there does **not**
 *   degrade to an empty in-memory store (which would serve `size()===0` over an
 *   intact on-disk index and discard writes) — it retries on a long deadline and,
 *   if the handle truly never frees or `index.bin` is corrupt, the promotion
 *   **fails loudly** and the tab **re-queues** for the lock rather than silently
 *   dropping out of the election (which would leave zero leaders forever).
 * - **Never crash, always degrade.** If `navigator.locks` or
 *   {@link BroadcastChannel} is unavailable (older browser, insecure context,
 *   Node) we fall back to today's single-tab behavior: `role: 'solo'` — this
 *   worker is the sole owner, persistent when OPFS is available and in-memory
 *   otherwise. This best-effort in-memory fallback applies only to the *solo /
 *   no-lock* open, never to a lock-holding leader/promotion. Both features are
 *   feature-detected.
 *
 * ### Delivery / exactly-once
 *
 * Follower requests retry on timeout so a failover gap (no leader for a beat)
 * is transparent. To keep retries from double-applying against a *live* leader,
 * the leader **dedupes** by the globally-unique `reqId`: a retry whose first
 * attempt already completed replays the cached response, and a retry that races
 * an attempt still *executing* coalesces onto the same in-flight promise instead
 * of starting a second execution. This gives at-most-once execution against a
 * single leader even when an op outlives the follower's request timeout (e.g. a
 * multi-second wasm warmup embed). Across a *failover* the new leader has no
 * dedupe history, so a request in flight at the instant of failover may execute
 * on both leaders (at-least-once). Removes, queries, sizes, and explicit-id
 * inserts (upserts) are idempotent, so only an auto-id insert racing the exact
 * failover instant can double-insert — a deliberate, documented trade-off for a
 * fully headless, dependency-free design.
 *
 * ### Liveness bounds
 *
 * A frozen tab (Chrome tab-freezing does **not** release Web Locks) could
 * otherwise wedge peers forever, so both waits are bounded: a follower's `open()`
 * join handshake rejects after `openTimeoutMs` with neither a `welcome` nor a
 * promotion, and a follower op rejects after `opTimeoutMs` of only-timeouts.
 * Defaults are generous (30s) so normal slow paths — a leader still loading its
 * model, a slow first embed — are unaffected.
 */

import { openStore, type PersistentStore } from './persistence.ts';
import { decodeSnapshot } from './snapshot.ts';
import { createCoreFromBytes } from './core-loader.ts';
import type { Engine } from './engine.ts';
import type { QueryResult, VectorCore } from './types.ts';

/** The coordination role this session resolved to. */
export type Role = 'leader' | 'follower' | 'solo';

/** State the leader hands a freshly-built {@link Engine}. */
export interface LeaderInit {
  /** Rehydrated core, when `index.bin` held a prior snapshot. */
  core?: VectorCore;
  /** Rehydrated id→text sidecar, paired with {@link core}. */
  initialTexts?: Map<string, string>;
  /** The OPFS-backed (or in-memory) store the engine must persist into. */
  persister: PersistentStore;
}

/**
 * Builds the authoritative {@link Engine} for a leader. Injected so the
 * production worker can use the real transformers embedder while tests inject a
 * deterministic fake — the coordinator owns *when* an engine is built (only
 * after winning the lock), the factory owns *how*.
 */
export type EngineFactory = (init: LeaderInit) => Promise<Engine>;

/** Options for {@link Coordinator.open}. */
export interface CoordinatorOptions {
  /** Store name; keys the OPFS path, the Web Lock, and the BroadcastChannel. */
  name: string;
  /** Persist to OPFS when available. Defaults to `true`. */
  persist?: boolean;
  /** Debounce window for snapshot writes, in ms. Defaults to `250`. */
  debounceMs?: number;
  /** How the leader materializes its engine. */
  makeEngine: EngineFactory;
  /** Follower request timeout before a retry, in ms. Defaults to `500`. */
  requestTimeoutMs?: number;
  /**
   * How long a follower's `open()` join handshake may wait for a `welcome` or
   * its own promotion before rejecting, in ms. Bounds the hello loop so a frozen
   * leader tab (Chrome tab-freezing does **not** release its Web Lock) can't hang
   * `open()` forever. Must comfortably exceed the leader's engine build /
   * model-load time, since a follower cannot be welcomed until the leader's
   * engine exists. Defaults to `30000`.
   */
  openTimeoutMs?: number;
  /**
   * Total wall-clock budget for a single follower op (across retries) before it
   * rejects rather than spinning forever against a frozen/absent leader, in ms.
   * Must exceed the slowest single op (e.g. wasm warmup embed). Defaults to
   * `30000`.
   */
  opTimeoutMs?: number;
}

type Op = 'insert' | 'query' | 'remove' | 'size' | 'flush';
interface OpArgs {
  text?: string;
  docId?: string;
  k?: number;
}

interface ReqMessage {
  kind: 'req';
  reqId: string;
  op: Op;
  args: OpArgs;
}
interface ResMessage {
  kind: 'res';
  reqId: string;
  ok: boolean;
  value?: unknown;
  error?: string;
  persistent?: boolean;
}
interface HelloMessage {
  kind: 'hello';
  from: string;
}
interface WelcomeMessage {
  kind: 'welcome';
  to: string;
  persistent: boolean;
}
type CoordMessage = ReqMessage | ResMessage | HelloMessage | WelcomeMessage;

/** Sentinel distinguishing a follower request timeout from a real response. */
const TIMEOUT = Symbol('timeout');

/**
 * How many times a (promoted or fresh) leader retries the OPFS sync handle when
 * it is momentarily contended by an outgoing leader's teardown. ~12 × 50ms ≈
 * 600ms — comfortably longer than a browser's context/handle teardown, short
 * enough not to stall a genuinely stuck open.
 */
const CONTENTION_RETRIES = 12;

/**
 * After a promotion attempt fails for a non-abort reason (e.g. a corrupt
 * `index.bin`, or the OPFS handle never freed), how long to wait before
 * re-queuing for the lock. A small backoff keeps a persistently-failing
 * promotion from hot-looping the Web Lock while still letting another queued tab
 * take a turn.
 */
const PROMOTION_RETRY_DELAY_MS = 200;

/** Default bound for the follower join handshake, in ms. See {@link CoordinatorOptions.openTimeoutMs}. */
const DEFAULT_OPEN_TIMEOUT_MS = 30_000;

/** Default per-op follower budget, in ms. See {@link CoordinatorOptions.opTimeoutMs}. */
const DEFAULT_OP_TIMEOUT_MS = 30_000;

/** Feature-detect the Web Locks + BroadcastChannel coordination substrate. */
function coordinationAvailable(): boolean {
  try {
    return (
      typeof navigator !== 'undefined' &&
      navigator.locks != null &&
      typeof navigator.locks.request === 'function' &&
      typeof BroadcastChannel !== 'undefined'
    );
  } catch {
    return false;
  }
}

function randomId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    /* fall through */
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/**
 * A single store session. Presents the same op surface regardless of whether
 * this worker is the leader (serves locally), a follower (proxies to the
 * leader), or solo (no coordination). Construct via {@link Coordinator.open}.
 */
export class Coordinator {
  /** Notified whenever {@link role} changes (e.g. follower → leader on failover). */
  onRoleChange: ((role: Role) => void) | null = null;

  readonly #name: string;
  readonly #persist: boolean;
  readonly #debounceMs: number;
  readonly #makeEngine: EngineFactory;
  readonly #requestTimeoutMs: number;
  readonly #openTimeoutMs: number;
  readonly #opTimeoutMs: number;
  readonly #clientId = randomId();

  #role: Role = 'solo';
  #persistent = false;
  #closed = false;

  // Leader/solo state. The store is owned by the engine (as its persister), so
  // closing the engine flushes and releases the OPFS handle; no separate ref.
  #engine: Engine | null = null;

  // Coordination substrate (leader + follower).
  #channel: BroadcastChannel | null = null;
  #releaseLock: (() => void) | null = null;
  #promotionAbort: AbortController | null = null;

  // Follower request bookkeeping.
  #reqSeq = 0;
  readonly #pending = new Map<string, (msg: ResMessage | typeof TIMEOUT) => void>();

  // Leader retry-dedupe cache: reqId → cached (successful) response.
  readonly #dedupe = new Map<string, ResMessage>();
  static readonly #DEDUPE_MAX = 256;
  // In-flight executions: reqId → the promise serving the *first* attempt. A
  // retry that races an in-flight op AWAITs this instead of re-invoking the
  // engine (at-most-once against a live leader, even mid-execution).
  readonly #inFlight = new Map<string, Promise<ResMessage>>();

  // Follower join handshake.
  #joinResolve: (() => void) | null = null;
  #joinReject: ((err: Error) => void) | null = null;
  #helloTimer: ReturnType<typeof setTimeout> | null = null;

  // Promotion bookkeeping: last non-abort promotion failure (surfaced to a
  // timing-out `open()`), and the pending re-queue backoff timer.
  #lastPromotionError: Error | null = null;
  #promotionRetryTimer: ReturnType<typeof setTimeout> | null = null;

  private constructor(options: CoordinatorOptions) {
    this.#name = options.name;
    this.#persist = options.persist ?? true;
    this.#debounceMs = options.debounceMs ?? 250;
    this.#makeEngine = options.makeEngine;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 500;
    this.#openTimeoutMs = options.openTimeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS;
    this.#opTimeoutMs = options.opTimeoutMs ?? DEFAULT_OP_TIMEOUT_MS;
  }

  /** Open a coordinated store session, resolving once this worker has a role. */
  static async open(options: CoordinatorOptions): Promise<Coordinator> {
    const c = new Coordinator(options);
    await c.#start();
    return c;
  }

  /** `'leader'`, `'follower'`, or `'solo'`. May change on failover. */
  get role(): Role {
    return this.#role;
  }

  /** Whether the shared store persists to disk (OPFS) or is in-memory only. */
  get persistent(): boolean {
    return this.#persistent;
  }

  async insert(text: string, docId?: string): Promise<string> {
    return this.#route('insert', { text, docId }) as Promise<string>;
  }

  async query(text: string, k: number): Promise<QueryResult[]> {
    return this.#route('query', { text, k }) as Promise<QueryResult[]>;
  }

  async remove(docId: string): Promise<boolean> {
    return this.#route('remove', { docId }) as Promise<boolean>;
  }

  async size(): Promise<number> {
    return this.#route('size', {}) as Promise<number>;
  }

  async flush(): Promise<void> {
    await this.#route('flush', {});
  }

  /** Final flush + release of the OPFS handle and Web Lock (leader), or of the
   * follower's channel + queued promotion request. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;

    if (this.#helloTimer !== null) {
      clearTimeout(this.#helloTimer);
      this.#helloTimer = null;
    }
    if (this.#promotionRetryTimer !== null) {
      clearTimeout(this.#promotionRetryTimer);
      this.#promotionRetryTimer = null;
    }
    // A still-pending join resolves (open() sees `#closed` via its own guard, or
    // the awaiting caller's close() races it) rather than hanging.
    this.#resolveJoin();
    // Unblock any in-flight follower ops so they observe `#closed` and throw.
    for (const resolve of this.#pending.values()) resolve(TIMEOUT);
    this.#pending.clear();

    if (this.#role === 'follower') {
      // Stop waiting to be promoted, then tear down the channel.
      this.#promotionAbort?.abort();
    } else {
      // Leader/solo: flush + release the OPFS handle FIRST, then the Web Lock —
      // so a promoting follower opens `index.bin` only after we let go of it.
      if (this.#engine) await this.#engine.close();
      this.#releaseLock?.();
      this.#releaseLock = null;
    }
    this.#channel?.close();
    this.#channel = null;
  }

  // ---- startup / election -------------------------------------------------

  async #start(): Promise<void> {
    if (!coordinationAvailable()) {
      // No Web Locks / BroadcastChannel: behave exactly as pre-M6 — a single
      // attempt at the OPFS handle, prompt in-memory fallback on contention.
      this.#role = 'solo';
      await this.#becomeLeaderCore(0);
      return;
    }

    this.#channel = new BroadcastChannel(`ferrovec-coord:${this.#name}`);
    this.#channel.onmessage = (ev: MessageEvent<CoordMessage>): void => {
      this.#onMessage(ev.data);
    };

    const acquired = await this.#tryAcquire();
    if (acquired) {
      // We hold the Web Lock, so we are the legitimate owner of index.bin:
      // contention must not degrade us to memory (requireLock). Build the engine
      // FIRST and flip to 'leader' only once it exists — until then role stays
      // 'solo', so hello/req from a racing follower go unanswered (and are
      // absorbed by its retries) rather than getting a wrong `welcome` or hitting
      // a null engine.
      try {
        await this.#becomeLeaderCore(CONTENTION_RETRIES, true);
      } catch (err) {
        // Leader init failed (e.g. offline model fetch, corrupt index). Release
        // the Web Lock + channel so we don't deadlock the origin — otherwise
        // every other tab hangs as a follower forever. Then rethrow so open()
        // still rejects. (#becomeLeaderCore already closed any store it opened.)
        this.#releaseLock?.();
        this.#releaseLock = null;
        this.#channel?.close();
        this.#channel = null;
        throw err;
      }
      this.#role = 'leader';
      return;
    }

    // Follower: queue for eventual promotion, and handshake with the current
    // leader so `open()` resolves with an accurate `persistent` flag. Whichever
    // happens first — a `welcome`, or our own promotion — unblocks the join.
    this.#role = 'follower';
    this.#queueForPromotion();
    try {
      await this.#awaitJoin();
    } catch (err) {
      // Join timed out (leader frozen/absent). Tear down the queued promotion
      // request + channel so we don't leak the lock queue slot, then rethrow so
      // open() rejects instead of hanging.
      await this.close();
      throw err;
    }
  }

  /** Try to grab leadership without waiting. Resolves `true` iff we hold it. */
  #tryAcquire(): Promise<boolean> {
    const lockName = `ferrovec-leader:${this.#name}`;
    return new Promise<boolean>((resolve) => {
      navigator.locks
        .request(lockName, { mode: 'exclusive', ifAvailable: true }, (lock) => {
          if (lock === null) {
            resolve(false);
            return; // never held it — returning undefined completes the request
          }
          resolve(true);
          // Hold the lock for this session's lifetime.
          return new Promise<void>((release) => {
            this.#releaseLock = release;
          });
        })
        .catch(() => resolve(false));
    });
  }

  /** Wait in the lock queue; the callback runs when we are promoted to leader. */
  #queueForPromotion(): void {
    const lockName = `ferrovec-leader:${this.#name}`;
    this.#promotionAbort = new AbortController();
    navigator.locks
      .request(lockName, { mode: 'exclusive', signal: this.#promotionAbort.signal }, async () => {
        if (this.#closed) return;
        // Promotion during a crash failover: the outgoing leader's OPFS handle
        // may still be tearing down. We now hold the Web Lock, so we are the
        // legitimate owner — retry the handle on a long deadline and NEVER fall
        // back to memory (requireLock), rather than serving an intact on-disk
        // index as empty.
        try {
          await this.#becomeLeaderCore(CONTENTION_RETRIES, true);
        } catch (err) {
          // A genuine promotion failure (corrupt index.bin, or the handle never
          // freed) — NOT the close-time AbortError, which rejects the request
          // before this callback ever runs. Returning here releases the lock;
          // if we simply dropped out of the queue there would be zero leaders
          // forever. So re-queue (after a small backoff) and let this attempt
          // release the lock for the next contender.
          // (#becomeLeaderCore already closed any store it opened.)
          if (!this.#closed) this.#requeueAfterFailedPromotion(err);
          return;
        }
        if (this.#closed) {
          // Closed mid-promotion: release the store we just opened and let go.
          if (this.#engine) await this.#engine.close();
          this.#engine = null;
          return;
        }
        this.#role = 'leader';
        this.#lastPromotionError = null;
        this.#resolveJoin();
        this.#emitRole();
        // Hold the lock until close.
        await new Promise<void>((release) => {
          this.#releaseLock = release;
        });
      })
      .catch(() => {
        /* AbortError on close — expected */
      });
  }

  /** Record a promotion failure and re-queue for the lock after a short backoff. */
  #requeueAfterFailedPromotion(err: unknown): void {
    this.#lastPromotionError = err instanceof Error ? err : new Error(String(err));
    // Surface for observability — this is a background context, so we cannot
    // throw. A follower op or a timing-out open() reports the stored error.
    console.error(
      `[ferrovec] promotion to leader failed for "${this.#name}"; re-queuing:`,
      this.#lastPromotionError,
    );
    this.#promotionRetryTimer = setTimeout(() => {
      this.#promotionRetryTimer = null;
      if (this.#closed || this.#role !== 'follower') return;
      this.#queueForPromotion();
    }, PROMOTION_RETRY_DELAY_MS);
  }

  /**
   * Open the OPFS store, rehydrate if present, build + bind the engine. When
   * `requireLock` is set the caller holds the leader Web Lock, so OPFS contention
   * must not degrade to in-memory (see {@link openStore}). On any failure after
   * the store is opened, the store is closed before rethrowing so the OPFS
   * sync-access handle is never leaked.
   */
  async #becomeLeaderCore(contentionRetries: number, requireLock = false): Promise<void> {
    const store = await openStore(this.#name, {
      persist: this.#persist,
      debounceMs: this.#debounceMs,
      contentionRetries,
      requireLock,
    });

    try {
      let core: VectorCore | undefined;
      let initialTexts: Map<string, string> | undefined;
      if (store.initialBytes && store.initialBytes.length > 0) {
        const decoded = decodeSnapshot(store.initialBytes);
        if (decoded.core.length > 0) {
          core = await createCoreFromBytes(decoded.core);
          initialTexts = decoded.texts;
        }
      }

      const engine = await this.#makeEngine({ core, initialTexts, persister: store });
      store.bind(() => engine.snapshot());
      this.#engine = engine;
      this.#persistent = store.persistent;
    } catch (err) {
      // Building the engine failed (rehydrate / makeEngine threw). Close the
      // store so its exclusive OPFS handle is released, then rethrow.
      try {
        await store.close();
      } catch {
        /* best-effort — the original error is what matters */
      }
      throw err;
    }
  }

  // ---- follower join handshake -------------------------------------------

  #awaitJoin(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.#joinResolve = resolve;
      this.#joinReject = reject;
      const deadline = Date.now() + this.#openTimeoutMs;
      const tick = (): void => {
        if (this.#closed || this.#role !== 'follower') {
          this.#resolveJoin();
          return;
        }
        if (Date.now() >= deadline) {
          // Bounded so a frozen leader tab (holds the Web Lock, never answers
          // hello, never releases it → we're never promoted) can't hang open().
          const cause = this.#lastPromotionError;
          this.#rejectJoin(
            new Error(
              `ferrovec: timed out after ${this.#openTimeoutMs}ms joining store ` +
                `"${this.#name}" (no leader responded and no promotion)` +
                (cause ? `; last promotion error: ${cause.message}` : ''),
            ),
          );
          return;
        }
        this.#channel?.postMessage({ kind: 'hello', from: this.#clientId } satisfies HelloMessage);
        this.#helloTimer = setTimeout(tick, Math.max(50, Math.floor(this.#requestTimeoutMs / 2)));
      };
      tick();
    });
  }

  #resolveJoin(): void {
    if (this.#helloTimer !== null) {
      clearTimeout(this.#helloTimer);
      this.#helloTimer = null;
    }
    const resolve = this.#joinResolve;
    this.#joinResolve = null;
    this.#joinReject = null;
    resolve?.();
  }

  #rejectJoin(err: Error): void {
    if (this.#helloTimer !== null) {
      clearTimeout(this.#helloTimer);
      this.#helloTimer = null;
    }
    const reject = this.#joinReject;
    this.#joinResolve = null;
    this.#joinReject = null;
    reject?.(err);
  }

  // ---- op routing ---------------------------------------------------------

  #route(op: Op, args: OpArgs): Promise<unknown> {
    if (this.#role === 'follower') return this.#followerOp(op, args);
    return this.#localOp(op, args);
  }

  /** Execute an op against the local authoritative engine (leader/solo). */
  async #localOp(op: Op, args: OpArgs): Promise<unknown> {
    const engine = this.#engine;
    if (!engine) throw new Error('store engine is not open');
    switch (op) {
      case 'insert':
        return engine.insert(args.text ?? '', args.docId);
      case 'query':
        return engine.query(args.text ?? '', args.k ?? 5);
      case 'remove':
        return engine.remove(args.docId ?? '');
      case 'size':
        return engine.size();
      case 'flush':
        await engine.flush();
        return true;
    }
  }

  /** Forward an op to the leader over the channel, retrying across failover. */
  async #followerOp(op: Op, args: OpArgs): Promise<unknown> {
    const reqId = `${this.#clientId}:${this.#reqSeq++}`;
    const deadline = Date.now() + this.#opTimeoutMs;
    for (;;) {
      if (this.#closed) throw new Error('store is closed');
      // Promoted while waiting (or between retries): serve it ourselves.
      if (this.#role !== 'follower') return this.#localOp(op, args);

      const outcome = await this.#sendOnce(reqId, op, args);
      if (outcome === TIMEOUT) {
        // No leader answered in time. Retry until the op budget is exhausted,
        // then reject rather than spinning forever against a frozen/absent
        // leader. (A slow-but-live leader replies before the budget via the
        // in-flight dedupe, resetting nothing but still returning here.)
        if (Date.now() >= deadline) {
          const cause = this.#lastPromotionError;
          throw new Error(
            `ferrovec: "${op}" timed out after ${this.#opTimeoutMs}ms with no ` +
              `leader response (leader may be frozen or gone)` +
              (cause ? `; last promotion error: ${cause.message}` : ''),
          );
        }
        continue;
      }
      if (outcome.persistent !== undefined) this.#persistent = outcome.persistent;
      if (outcome.ok) return outcome.value;
      throw new Error(outcome.error ?? 'leader error');
    }
  }

  /** One broadcast attempt; resolves with the response or {@link TIMEOUT}. */
  #sendOnce(reqId: string, op: Op, args: OpArgs): Promise<ResMessage | typeof TIMEOUT> {
    return new Promise((resolve) => {
      if (this.#closed) {
        resolve(TIMEOUT);
        return;
      }
      const timer = setTimeout(() => {
        this.#pending.delete(reqId);
        resolve(TIMEOUT);
      }, this.#requestTimeoutMs);
      this.#pending.set(reqId, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      this.#channel?.postMessage({ kind: 'req', reqId, op, args } satisfies ReqMessage);
    });
  }

  // ---- channel handling ---------------------------------------------------

  #onMessage(msg: CoordMessage): void {
    if (this.#closed) return;
    switch (msg.kind) {
      case 'req':
        // Only the single leader answers requests (solo has no channel).
        if (this.#role !== 'leader') return;
        this.#serveReq(msg);
        return;
      case 'res': {
        const resolve = this.#pending.get(msg.reqId);
        if (resolve) {
          this.#pending.delete(msg.reqId);
          resolve(msg);
        }
        return;
      }
      case 'hello':
        if (this.#role === 'leader') {
          this.#channel?.postMessage({
            kind: 'welcome',
            to: msg.from,
            persistent: this.#persistent,
          } satisfies WelcomeMessage);
        }
        return;
      case 'welcome':
        if (msg.to === this.#clientId && this.#role === 'follower') {
          this.#persistent = msg.persistent;
          this.#resolveJoin();
        }
        return;
    }
  }

  /** Serve a follower request from the local engine, deduping retries. */
  #serveReq(msg: ReqMessage): void {
    // 1. Already completed (successfully) and cached: replay the response.
    const cached = this.#dedupe.get(msg.reqId);
    if (cached) {
      this.#channel?.postMessage(cached);
      return;
    }
    // 2. Currently executing (a retry raced the first attempt): attach to the
    // SAME promise instead of starting a second execution. This is the
    // at-most-once guarantee even mid-flight — the fix for duplicate auto-id
    // inserts when a slow first op outlives the follower's request timeout.
    const inFlight = this.#inFlight.get(msg.reqId);
    if (inFlight) {
      void inFlight.then((res) => {
        if (!this.#closed) this.#channel?.postMessage(res);
      });
      return;
    }
    // 3. First time seen: execute once, tracking the promise so concurrent
    // retries (case 2) coalesce onto it.
    const exec = (async (): Promise<ResMessage> => {
      try {
        const value = await this.#localOp(msg.op, msg.args);
        const res: ResMessage = {
          kind: 'res',
          reqId: msg.reqId,
          ok: true,
          value,
          persistent: this.#persistent,
        };
        // Cache only successes: an ok:false is often a transient startup-window
        // failure (engine not yet built) that a retry SHOULD re-execute, not
        // replay from cache. Caching it would poison every retry.
        this.#rememberResult(msg.reqId, res);
        return res;
      } catch (err) {
        return {
          kind: 'res',
          reqId: msg.reqId,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          persistent: this.#persistent,
        };
      }
    })();
    this.#inFlight.set(msg.reqId, exec);
    void exec.then((res) => {
      this.#inFlight.delete(msg.reqId);
      if (!this.#closed) this.#channel?.postMessage(res);
    });
  }

  #rememberResult(reqId: string, res: ResMessage): void {
    this.#dedupe.set(reqId, res);
    // FIFO cap. In-flight entries live in #inFlight (never evicted), so they are
    // pinned until they resolve — eviction here can only drop an already-answered
    // response, never reopen the hole for a still-executing op.
    if (this.#dedupe.size > Coordinator.#DEDUPE_MAX) {
      const oldest = this.#dedupe.keys().next().value;
      if (oldest !== undefined) this.#dedupe.delete(oldest);
    }
  }

  #emitRole(): void {
    try {
      this.onRoleChange?.(this.#role);
    } catch {
      /* listener errors must not break coordination */
    }
  }
}
