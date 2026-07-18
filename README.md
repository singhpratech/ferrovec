# ferrovec ▲

**A tiny, dependency-light [HNSW](https://arxiv.org/abs/1603.09320) vector index for approximate nearest-neighbor search — built to compile to WebAssembly.**

[![crates.io](https://img.shields.io/crates/v/ferrovec.svg)](https://crates.io/crates/ferrovec)
[![docs.rs](https://img.shields.io/docsrs/ferrovec)](https://docs.rs/ferrovec)
[![downloads](https://img.shields.io/crates/d/ferrovec.svg)](https://crates.io/crates/ferrovec)
[![license](https://img.shields.io/crates/l/ferrovec.svg)](./LICENSE)
[![wasm](https://img.shields.io/badge/wasm32-ready-5B48D8.svg)](https://developer.mozilla.org/en-US/docs/WebAssembly)

The winning WebAssembly apps never asked anyone to switch languages — they put a Rust engine inside and a plain API outside. `ferrovec` brings that pattern to semantic search: a fast nearest-neighbor core in Rust, so you can run private, offline vector search anywhere — in the browser, on the edge, or on a server.

- 🦀 **Rust core** — a hand-rolled HNSW graph, the same algorithm behind Pinecone, Weaviate, and Qdrant.
- 🪶 **Featherweight** — `serde` + `postcard` are the *only* dependencies. The WASM build is ~33 KB gzipped.
- 🔒 **No `unsafe`** outside the audited SIMD kernel (`#![deny(unsafe_code)]` crate-wide), and **no system randomness** (a deterministic seeded splitmix64 PRNG) — so it's happy on `wasm32-unknown-unknown` with no shims.
- ⚡ **SIMD-accelerated** distance kernels on `wasm32 + simd128`, with a scalar reference fallback everywhere else.
- ➕ **Incremental** upsert-style inserts and tombstoning removals — no rebuild-the-whole-index penalty.
- 💾 **Portable** — compact binary (de)serialization with a versioned header; the same bytes reload natively or in the browser.

> **Status — crates.io `0.2.0` is live** (Rust core **M1** + WASM boundary **M2** + in-place [compaction](#compaction--clearing)). The browser package is landing next: transformers.js auto-embedding (**M3**) is done and OPFS persistence (**M4**) ships the three-line API as **npm `0.2.0`**. See the [roadmap](#roadmap).

---

## Install

```toml
[dependencies]
ferrovec = "0.2"
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
> (**M3**, done) and OPFS persistence (**M4**), so the browser API becomes:
> `const db = await Ferrovec.open('notes'); await db.insert(text); const hits = await db.query('…', 5);`
> — shipping as npm `0.2.0`.

To smoke-test WASM compatibility without packaging:

```sh
cargo build --target wasm32-unknown-unknown
```

## Roadmap

| | Milestone | Status |
| --- | --- | --- |
| **M1** | Pure-Rust HNSW core | ✅ shipped (`0.1.0`) |
| **M2** | WASM boundary (`FerrovecCore`) + SIMD128 kernel | ✅ shipped (`0.1.0`) |
| **—** | `compact()` / `clear()` compaction | ✅ shipped (crates.io `0.2.0`) |
| **M3** | Web Worker + transformers.js auto-embedding | ✅ done → npm `0.2.0` |
| **M4** | OPFS-backed persistence (survives reloads) | 🚧 finishing → npm `0.2.0` |
| **M5** | `ferrovec` on npm — the three-line browser API | 🚧 → npm `0.2.0` |
| **M6** | Cross-tab leader election (Web Locks) | ⏭ next → npm `0.3.0` |

## Design notes

- **Why hand-rolled?** No mature Rust HNSW crate compiles cleanly to `wasm32-unknown-unknown` — they hard-depend on `rayon`, `mmap-rs`, or `num_cpus`. Owning the graph keeps the dependency tree tiny and the WASM artifact small.
- **Determinism.** The build is reproducible from `Config::seed`; there is no `getrandom` in the dependency tree.
- **Tombstones & compaction.** `remove` marks a node deleted and excludes it from results while keeping it for graph connectivity, so heavy churn grows memory over time. `compact` (added in `0.2.0`) rebuilds the index in place from the live vectors only — deterministically, by rewinding the PRNG to `Config::seed` — reclaiming the space held by tombstoned nodes. `clear` resets the index to empty while keeping its dimensionality and config.

## License

MIT © singhpratech
