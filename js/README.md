# ferrovec

<p align="center">
  <a href="https://www.npmjs.com/package/ferrovec"><img alt="npm" src="https://img.shields.io/npm/v/ferrovec?logo=npm&label=npm&color=CB3837" /></a>
  <a href="https://www.npmjs.com/package/ferrovec"><img alt="npm downloads" src="https://img.shields.io/npm/dm/ferrovec?label=downloads" /></a>
  <a href="https://bundlephobia.com/package/ferrovec"><img alt="bundle size" src="https://img.shields.io/bundlephobia/minzip/ferrovec?label=min%2Bgzip&color=5B48D8" /></a>
  <a href="https://crates.io/crates/ferrovec"><img alt="Rust core on crates.io" src="https://img.shields.io/crates/v/ferrovec?logo=rust&label=rust%20core&color=C13A15" /></a>
  <a href="https://github.com/singhpratech/ferrovec/blob/main/LICENSE"><img alt="license" src="https://img.shields.io/npm/l/ferrovec" /></a>
  <a href="https://github.com/singhpratech/ferrovec"><img alt="GitHub stars" src="https://img.shields.io/github/stars/singhpratech/ferrovec?logo=github&color=5B48D8" /></a>
</p>

Text-in vector search for the browser: [transformers.js](https://github.com/huggingface/transformers.js)
embeddings over a Rust/wasm HNSW core, running on a dedicated Web Worker, with
**OPFS persistence** so your index survives reloads.

You give it text. It embeds, indexes, and searches — off the main thread.

**`0.3.2`** — the three-line browser API (embeddings + OPFS persistence), now
**safe across multiple tabs** via single-writer leader election.
· [Website](https://singhpratech.github.io/ferrovec/) · [**▶ Live demo**](https://singhpratech.github.io/ferrovec/demo.html) · [GitHub](https://github.com/singhpratech/ferrovec) · [Rust core on crates.io](https://crates.io/crates/ferrovec)

> **▶ [Try the live demo](https://singhpratech.github.io/ferrovec/demo.html)** — the real
> WASM core running semantic search over sentence embeddings entirely in your browser tab.
> No server, no network: the wasm binary and the vectors are baked into a single HTML file.

## Install

```sh
npm install ferrovec
```

## Three-line API

```ts
import { Ferrovec } from 'ferrovec';

const db = await Ferrovec.open('notes');        // spawns the worker, loads the model
await db.insert('the cat sat on the mat');      // embed + index (returns its id)
const hits = await db.query('a napping kitten', 5); // → [{ id, text, score }, ...]
```

Full surface:

```ts
const id = await db.insert('some text', { id: 'doc-1' }); // explicit id (upsert)
const hits = await db.query('query text', 10);            // k nearest, nearest-first
await db.remove('doc-1');                                 // → boolean
await db.size();                                          // → number of live items
await db.close();                                         // final flush + terminate worker
```

Each hit is `{ id: string; text?: string; score: number }`, where `score` is
cosine similarity (higher = closer, ≈1 for near-duplicates).

## Persistence (OPFS)

By default an index is **persisted** to the [Origin Private File System](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system)
so it survives page reloads:

```ts
const db = await Ferrovec.open('notes');   // persist: true by default
// ... insert / remove ...
await db.close();                          // guarantees a final snapshot to disk

// Later — after a full reload — reopening the same name restores everything:
const again = await Ferrovec.open('notes');
await again.size();                        // your items are still there
console.log(again.persistent);             // true when running from disk
```

How it works:

- The worker opens `ferrovec/<name>/index.bin` in OPFS via a
  `FileSystemSyncAccessHandle` (worker-only, secure-context-only).
- Writes are **full snapshots, debounced ~250 ms**: each `insert`/`remove` marks
  the store dirty and schedules one `write(at:0)` → `truncate` → `flush`.
  `close()` always performs a final synchronous flush before releasing the lock.
- The snapshot contains the serialized vector index **and** the id→text sidecar,
  framed together so a reload restores both atomically.

**Graceful degradation — it never crashes:**

- Opt out with `Ferrovec.open('notes', { persist: false })` for pure in-memory.
- Where OPFS sync access is unavailable (Node, insecure context, unsupported
  browser) it transparently falls back to in-memory.
- The sync handle takes an **exclusive lock**, held by exactly one tab. Other
  tabs opening the same store no longer degrade — they join as **followers**
  that share the one persistent store (see [Multi-tab](#multi-tab) below).

Check the resolved mode with `db.persistent` (`true` = writing to disk) and the
coordination role with `db.role` (`'leader' | 'follower' | 'solo'`).

> **Secure context required.** OPFS sync access handles (and the Web Locks API
> used for leader election) only work over HTTPS or `http://localhost`.
> Persistence and cross-tab coordination are silently disabled elsewhere.

## Multi-tab

Opening the **same store name in two tabs** used to make the second tab silently
degrade to a private in-memory copy — the two would diverge and the second tab's
writes never reached disk. As of `0.3.2` ferrovec runs **single-writer leader
election** so multiple tabs safely share one persistent store:

```ts
// Tab A
const a = await Ferrovec.open('notes');
a.role; // 'leader'  — owns the OPFS store + the authoritative index
await a.insert('written in tab A', { id: 'x' });

// Tab B (same origin, same name)
const b = await Ferrovec.open('notes');
b.role; // 'follower' — shares A's store, no divergence
await b.query('written in tab A'); // sees A's write immediately
await b.insert('written in tab B', { id: 'y' }); // proxied to A, persisted once
```

How it works:

- **Leader election (Web Locks).** Each store worker requests an exclusive
  [Web Lock](https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API)
  named `ferrovec-leader:<name>`. The tab that wins opens the OPFS store and owns
  the only `Engine` + persistence. Exactly one writer exists at a time, so the
  old lock-contention fallback can never happen.
- **Followers proxy to the leader** over a
  [BroadcastChannel](https://developer.mozilla.org/en-US/docs/Web/API/Broadcast_Channel_API)
  (`ferrovec-coord:<name>`): `insert`/`query`/`remove`/`size` are correlation-id
  request/response round-trips answered by the leader's engine. This *proxy*
  model is always consistent — there is one authoritative index, so every tab
  sees every other tab's writes.
- **Failover.** When the leader tab closes or crashes, its Web Lock releases and
  a waiting follower is **promoted**: it opens the OPFS store (rehydrating from
  `index.bin`) and becomes the new leader. In-flight follower requests are
  retried and transparently answered by the new leader; `db.role` flips from
  `'follower'` to `'leader'` on promotion. Because the promoting tab holds the
  exclusive lock, it is the legitimate owner of `index.bin`: on transient OPFS
  contention it waits for the handle rather than degrading to an empty in-memory
  copy, and if promotion genuinely fails (a corrupt index, or the handle never
  frees) it **re-queues** for the lock instead of dropping out of the election —
  so a shared store never ends up with zero leaders.
- **Always degrade, never crash.** Where the Web Locks API or BroadcastChannel
  is unavailable (older browser, insecure context, Node), a store opens as
  `role: 'solo'` — the sole owner, exactly the single-tab behaviour. (This best-effort
  in-memory fallback applies only to a solo/no-lock open, never to a lock-holding
  leader — a legitimate owner is never silently degraded over an intact index.)

> **Consistency note.** Retries make a failover gap invisible; against a live
> leader they are deduplicated **at-most-once** — a retry replays a completed
> response and, if it races an op still executing (e.g. a slow first embed),
> coalesces onto it rather than starting a second execution, so no duplicate
> runs. At the exact instant of a failover a request may reach both the old and
> new leader. Queries, removes, and explicit-id inserts (upserts) are idempotent,
> so only an *auto-id* insert racing that instant could double-insert — a
> documented trade-off of the dependency-free proxy design.

> **Liveness.** A frozen tab (Chrome tab-freezing does not release Web Locks)
> can't wedge peers forever: a follower's `open()` and each follower op are
> bounded and reject with a clear timeout if no leader ever responds. The
> defaults are generous, so a leader that is merely slow (still loading its
> model, a slow first embed) is unaffected.

## Bundler setup

`Ferrovec.open` spawns the worker with the standard, statically-analyzable
pattern:

```ts
new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
```

Modern bundlers understand this out of the box:

- **Vite** — works with no configuration.
- **webpack 5** — works with no configuration (native `new URL` + Web Worker support).

The worker (`dist/worker.js`) and the wasm core (`dist/core/`) are shipped in the
package and resolved relative to the module URL, so no extra copy step is needed.
If your bundler does not support the `new URL(..., import.meta.url)` worker
pattern, point it at the published `ferrovec/worker` entry.

## Advanced / Node usage

`Ferrovec` is the Worker-backed main-thread proxy. For non-browser environments
(or custom embedders), drive the `Engine` directly — it has no Worker/DOM
coupling and accepts injected embedders and cores:

```ts
import { Engine, createCore } from 'ferrovec';

const engine = await Engine.create({ embedder: myEmbedder, core: await createCore(384) });
await engine.insert('hello world');
const hits = await engine.query('hi there', 5);
```

The default embedder is `Xenova/all-MiniLM-L6-v2` (384-dim). Pass `{ model }` /
`{ device }` to `Ferrovec.open` or `Engine.create` to change it.

## Roadmap

| | Milestone | Status |
| --- | --- | --- |
| **M1–M2** | Rust HNSW core + WASM boundary + SIMD | ✅ `0.3.2` |
| **M3** | Web Worker + transformers.js auto-embedding | ✅ `0.3.2` |
| **M4** | OPFS persistence (survives reloads) | ✅ `0.3.2` |
| **M5** | Three-line browser API on npm | ✅ `0.3.2` |
| **M6** | Cross-tab leader election (Web Locks) | ✅ `0.3.2` |

The pure-Rust HNSW core is published separately on [crates.io](https://crates.io/crates/ferrovec).

## License

MIT
