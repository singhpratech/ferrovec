/**
 * Kill-the-tab chaos harness: does an acknowledged write ever get lost?
 *
 * The claim under test: once `insert()` has resolved, the document survives the
 * tab being killed at any moment, with no `close()` and no `flush()`. Each cycle
 * opens a fresh page on the shared fixture server (the fake-embedder test
 * worker driving the *real* coordinator / slot store / write-ahead log / wasm
 * core, strict durability), inserts a random batch of 1..20 documents, and at a
 * random point — after a random number of acknowledgements, often while the
 * next insert is mid-flight and sometimes mid-checkpoint — closes the page with
 * `runBeforeUnload: false`, which tears down its worker without any graceful
 * shutdown. Every id whose insert promise resolved before the kill is recorded.
 * The next cycle's page reopens the store (that open is the timed "reopen":
 * snapshot decode + log replay) and checks that the store holds at least as
 * many documents as were ever acknowledged and that every id acknowledged in
 * the previous cycle (plus a random sample of older ones) is present: an
 * exact-text `query(text, 1)` must return that id with that stored text. A
 * final reopen checks every acknowledged id.
 *
 * OPFS only persists across pages within one profile, so the run uses
 * `launchPersistentContext(userDataDir)` and kills PAGES, never the context.
 * Checkpoints are made frequent (`CHECKPOINT_RECORDS`, default 50) so kills
 * also land around checkpoint boundaries, exercising checkpoint/log
 * crash-consistency, not just log appends.
 *
 * Env: `CYCLES` (default 100), `BROWSER` (`chromium` | `firefox` | `webkit`,
 * default chromium), `SEED` (batch/kill-point PRNG seed; default random),
 * `CHECKPOINT_RECORDS` (default 50). Prints a JSON summary, writes it to
 * `test/chaos/results/<browser>-<date>.json`, and exits non-zero if any
 * acknowledged write was lost or any cycle failed.
 *
 * Run: `npm run test:chaos` (100 cycles) or `CYCLES=1000 BROWSER=firefox npm run test:chaos`.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BrowserContext, Page } from 'playwright';

import { serveFixture } from '../browser/serve.ts';

const here = dirname(fileURLToPath(import.meta.url));

const CYCLES = Number(process.env.CYCLES ?? 100);
const BROWSER = (process.env.BROWSER ?? 'chromium') as 'chromium' | 'firefox' | 'webkit';
const SEED = Number(process.env.SEED ?? Math.floor(Math.random() * 2 ** 31));
const CHECKPOINT_RECORDS = Number(process.env.CHECKPOINT_RECORDS ?? 50);
/** Older acknowledged ids re-checked on every reopen (all are checked at the end). */
const SAMPLE_OLDER = 20;
/** Upper bound for any single page operation, so a wedged browser fails the run instead of hanging it. */
const STEP_TIMEOUT_MS = 60_000;

/** Seeded PRNG (mulberry32): batch sizes and kill points are reproducible per seed. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The stored text for an id. The fake embedder hashes tokens into 32 buckets,
 * so short texts can collide into identical vectors and tie on a query;
 * thirteen pseudo-random tokens make an exact-text query unambiguous.
 */
function textFor(id: string): string {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619) >>> 0;
  const words = [id];
  for (let k = 0; k < 12; k++) {
    h = Math.imul(h ^ (k + 0x9e37), 2654435761) >>> 0;
    words.push(`w${h.toString(36)}`);
  }
  return words.join(' ');
}

