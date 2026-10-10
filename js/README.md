# ferrovec

<p align="center">
  <a href="https://www.npmjs.com/package/ferrovec"><img alt="npm" src="https://img.shields.io/npm/v/ferrovec?logo=npm&label=npm&color=CB3837" /></a>
  <a href="https://developer.mozilla.org/en-US/docs/WebAssembly"><img alt="wasm core size" src="https://img.shields.io/badge/wasm%20core-77%20KB%20%7C%2035%20KB%20gzip-5B48D8" /></a>
  <a href="https://crates.io/crates/ferrovec"><img alt="Rust core on crates.io" src="https://img.shields.io/crates/v/ferrovec?logo=rust&label=rust%20core&color=C13A15" /></a>
  <a href="https://github.com/singhpratech/ferrovec/blob/main/LICENSE"><img alt="license" src="https://img.shields.io/npm/l/ferrovec" /></a>
</p>

**The in-browser vector store that remembers.** Text-in semantic search for the
browser: [transformers.js](https://github.com/huggingface/transformers.js)
embeddings over a Rust/wasm HNSW core, running on a dedicated Web Worker — and,
unlike the in-memory browser vector libs, it **persists to OPFS so your index
survives reloads** and runs **single-writer leader election so multiple tabs
share one consistent store** instead of silently diverging.

You give it text. It embeds, indexes, searches, and *remembers* — off the main
thread, across reloads, across tabs. Nothing leaves the device.

**`0.4.0`** — the three-line browser API (embeddings + OPFS persistence),
**safe across multiple tabs** via single-writer leader election, and now
**crash-safe**: checksummed snapshots plus a write-ahead log, verified by a
[published kill-the-tab chaos suite](https://singhpratech.github.io/ferrovec/chaos.html).
· [Website](https://singhpratech.github.io/ferrovec/) · [**▶ Live demo**](https://singhpratech.github.io/ferrovec/live.html) · [GitHub](https://github.com/singhpratech/ferrovec) · [Rust core on crates.io](https://crates.io/crates/ferrovec)

> **▶ [Try the live demo](https://singhpratech.github.io/ferrovec/live.html)** — this package, running seven
> use cases in your browser tab (notes that survive a reload, a tab killed mid-write, two tabs on
> one store, a corrupted snapshot, a wrong model refused), each checked by the page itself.
> No download wanted? The [instant demo](https://singhpratech.github.io/ferrovec/demo.html) runs the WASM core over baked vectors.

## Who it's for

ferrovec is for apps where the vectors in the browser are the **only copy**, and losing them would be a bug the user notices — not a cache you can rebuild.

- **Local-first notes, journals, and PKM tools.** The user types a note, sees it saved, and closes the lid. The acknowledged insert survives a tab kill; the next open replays the log. No sync server, no re-embedding on launch.
- **Offline field apps.** Inspection, clinical, survey, or agricultural tools that run for hours without a network and get force-closed by the OS. Semantic search over what was captured has to survive that.
- **Privacy-bound RAG.** Chat-with-your-documents for legal, HR, health, or internal docs where nothing may leave the device. Embedding a large corpus takes minutes; a checksummed, crash-tested index turns that one-time ingest into a durable asset.
- **Browser extensions with memory.** Tab-history search, reading-list recall, "what did I see about X last week". Extensions are killed and restarted constantly; the write-ahead log is what makes *remembered* true.
- **Multi-tab dashboards.** Support consoles, CRMs, admin tools where one user has five tabs open and each inserts and searches. One elected leader, one consistent store, no diverging indexes.
- **Kiosks, edge, and PWA devices with no backend.** They reboot unexpectedly and nobody is there to re-ingest. Open picks the newest valid snapshot, refuses a corrupt one with a typed error, and the app decides what to do.
- **Agent memory in the tab.** Assistants that accumulate episodic memory over weeks. The embedding-space guard refuses to open a store under a different model instead of silently returning wrong neighbours.

**Not a fit:** anything that needs power-loss durability (OPFS `flush()` is not `fsync`), shared state across users or devices, or an index larger than one tab's memory. See [Durability guarantees](#durability-guarantees) for the exact promises.

**First open downloads the embedding model** (`Xenova/all-MiniLM-L6-v2`, about 23 MB quantized) from the Hugging Face Hub and caches it in the browser; every open after that is fully offline. Your text and vectors never leave the device at any point.

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
await db.flush();                                         // force log flush + checkpoint
await db.close();                                         // final checkpoint + terminate worker
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

Bulk ingest can trade the last ~50 ms for speed, then force durability:

```ts
const db = await Ferrovec.open('notes', { durability: 'relaxed' });
/* ... many inserts ... */ await db.flush(); // log flush + checkpoint
```

How it works:

- The worker holds exclusive `FileSystemSyncAccessHandle`s (worker-only,
  secure-context-only) on `ferrovec/<name>/slot-a.bin` and `slot-b.bin` in OPFS.
- Every `insert`/`remove` is appended to a write-ahead log, `wal.bin`, next to
  the slot files. With the default `durability: 'strict'` the record is flushed
  to OPFS before the promise resolves; `durability: 'relaxed'` acknowledges
  immediately and flushes on a 50 ms timer (for bulk ingest; can lose the last
  ~50 ms on a tab kill).
- Every 2,000 records or 4 MiB, and on `flush()`/`close()`, a **checkpoint**
  writes a complete FVS2 snapshot (`write` → `truncate` → `flush`) to the slot
  that does **not** hold the current committed version, and only then resets the
  log. On open, the valid snapshot with the highest sequence wins and the log is
  replayed on top of it. `close()` always performs a final checkpoint before
  releasing the lock.
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

## Durability guarantees

- **Checksummed snapshots.** Every persisted snapshot is a self-describing FVS2
  file: magic, format version, a commit sequence number, metadata (embedding
  model id, dimensions, metric, live item count, writer, timestamp) and a CRC-32
  over the whole file. Truncated, bit-flipped, or trailing-garbage files are
  detected on open and never decoded into a wrong index. Byte layout: see
  [`src/snapshot.ts`](https://github.com/singhpratech/ferrovec/blob/main/js/src/snapshot.ts).
- **Two slots.** Commits alternate between `slot-a.bin` and `slot-b.bin` in the
  store's OPFS directory. A crash mid-write can only damage the slot being
  written; the previous commit survives and is recovered on the next open. If
  every non-empty slot is unreadable, `open` throws `StoreCorruptError` rather
  than silently starting empty. The exception is a new store whose *first*
  checkpoint was torn: its log is still based on "no snapshot" and holds every
  acknowledged write, so the store opens from the log (with a warning naming
  the torn slot). With no such log the torn slot's data exists nowhere else,
  and `open` still throws.
- **Write-ahead log.** In `'strict'` mode (default) each insert/remove record,
  CRC-32 framed, is flushed to `wal.bin` before its promise resolves: the
  acknowledgement is the durability point. The log's checksummed `FVW2` header
  records its base snapshot sequence, the dimensions and the embedding model id
  (layout: [`src/wal.ts`](https://github.com/singhpratech/ferrovec/blob/main/js/src/wal.ts)).
  A bad header over logged records is refused (`StoreCorruptError`), not
  discarded; the narrow window is a log shorter than 282 bytes (the largest
  possible header), which can only be a header write cut off before anything
  was logged and is discarded with a warning when a valid snapshot exists. Checkpoints (every 2,000 records or
  4 MiB, and on `flush()`/`close()`) write a full snapshot to the non-current
  slot and only then reset the log. On open the log's base sequence is compared
  with the newest valid snapshot: equal replays, older is already folded in and
  is discarded, newer is refused as corrupt rather than guessed. A tab killed
  mid-append leaves a torn tail; replay stops at the first record that overruns
  the file, fails its CRC or does not parse, and truncates there, so a record is
  applied whole or not at all.
- **Append failures.** If the log append for a brand-new id fails (e.g. storage
  quota), the in-memory insert is rolled back and the promise rejects. For an
  upsert of an existing id or a remove, the in-memory change stands and the
  promise rejects; it becomes durable at the next successful checkpoint. That is
  **at least once** for upserts and removes.
- **Model guard.** Opening a store with a different embedding model than it was
  written with throws `EmbeddingSpaceMismatchError` before any model download;
  dimensions are re-checked once the embedder loads. This holds before the first
  checkpoint too: the log header records the model. A log that names a different
  model than the snapshot it applies to is refused (`StoreCorruptError`).
- **No accidental wipe.** An empty index never overwrites a non-empty on-disk
  index unless items were explicitly removed in that session
  (`EmptyOverwriteRefusedError`; the on-disk data is left untouched).
- **Catchable by name.** Errors keep their `name` across the worker boundary:

```ts
try {
  const db = await Ferrovec.open('notes', { model: 'Xenova/bge-small-en-v1.5' });
} catch (err) {
  switch ((err as Error).name) {
    case 'EmbeddingSpaceMismatchError':
      // Either reopen with the model the store was written with, or start over:
      await Ferrovec.destroy('notes'); // permanently deletes the store
      break;
    case 'StoreCorruptError':
      await Ferrovec.destroy('notes'); // or restore from your own copy
      break;
    default:
      throw err;
  }
}
```

`Ferrovec.destroy(name)` deletes the store's OPFS directory; close every handle
to it first, in this tab and others.

**Persistent storage.** `Ferrovec.open` asks the browser for persistent storage
(`navigator.storage.persist()`); the answer is `db.storagePersisted`. Firefox
shows a prompt for this, so `Ferrovec.open(name, { requestPersistentStorage: false })`
opts out (default `true`).

**Upgrading from 0.3.x.** Old single-file stores (`index.bin`, FVS1) are read
once and migrated to the slot format on the first commit; the old file is then
deleted. **Close every tab of your app first:** a 0.3.x tab that becomes leader
after a newer tab has migrated the store will write the old single-file format,
which the new code ignores once slots exist.

**What this does not promise:**

- OPFS `flush()` is content-consistency, not `fsync`. The guarantee is
  "survives a tab kill, crash, or reload", not "survives power loss". Keep a
  server-side copy of anything irreplaceable.
- Safari deletes all script-writable storage for an origin after 7 days of
  Safari use without interacting with the site, unless the app is installed to
  the Home Screen. `persist()` grants are heuristic.
- Reopen time grows with store size: it replays up to 2,000 records on top of
  the snapshot decode (p95 325 ms on Firefox at about 6,000 documents), and a
  threshold checkpoint is a full snapshot write.

**Crash-tested.** `npm run test:chaos` kills headless browser tabs at random
moments (including mid-insert), reopens, and checks every acknowledged id by
querying its exact text:

| Browser | Cycles | Acked writes | Lost | Reopen p50 / p95 |
| --- | ---: | ---: | ---: | ---: |
| Chromium 149 | 1,000 | 5,887 | **0** | 64 / 83 ms |
| Firefox 151 | 1,000 | 6,012 | **0** | 174 / 325 ms |
| WebKit | not run | n/a | n/a | n/a |

Chromium recovered 1 torn tail. The harness forces a checkpoint every 50 logged records (versus the 2,000-record production default) so that kills also land during and right after checkpoints; batches are 1 to 20 documents and the kill lands at a random point, including mid-insert. WebKit would not launch on the CI host. A
negative control with the log write deferred by 30 ms reported every
acknowledged write in a 30-cycle run as lost, so the harness does detect loss.
Details: [crash-test results](https://singhpratech.github.io/ferrovec/chaos.html).

## Multi-tab

Opening the **same store name in two tabs** used to make the second tab silently
degrade to a private in-memory copy — the two would diverge and the second tab's
writes never reached disk. As of `0.4.0` ferrovec runs **single-writer leader
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
  the newest valid slot) and becomes the new leader. In-flight follower requests are
  retried and transparently answered by the new leader; `db.role` flips from
  `'follower'` to `'leader'` on promotion. Because the promoting tab holds the
  exclusive lock, it is the legitimate owner of the slot files: on transient OPFS
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
| **M1–M2** | Rust HNSW core + WASM boundary + SIMD | ✅ `0.4.0` |
| **M3** | Web Worker + transformers.js auto-embedding | ✅ `0.4.0` |
| **M4** | OPFS persistence (survives reloads) | ✅ `0.4.0` |
| **M5** | Three-line browser API on npm | ✅ `0.4.0` |
| **M6** | Cross-tab leader election (Web Locks) | ✅ `0.4.0` |
| **M7** | Crash-safe storage — checksummed A/B snapshots, write-ahead log, chaos suite | ✅ `0.4.0` |

The pure-Rust HNSW core is published separately on [crates.io](https://crates.io/crates/ferrovec).

## License

MIT
