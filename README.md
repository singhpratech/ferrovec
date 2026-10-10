<p align="center">
  <img src="https://raw.githubusercontent.com/singhpratech/ferrovec/main/docs/assets/logo-256.png" alt="ferrovec logo" width="104" />
</p>

<h1 align="center">ferrovec</h1>

<p align="center">
  <img src="https://raw.githubusercontent.com/singhpratech/ferrovec/main/docs/assets/cover.jpg" alt="ferrovec — a Milky Way galaxy with an HNSW vector-search graph woven through it, a triangle at its core" width="840" />
</p>

**The in-browser vector store that _remembers_.** A Rust→WASM [HNSW](https://arxiv.org/abs/1603.09320) engine that persists to disk (OPFS) and stays consistent across tabs — so semantic search survives a reload instead of rebuilding from scratch every time.

<p align="center">
  <a href="https://crates.io/crates/ferrovec"><img alt="crates.io" src="https://img.shields.io/crates/v/ferrovec?logo=rust&label=crates.io&color=C13A15" /></a>
  <a href="https://www.npmjs.com/package/ferrovec"><img alt="npm" src="https://img.shields.io/npm/v/ferrovec?logo=npm&label=npm&color=CB3837" /></a>
  <a href="https://docs.rs/ferrovec"><img alt="docs.rs" src="https://img.shields.io/docsrs/ferrovec?logo=docsdotrs&label=docs.rs" /></a>
  <a href="https://developer.mozilla.org/en-US/docs/WebAssembly"><img alt="wasm core size" src="https://img.shields.io/badge/wasm%20core-77%20KB%20%7C%2035%20KB%20gzip-5B48D8" /></a>
  <a href="./LICENSE"><img alt="license" src="https://img.shields.io/crates/l/ferrovec" /></a>
</p>

Most in-browser vector libraries hand you an *in-memory* index: fast to query, but it evaporates on reload and diverges the moment a second tab opens. `ferrovec` is the one built to be **durable and shared** — the HNSW graph lives on disk in the browser's Origin Private File System, and a single-writer leader election keeps every tab reading and writing one consistent store. Private, offline, survives the refresh. You never write Rust; you never run a server.

- 💾 **Durable by default** — the index persists to OPFS and rehydrates on `open()`. Reload the tab and your vectors are already there — no re-embedding, no rebuild. *(Most browser vector libs are in-memory only.)*
- 🪟 **Cross-tab consistent** — single-writer leader election (Web Locks + BroadcastChannel) so many tabs share one store instead of silently diverging. *(No other in-browser vector lib ships this today.)*
- ➕ **Incremental** — upsert-style inserts, tombstoning removals, and in-place `compact()`; add one vector without rebuilding the whole index.
- 🦀 **Real HNSW, in Rust** — a hand-rolled Hierarchical Navigable Small World graph, the same algorithm behind Pinecone, Weaviate, and Qdrant — not brute force.
- 🪶 **Featherweight & shim-free** — `serde` + `postcard` are the *only* dependencies; the WASM core is 77 KB (35 KB gzipped), with no `getrandom` (deterministic splitmix64 PRNG) and no threads, so it's happy on bare `wasm32-unknown-unknown`.
- ⚡ **SIMD-accelerated** distance on `wasm32 + simd128` with a scalar fallback; `#![deny(unsafe_code)]` everywhere outside the audited kernel. Portable versioned byte format reloads identically native or in-browser.

> **Status — both registries are on `0.4.0`.** crates.io `0.4.0` ships the Rust core (**M1**), WASM boundary (**M2**), and in-place [compaction](#compaction--clearing); npm `0.4.0` ships the full browser package: transformers.js auto-embedding (**M3**), OPFS persistence (**M4**), the three-line API (**M5**), cross-tab single-writer leader election (**M6**), and — new in `0.4.0` — crash-safe storage (**M7**): checksummed snapshots, a write-ahead log, and a published [kill-the-tab chaos suite](https://singhpratech.github.io/ferrovec/chaos.html) with zero acknowledged writes lost over 1,000 cycles each in Chromium and Firefox. See the [roadmap](#roadmap), or **[try the live demo](https://singhpratech.github.io/ferrovec/demo.html)**.

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

## How ferrovec is different

In-browser vector search is a **crowded space** in 2026 — and this section is here to be honest about it. Plenty of libraries now put an HNSW index in the browser, several of them Rust→WASM like this one (altor-vec, EdgeVec, VecLite, ruvector). What almost none of them do is **remember safely**: the index is a blob the app has to save, nothing is checksummed, nothing is crash-tested, and multi-tab consistency is left to you.

ferrovec's wedge is exactly that missing half — **durability and consistency**:

| Library | Engine | Index | Incremental | Embeddings | Persists to | Checksummed file | Durable commit | Multi-tab | Published crash test | Size |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **ferrovec 0.4.0** | Rust→WASM | **HNSW** | ✅ | ✅ built in (MiniLM) | ✅ **OPFS**: two snapshot slots + write-ahead log | ✅ CRC-32 | ✅ flushed before ack | ✅ **Web Locks leader** | ✅ 1,000 cycles × 2 browsers | 77 KB (35 KB gz) |
| EdgeVec | Rust→WASM | HNSW + binary quantization | ✅ | ❌ bring your own | IndexedDB, one put of the whole blob | ❌ | ❌ (Rust WAL exists, not exposed in the browser) | ❌ single tab by design | ❌ | 217 KB gz (self-reported) |
| VecLite | Rust→WASM | HNSW | ✅ | transformers.js | IndexedDB / JSON blob | ❌ | ❌ | ❌ | ❌ | not published |
| @ruvector/wasm | Rust→WASM | HNSW | ✅ | ❌ bring your own | IndexedDB vectors; graph rebuilt on load | ❌ | ❌ | ❌ | ❌ | not published |
| voy | Rust→WASM | k-d tree | ❌ rebuild | ❌ bring your own | serialize to string; app stores it | ❌ | ❌ every add returns a new blob | ❌ | ❌ | not published |
| altor-vec | Rust→WASM | HNSW | ✅ | ❌ bring your own | static index built at deploy, fetched from CDN | ❌ | ❌ | ❌ | ❌ | 54 KB |
| Orama | TypeScript | brute-force | ✅ | plugin | persistence plugin: snapshot blob, app stores it | ❌ | ❌ | ❌ | ❌ | not measured |
| EntityDB | JS + WASM | brute-force | ✅ | ✅ built in (transformers.js) | IndexedDB, one record per vector | ❌ | ⚠️ per-record IndexedDB transactions | ⚠️ shared DB, no coordination | ❌ | not measured |
| MeMemo | JS | HNSW | ✅ | ❌ bring your own | IndexedDB vectors, graph in memory | ❌ | ⚠️ per-record | ❌ | ❌ | not measured |
| hnsw (npm) / TinkerBird | JS | HNSW | ✅ | ❌ bring your own | IndexedDB | ❌ | ⚠️ | ❌ | ❌ | not measured |
| sqlite-vec in SQLite Wasm | C→WASM | brute-force | ✅ | ❌ bring your own | OPFS through SQLite's VFS | ⚠️ journal, no page checksums by default | ✅ SQLite atomic commit | ❌ one connection per OPFS pool | ❌ | ~1.5 MB wasm |
| PGlite + pgvector | Postgres→WASM | HNSW / IVFFlat | ✅ | ❌ bring your own | IndexedDB whole-file flush, or OPFS (worker only, no Safari) | ⚠️ Postgres checksums off by default | ✅ Postgres WAL inside the VFS | ⚠️ BroadcastChannel leader, open bugs | ❌ | ~3 MB gz |
| DuckDB-wasm + vss | C++→WASM | HNSW (experimental) | ✅ | ❌ bring your own | OPFS WAL + checkpoint | ❌ | ⚠️ HNSW WAL recovery "not implemented" | ❌ one handle per file | ❌ | several MB |
| turbovec | Rust / Python | flat TurboQuant scan | ✅ | ❌ | server / local disk — does not build for WASM (64-bit only) | ❌ | ❌ | ❌ | ❌ | n/a |

*What each project documents about itself, checked 2026-10-10. A ❌ means the project does not claim it; ⚠️ means it half-qualifies. Only ferrovec's row has been crash-tested by us ([results](https://singhpratech.github.io/ferrovec/chaos.html)); the SQL engines inherit real transactional commits from SQLite and Postgres, at 20–40× the size and with no ANN index, no Safari, or an experimental flag. This field moves fast; check each project's latest.* If all you need is a fast in-memory ANN for a single page view, several of these are excellent and lighter than ferrovec. Reach for ferrovec when the index has to **outlive the page** and **stay correct across tabs** — a notes app, an offline PWA, or "chat with your docs" that shouldn't re-embed everything on every visit.

## Durability guarantees

Persisting is easy; persisting *safely* is the part that usually goes missing. This is what ferrovec's on-disk store (npm package, OPFS) does and does not promise.

**Self-describing, checksummed snapshots.** Every checkpoint is a single FVS2 file, written alongside a write-ahead log (`wal.bin`, below):

| Field | Size | Purpose |
| --- | --- | --- |
| magic `FVS2` + format version | 4 + 2 bytes | Reject files that are not snapshots, or are from an unknown format |
| commit sequence | 8 bytes | Monotonic counter; the newest valid commit wins on open |
| section lengths | 3 × 4 bytes | Must sum to the exact file length, so truncation and trailing garbage are caught |
| CRC-32 | 4 bytes | Over the whole file; catches bit flips |
| metadata (JSON) | variable | Embedding model id, dimensions, metric, live item count, writer, timestamp |
| index + id→text sidecar | variable | The HNSW core bytes and the stored texts |

A truncated, bit-flipped, or trailing-garbage file is detected on open and never decoded into a wrong index. The exact byte layout is documented at the top of [`js/src/snapshot.ts`](./js/src/snapshot.ts).

**Two slots, so a crash can only hurt the write in flight.** Commits alternate between `slot-a.bin` and `slot-b.bin` inside the store's OPFS directory, always writing to the slot that does *not* hold the current commit. A crash mid-write can only damage the slot being written; the previous commit survives and is recovered on the next open. If every non-empty slot is unreadable, `open` throws `StoreCorruptError` instead of silently starting empty. The one exception is a new store whose *first* checkpoint was torn: its write-ahead log is still based on "no snapshot" and holds every acknowledged write, so the store opens from the log and logs a warning naming the torn slot. If the log is missing or based on a later snapshot, the torn slot held data that exists nowhere else, and `open` still throws.

**Write-ahead log.** Next to the two slot files sits `wal.bin`. Every `insert` and `remove` is appended to it as one framed record with its own CRC-32 (layout at the top of [`js/src/wal.ts`](./js/src/wal.ts)). The log's checksummed header (format `FVW2`) records the snapshot sequence it applies on top of, the dimensions and the embedding model id. A bad header over logged records is refused (`StoreCorruptError`), not discarded; the narrow window is a log shorter than 282 bytes (the largest possible header), which can only be a header write cut off before anything was logged and is discarded with a warning when a valid snapshot exists. In the default `durability: 'strict'` mode the record is flushed to OPFS *before* the `insert` or `remove` promise resolves, so the acknowledgement is the durability point: once you have seen it, the write survives a tab kill. `durability: 'relaxed'` acknowledges immediately and flushes on a 50 ms timer; it can lose the last ~50 ms on a tab kill and exists for bulk ingest.

```ts
const db = await Ferrovec.open('notes', { durability: 'relaxed' }); // bulk ingest
// ... many inserts ...
await db.flush(); // force a log flush plus a checkpoint
```

- **Checkpoints.** Every 2,000 records or 4 MiB of log, and on `flush()` and `close()`, the full FVS2 snapshot is written to the non-current slot. Only after that flush is the log reset to a fresh header based on the new snapshot sequence. A threshold checkpoint is a full snapshot write, so it costs time proportional to the store.
- **Open decides by sequence.** The log's base sequence is compared with the newest valid snapshot. Equal: the log is replayed on top of it. Older: the log was already folded into that snapshot and is discarded. Newer: impossible under this ordering, so it is refused as corrupt rather than guessed.
- **Torn tails are normal.** A tab killed mid-append leaves a partial last record. Replay stops at the first record that overruns the file, fails its CRC, or does not parse, and truncates the log back to the last good record. A record is applied whole or not at all.
- **If an append fails** (for example storage quota): for a brand-new id, the in-memory insert is rolled back and the promise rejects, so memory and disk agree. For an upsert of an existing id or a `remove`, the in-memory change stands and the promise rejects; it becomes durable at the next successful checkpoint. Treat upserts and removes as **at least once**: a rejection does not mean the change was discarded.
- **Reopen cost.** Opening replays up to 2,000 records on top of the snapshot decode, so reopen time grows with store size (p95 325 ms on Firefox at about 6,000 documents, below).

**Errors you can act on.** Each has a stable `name`, preserved across the worker boundary, so `switch (err.name)` works:

| Error | When | What to do |
| --- | --- | --- |
| `EmbeddingSpaceMismatchError` | The store was written with a different embedding model than the one you opened it with. Thrown before any model download, also for a store killed before its first checkpoint (the log header records the model); dimensions are re-checked once the embedder loads. | Open with the stored model, or `await Ferrovec.destroy(name)` to delete the store and start over. |
| `StoreCorruptError` | Every non-empty snapshot slot failed validation and the log cannot stand in for it, or the write-ahead log cannot be applied (based on a lost snapshot, or naming a different model than the snapshot). | Nothing is overwritten. `await Ferrovec.destroy(name)` and re-index, or restore from your own copy. |
| `EmptyOverwriteRefusedError` | A commit would replace a non-empty on-disk index with an empty one, and no items were explicitly removed in this session (the signature of a failed load, not of intent). | The on-disk data is untouched. Investigate why the index came up empty; removing items explicitly in-session makes an empty index legitimate. |
| `SnapshotCorruptError` | A single snapshot blob failed to decode (carries a `reason`). | Normally handled internally by falling back to the other slot; you see it only when decoding directly. |

```ts
try {
  const db = await Ferrovec.open('notes', { model: 'Xenova/bge-small-en-v1.5' });
} catch (err) {
  if ((err as Error).name === 'EmbeddingSpaceMismatchError') {
    await Ferrovec.destroy('notes'); // deletes the store; re-index afterwards
  } else throw err;
}
```

`Ferrovec.destroy(name)` permanently deletes a store's OPFS directory. Close every handle to it first, in this tab and others.

**Persistent storage.** `Ferrovec.open` asks the browser for persistent storage (`navigator.storage.persist()`) so the origin's data is not evicted under storage pressure. The answer is exposed as `db.storagePersisted`. Firefox shows a permission prompt for this; pass `open(name, { requestPersistentStorage: false })` to opt out.

**Upgrading from 0.3.x.** Existing stores (a single `index.bin`, FVS1) are read once and migrated to the slot format on the first commit; the old file is then deleted. Close every tab of your app before upgrading: a 0.3.x tab that becomes leader after a newer tab has migrated the store will write the old single-file format, which the new code ignores once slots exist.

**What this does *not* promise:**

- **Not power-loss durability.** OPFS `flush()` guarantees content consistency, not `fsync`. The guarantee is "survives a tab kill, crash, or reload", not "survives power loss or an OS crash". Keep a server-side copy of anything irreplaceable.
- **The browser can still delete your data.** Safari removes all script-writable storage for an origin after 7 days of Safari use without interacting with the site, unless the app is installed to the Home Screen. `persist()` grants are heuristic and differ per browser.

**Crash-tested.** `npm run test:chaos` (in `js/`) drives headless browsers through kill-the-tab cycles: open the store, insert a random batch, kill the page at a random moment (including mid-insert), reopen, and verify that every acknowledged id is present by querying its exact text. Results on 2026-10-10:

| Browser | Cycles | Acked writes | Lost | Reopen p50 / p95 |
| --- | ---: | ---: | ---: | ---: |
| Chromium 149 | 1,000 | 5,518 | **0** | 65 / 84 ms |
| Firefox 151 | 1,000 | 5,445 | **0** | 171 / 303 ms |
| WebKit | not run | n/a | n/a | n/a |

Neither run hit a torn log tail this time (an earlier Chromium run on the previous log format recovered one). The harness forces a checkpoint every 50 logged records (versus the 2,000-record production default) so that kills also land during and right after checkpoints; batches are 1 to 20 documents and the kill lands at a random point, including mid-insert. WebKit is not covered: Playwright WebKit would not launch on the CI host. As a negative control, a build with the log write deferred by 30 ms reported every acknowledged write in a 30-cycle run as lost, which shows the harness detects loss. Details and the re-run recipe: [crash-test results](./docs/chaos.html).

---

## Install

```toml
[dependencies]
ferrovec = "0.3"
```

## Quick start

```rust
use ferrovec::{Hnsw, Metric, Config};

// A 4-dimensional index using the defaults (Cosine metric).
let mut index = Hnsw::new(4);

index.insert("a", &[1.0, 0.0, 0.0, 0.0]).unwrap();
index.insert("b", &[0.0, 1.0, 0.0, 0.0]).unwrap();
index.insert("c", &[0.9, 0.1, 0.0, 0.0]).unwrap();

let results = index.search(&[1.0, 0.0, 0.0, 0.0], 2).unwrap();
assert_eq!(results[0].id, "a"); // nearest first
assert_eq!(index.len(), 3);
```

### Tuning

```rust
use ferrovec::{Hnsw, Config, Metric};

let index = Hnsw::with_config(
    128,
    Config {
        max_connections: 16,   // M — neighbors per node per layer
        ef_construction: 200,  // build-time candidate list size
        ef_search: 50,         // query-time candidate list size
        metric: Metric::L2,
        seed: 42,
    },
);
assert_eq!(index.dims(), 128);
```

### Upsert & remove

```rust
use ferrovec::Hnsw;

let mut index = Hnsw::new(2);
index.insert("x", &[0.0, 1.0]).unwrap();
index.insert("x", &[1.0, 0.0]).unwrap(); // replaces the previous "x"
assert_eq!(index.len(), 1);

assert!(index.remove("x"));
assert!(!index.remove("x")); // already gone
assert!(index.is_empty());
```

### Compaction & clearing

`remove` and upserting `insert` only *tombstone* a node — it lingers in the graph so the index stays connected, which means heavy churn grows memory over time. `compact` rebuilds the index in place from the live vectors only, reclaiming that space, while `contains` reports whether an id is still live:

```rust
use ferrovec::Hnsw;

let mut index = Hnsw::new(2);
index.insert("keep", &[1.0, 0.0]).unwrap();
index.insert("drop", &[0.0, 1.0]).unwrap();
index.remove("drop"); // tombstoned, but still occupying memory

index.compact(); // rebuild keeping only live nodes

assert_eq!(index.len(), 1);        // live count is unchanged by compaction
assert!(index.contains("keep"));
assert!(!index.contains("drop"));  // removed ids stay gone

// Live search results are still correct after compaction.
let hits = index.search(&[1.0, 0.0], 1).unwrap();
assert_eq!(hits[0].id, "keep");

// `clear` empties the index entirely, keeping its dims and config.
index.clear();
assert!(index.is_empty());
index.insert("fresh", &[0.5, 0.5]).unwrap(); // reusable afterwards
assert_eq!(index.len(), 1);
```

Compaction is deterministic: it rewinds the PRNG to `Config::seed` before rebuilding, so a compacted index matches a fresh build of the same survivors inserted in the same order.

### Persistence

```rust
use ferrovec::Hnsw;

let mut index = Hnsw::new(3);
index.insert("p", &[1.0, 2.0, 3.0]).unwrap();

let bytes = index.to_bytes().unwrap();          // -> Vec<u8> (FVEC header + payload)
let restored = Hnsw::from_bytes(&bytes).unwrap();

let a = index.search(&[1.0, 2.0, 3.0], 1).unwrap();
let b = restored.search(&[1.0, 2.0, 3.0], 1).unwrap();
assert_eq!(a, b);
```

## Distance metrics

All metrics are expressed so that **smaller means closer**:

| Metric           | Value                                   |
| ---------------- | --------------------------------------- |
| `Metric::Cosine` | `1 - cos(a, b)` (zero-norm ⇒ `1.0`)     |
| `Metric::Dot`    | `1 - dot(a, b)`                         |
| `Metric::L2`     | squared Euclidean distance              |

Vectors that are already L2-normalized (e.g. sentence embeddings) pair naturally with `Cosine` or `Dot`.

## In the browser

> **▶ [Try the live demo](https://singhpratech.github.io/ferrovec/demo.html)** — two parts, one page, no server. First the WASM core ranking real MiniLM vectors over 24 sentence embeddings in your tab; then, at the bottom, [a notebook](https://singhpratech.github.io/ferrovec/demo.html#notebook) on the npm package: write notes, pull the plug mid-write, open a second tab, and watch nothing acknowledged get lost.

`ferrovec` compiles to WebAssembly and exposes a `FerrovecCore` class through `wasm-bindgen`. Build it with [`wasm-pack`](https://rustwasm.github.io/wasm-pack/):

```sh
wasm-pack build --target bundler --release
# -> pkg/  (ferrovec_bg.wasm 77 KB, 35 KB gzip; JS bindings; TypeScript types)
```

Then use it from JavaScript — bring your own embeddings as a `Float32Array`:

```js
import { FerrovecCore } from "ferrovec";

const index = new FerrovecCore(384);              // 384-dim vectors
index.insert("doc-1", myEmbedding);               // Float32Array
const hits = index.search(queryEmbedding, 5);     // [{ id, distance }, ...]

const bytes = index.toBytes();                    // Uint8Array — persist anywhere
const restored = FerrovecCore.fromBytes(bytes);
```

> The `js/` package wraps this with automatic embedding via transformers.js
> (**M3**), crash-safe OPFS persistence (**M4**, **M7**), and cross-tab leader election (**M6**), so the browser API becomes:
> `const db = await Ferrovec.open('notes'); await db.insert(text); const hits = await db.query('…', 5);`
> — live on npm as `0.4.0`. `await db.list({ offset, limit })` pages through the stored `{ id, text }`
> documents in insertion order.

To smoke-test WASM compatibility without packaging:

```sh
cargo build --target wasm32-unknown-unknown
```

## Roadmap

| | Milestone | Status |
| --- | --- | --- |
| **M1** | Pure-Rust HNSW core | ✅ `0.4.0` |
| **M2** | WASM boundary (`FerrovecCore`) + SIMD128 kernel | ✅ `0.4.0` |
| **—** | `compact()` / `clear()` compaction | ✅ `0.4.0` |
| **M3** | Web Worker + transformers.js auto-embedding | ✅ `0.4.0` |
| **M4** | OPFS-backed persistence (survives reloads) | ✅ `0.4.0` |
| **M5** | `ferrovec` on npm — the three-line browser API | ✅ `0.4.0` |
| **M6** | Cross-tab leader election (Web Locks) | ✅ `0.4.0` |
| **M7** | Crash-safe storage — checksummed A/B snapshots, write-ahead log, kill-the-tab chaos suite | ✅ `0.4.0` |

> Both registries are published at **`0.4.0`** — crates.io (Rust core) and npm (browser package).

## Design notes

- **Why hand-rolled?** No mature Rust HNSW crate compiles cleanly to `wasm32-unknown-unknown` — they hard-depend on `rayon`, `mmap-rs`, or `num_cpus`. Owning the graph keeps the dependency tree tiny and the WASM artifact small.
- **Determinism.** The build is reproducible from `Config::seed`; there is no `getrandom` in the dependency tree.
- **Tombstones & compaction.** `remove` marks a node deleted and excludes it from results while keeping it for graph connectivity, so heavy churn grows memory over time. `compact` rebuilds the index in place from the live vectors only — deterministically, by rewinding the PRNG to `Config::seed` — reclaiming the space held by tombstoned nodes. `clear` resets the index to empty while keeping its dimensionality and config.

## License

MIT © singhpratech