function withTimeout<T>(p: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${STEP_TIMEOUT_MS}ms: ${what}`)), STEP_TIMEOUT_MS);
    }),
  ]);
}

/** Installs `window.__rpc(msg)` in the page, backed by a fresh fake-embedder store worker. */
function bootstrapPage(origin: string): void {
  const w = new Worker(new URL('./opfs.worker.js', origin + '/'), { type: 'module' });
  let nextId = 0;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  w.onmessage = (e: MessageEvent): void => {
    const { id, ok, result, error, errorName } = e.data;
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    if (ok) {
      p.resolve(result);
    } else {
      const err = new Error(error);
      if (errorName) err.name = errorName;
      p.reject(err);
    }
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).__rpc = (msg: Record<string, unknown>): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      w.postMessage({ ...msg, id });
    });
}

interface OpenOutcome {
  ms: number;
  role: string;
  persistent: boolean;
  warnings: string[];
}

/** Open the store in the page; the time measured is the reopen cost (decode + replay). */
function openInPage(args: { name: string; checkpointRecords: number }): Promise<OpenOutcome> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rpc = (window as any).__rpc as (m: Record<string, unknown>) => Promise<any>;
  const t0 = performance.now();
  return rpc({
    type: 'open',
    name: args.name,
    persist: true,
    durability: 'strict',
    checkpointRecords: args.checkpointRecords,
    openTimeoutMs: 20_000,
  }).then((r) => ({ ms: performance.now() - t0, role: r.role, persistent: r.persistent, warnings: r.warnings }));
}

interface VerifyOutcome {
  size: number;
  missing: string[];
  /** Present, but not the top-1 hit for its own text (found within the top 10). */
  top1Misses: number;
}

/** Check that every given id is present: exact-text query → that id, with that stored text. */
async function verifyInPage(items: Array<{ id: string; text: string }>): Promise<VerifyOutcome> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rpc = (window as any).__rpc as (m: Record<string, unknown>) => Promise<any>;
  const size = (await rpc({ type: 'size' })).size as number;
  const missing: string[] = [];
  let top1Misses = 0;
  for (const { id, text } of items) {
    const top = (await rpc({ type: 'query', text, k: 1 })).results as Array<{ id: string; text?: string }>;
    if (top[0]?.id === id && top[0]?.text === text) continue;
    // HNSW is approximate: before calling an id lost, look a little wider.
    const wide = (await rpc({ type: 'query', text, k: 10 })).results as Array<{ id: string; text?: string }>;
    if (wide.some((h) => h.id === id && h.text === text)) top1Misses++;
    else missing.push(id);
  }
  return { size, missing, top1Misses };
}

/** Fire the inserts sequentially without awaiting them here; each ack is reported via `__ack`. */
function startInserts(items: Array<{ id: string; text: string }>): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = window as any;
  void (async () => {
    for (const { id, text } of items) {
      const r = await w.__rpc({ type: 'insert', text, docId: id });
      void w.__ack(r.id);
    }
  })();
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i]!;
}

function gitCommit(): string {
  try {
    const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: here, encoding: 'utf8' }).trim();
    const dirty = execFileSync('git', ['status', '--porcelain', '--', '.'], { cwd: join(here, '../..'), encoding: 'utf8' }).trim();
    return dirty ? `${sha}+dirty` : sha;
  } catch {
    return 'unknown';
  }
}

async function newCyclePage(context: BrowserContext, origin: string, onAck: (id: string) => void): Promise<Page> {
  const page = await context.newPage();
  page.on('pageerror', (e) => console.error(`[chaos] page error: ${String(e)}`));
  await page.exposeFunction('__ack', onAck);
  await page.goto(origin + '/');
  await page.evaluate(bootstrapPage, origin);
  return page;
}

async function main(): Promise<void> {
  const playwright = await import('playwright');
  const browserType = playwright[BROWSER];
  if (!browserType) throw new Error(`unknown BROWSER "${BROWSER}"`);

  const rand = prng(SEED);
  const runId = `${Date.now().toString(36)}`;
  const name = `chaos-${runId}`;
  const userDataDir = await mkdtemp(join(tmpdir(), `ferrovec-chaos-${BROWSER}-`));
  const { server, origin } = await serveFixture();
  const started = Date.now();

  let context: BrowserContext;
  try {
    context = await browserType.launchPersistentContext(userDataDir, { headless: true });
  } catch (err) {
    server.close();
    await rm(userDataDir, { recursive: true, force: true });
    throw new Error(`${BROWSER} could not launch: ${(err as Error).message}`);
  }

  const allAcked: string[] = [];
  const lost = new Set<string>();
  const reopenMs: number[] = [];
  let tornTailRecoveries = 0;
  let sizeViolations = 0;
  let top1Misses = 0;
  let killsMidBatch = 0;
  let followerOpens = 0;
  let prevAcked: string[] = [];
  let failure: string | null = null;
  let userAgent: string | null = null;

  const checkReopen = async (page: Page, items: string[]): Promise<void> => {
    const opened = await withTimeout(page.evaluate(openInPage, { name, checkpointRecords: CHECKPOINT_RECORDS }), 'open');
    if (!opened.persistent) throw new Error('store opened non-persistent (OPFS unavailable?)');
    if (opened.role !== 'leader') followerOpens++;
    reopenMs.push(opened.ms);
    if (opened.warnings.some((w) => /torn tail/.test(w))) tornTailRecoveries++;
    const verify = await withTimeout(
      page.evaluate(verifyInPage, items.map((id) => ({ id, text: textFor(id) }))),
      'verify',
    );
    top1Misses += verify.top1Misses;
    for (const id of verify.missing) lost.add(id);
    if (verify.size < allAcked.length) sizeViolations++;
  };

  try {
    for (let cycle = 0; cycle < CYCLES; cycle++) {
      const acked: string[] = [];
      let wanted = 0;
      let reached: () => void = () => {};
      const killPoint = new Promise<void>((resolve) => (reached = resolve));
      const page = await newCyclePage(context, origin, (id) => {
        acked.push(id);
        if (acked.length >= wanted) reached();
      });

      // Reopen + verify what the previous cycle acknowledged, plus a sample of older acks.
      const older = allAcked.slice(0, allAcked.length - prevAcked.length);
      const sample: string[] = [];
      for (let i = 0; i < Math.min(SAMPLE_OLDER, older.length); i++) sample.push(older[Math.floor(rand() * older.length)]!);
      await checkReopen(page, [...prevAcked, ...sample]);
      userAgent ??= await page.evaluate(() => navigator.userAgent);

      // Insert a random batch and kill the page after a random number of acks.
      const batch = 1 + Math.floor(rand() * 20);
      wanted = Math.floor(rand() * (batch + 1)); // 0..batch acks before the kill
      const jitterMs = Math.floor(rand() * 4); // often lands mid-insert
      const items = Array.from({ length: batch }, (_, i) => `c${cycle}-${i}`).map((id) => ({ id, text: textFor(id) }));
      if (wanted === 0) reached();
      await page.evaluate(startInserts, items);
      await withTimeout(killPoint, `cycle ${cycle}: waiting for ${wanted} acks`);
      if (jitterMs > 0) await new Promise((r) => setTimeout(r, jitterMs));
      const ackedAtKill = acked.slice();
      await page.close({ runBeforeUnload: false });
      if (ackedAtKill.length < batch) killsMidBatch++;

      allAcked.push(...ackedAtKill);
      prevAcked = ackedAtKill;
      if ((cycle + 1) % 50 === 0 || cycle === CYCLES - 1) {
        console.error(
          `[chaos] ${BROWSER} cycle ${cycle + 1}/${CYCLES}: acked ${allAcked.length}, lost ${lost.size}, ` +
            `torn tails ${tornTailRecoveries}, last reopen ${reopenMs.at(-1)?.toFixed(1)}ms`,
        );
      }
    }

    // Final reopen: every acknowledged id, not a sample.
    const page = await newCyclePage(context, origin, () => {});
    await checkReopen(page, allAcked);
    await page.close();
  } catch (err) {
    failure = (err as Error).stack ?? String(err);
    console.error(`[chaos] run failed: ${failure}`);
  } finally {
    await context.close().catch(() => {});
    server.close();
    await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
  }

  const sorted = [...reopenMs].sort((a, b) => a - b);
  const mean = sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : 0;
  const date = new Date().toISOString();
  const summary = {
    browser: BROWSER,
    userAgent,
    cycles: CYCLES,
    totalAcked: allAcked.length,
    lost: lost.size,
    'torn-tail-recoveries': tornTailRecoveries,
    meanReopenMs: Number(mean.toFixed(2)),
    p50ReopenMs: Number(percentile(sorted, 50).toFixed(2)),
    p95ReopenMs: Number(percentile(sorted, 95).toFixed(2)),
    reopens: reopenMs.length,
    sizeViolations,
    top1Misses,
    killsMidBatch,
    followerOpens,
    checkpointRecords: CHECKPOINT_RECORDS,
    seed: SEED,
    durationS: Number(((Date.now() - started) / 1000).toFixed(1)),
    commit: gitCommit(),
    date,
    ...(lost.size > 0 ? { lostIds: [...lost].slice(0, 50) } : {}),
    ...(failure ? { failure } : {}),
  };
  const json = JSON.stringify(summary, null, 2);
  console.log(json);
  const outDir = join(here, 'results');
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, `${BROWSER}-${date.replace(/[:.]/g, '-')}.json`), json + '\n');

  if (failure || lost.size > 0 || sizeViolations > 0) process.exitCode = 1;
}

await main();
