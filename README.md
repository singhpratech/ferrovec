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
  <a href="https://developer.mozilla.org/en-US/docs/WebAssembly"><img alt="wasm core size" src="https://img.shields.io/badge/wasm%20core-~33%20KB%20gzip-5B48D8" /></a>
  <a href="./LICENSE"><img alt="license" src="https://img.shields.io/crates/l/ferrovec" /></a>
</p>

Most in-browser vector libraries hand you an *in-memory* index: fast to query, but it evaporates on reload and diverges the moment a second tab opens. `ferrovec` is the one built to be **durable and shared** — the HNSW graph lives on disk in the browser's Origin Private File System, and a single-writer leader election keeps every tab reading and writing one consistent store. Private, offline, survives the refresh. You never write Rust; you never run a server.

- 💾 **Durable by default** — the index persists to OPFS and rehydrates on `open()`. Reload the tab and your vectors are already there — no re-embedding, no rebuild. *(Most browser vector libs are in-memory only.)*
- 🪟 **Cross-tab consistent** — single-writer leader election (Web Locks + BroadcastChannel) so many tabs share one store instead of silently diverging. *(No other in-browser vector lib ships this today.)*
- ➕ **Incremental** — upsert-style inserts, tombstoning removals, and in-place `compact()`; add one vector without rebuilding the whole index.
- 🦀 **Real HNSW, in Rust** — a hand-rolled Hierarchical Navigable Small World graph, the same algorithm behind Pinecone, Weaviate, and Qdrant — not brute force.
- 🪶 **Featherweight & shim-free** — `serde` + `postcard` are the *only* dependencies; the WASM core is ~33 KB gzipped, with no `getrandom` (deterministic splitmix64 PRNG) and no threads, so it's happy on bare `wasm32-unknown-unknown`.
- ⚡ **SIMD-accelerated** distance on `wasm32 + simd128` with a scalar fallback; `#![deny(unsafe_code)]` everywhere outside the audited kernel. Portable versioned byte format reloads identically native or in-browser.

> **Status — the roadmap is complete, and both registries are on `0.3.4`.** crates.io `0.3.4` ships the Rust core (**M1**), WASM boundary (**M2**), and in-place [compaction](#compaction--clearing); npm `0.3.4` ships the full browser package: transformers.js auto-embedding (**M3**), OPFS persistence (**M4**), the three-line API (**M5**), and cross-tab single-writer leader election (**M6**). See the [roadmap](#roadmap), or **[try the live demo](https://singhpratech.github.io/ferrovec/demo.html)**.

## How ferrovec is different

In-browser vector search is a **crowded space** in 2026 — and this section is here to be honest about it. Plenty of libraries now put an HNSW index in the browser, several of them Rust→WASM like this one (altor-vec, EdgeVec, VecLite, ruvector). What almost none of them do is **remember**: they're in-memory engines — load vectors, query, and on the next reload you start over. Persistence and multi-tab consistency are left to you.

ferrovec's wedge is exactly that missing half — **durability and consistency**:

| | Engine | Index | Incremental | Persists in-browser | Cross-tab safe |
| --- | --- | --- | --- | --- | --- |
| **ferrovec** | Rust/WASM | **HNSW** | ✅ | ✅ **OPFS, built-in** | ✅ **leader election** |
| altor-vec | Rust/WASM | HNSW | ✅ | ❌ | ❌ |
| EdgeVec / VecLite / ruvector | Rust/WASM | HNSW | ✅ | ❌ in-memory | ❌ |
| EntityDB | JS + WASM | brute-force | ✅ | ✅ IndexedDB | ❌ |
| voy | Rust/WASM | kd-tree | ❌ rebuild | ❌ app-managed | ❌ |
| Orama | TypeScript | brute-force | ✅ | ❌ serialize only | ❌ |

*Landscape as surveyed July 2026; this field moves fast, so treat other projects' rows as directional and check their latest.* If all you need is a fast in-memory ANN for a single page view, several of these are excellent and lighter than ferrovec. Reach for ferrovec when the index has to **outlive the page** and **stay correct across tabs** — a notes app, an offline PWA, or "chat with your docs" that shouldn't re-embed everything on every visit.

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

> **▶ [Try the live demo](https://singhpratech.github.io/ferrovec/demo.html)** — the real WASM core running semantic search over 24 sentence embeddings, entirely in your browser tab. No server, no network: the wasm binary and the vectors are baked into a single HTML file.

`ferrovec` compiles to WebAssembly and exposes a `FerrovecCore` class through `wasm-bindgen`. Build it with [`wasm-pack`](https://rustwasm.github.io/wasm-pack/):

```sh
wasm-pack build --target bundler --release
# -> pkg/  (ferrovec_bg.wasm ~33 KB gzip, JS bindings, TypeScript types)
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
> (**M3**), OPFS persistence (**M4**), and cross-tab leader election (**M6**), so the browser API becomes:
> `const db = await Ferrovec.open('notes'); await db.insert(text); const hits = await db.query('…', 5);`
> — live on npm as `0.3.4`.

To smoke-test WASM compatibility without packaging:

```sh
cargo build --target wasm32-unknown-unknown
```

## Roadmap

| | Milestone | Status |
| --- | --- | --- |
| **M1** | Pure-Rust HNSW core | ✅ `0.3.4` |
| **M2** | WASM boundary (`FerrovecCore`) + SIMD128 kernel | ✅ `0.3.4` |
| **—** | `compact()` / `clear()` compaction | ✅ `0.3.4` |
| **M3** | Web Worker + transformers.js auto-embedding | ✅ `0.3.4` |
| **M4** | OPFS-backed persistence (survives reloads) | ✅ `0.3.4` |
| **M5** | `ferrovec` on npm — the three-line browser API | ✅ `0.3.4` |
| **M6** | Cross-tab leader election (Web Locks) | ✅ `0.3.4` |

> Both registries are published at **`0.3.4`** — crates.io (Rust core) and npm (browser package).

## Design notes

- **Why hand-rolled?** No mature Rust HNSW crate compiles cleanly to `wasm32-unknown-unknown` — they hard-depend on `rayon`, `mmap-rs`, or `num_cpus`. Owning the graph keeps the dependency tree tiny and the WASM artifact small.
- **Determinism.** The build is reproducible from `Config::seed`; there is no `getrandom` in the dependency tree.
- **Tombstones & compaction.** `remove` marks a node deleted and excludes it from results while keeping it for graph connectivity, so heavy churn grows memory over time. `compact` rebuilds the index in place from the live vectors only — deterministically, by rewinding the PRNG to `Config::seed` — reclaiming the space held by tombstoned nodes. `clear` resets the index to empty while keeping its dimensionality and config.

## License

MIT © singhpratech
