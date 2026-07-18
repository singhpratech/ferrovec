//! WebAssembly boundary for ferrovec.
//!
//! Compiled **only** for `wasm32` (see the `#[cfg(target_arch = "wasm32")]`
//! gate in `lib.rs`). Exposes [`FerrovecCore`], a `#[wasm_bindgen]` class that
//! wraps the pure-Rust [`Hnsw`] index for use from JavaScript. None of this is
//! visible to native builds, so the published crate never depends on
//! `wasm-bindgen`.

use wasm_bindgen::prelude::*;

use crate::config::{Config, Metric};
use crate::hnsw::{Hnsw, Neighbor};
use crate::Error;

/// A single search hit as handed back to JavaScript: `{ id, distance }`.
///
/// This lives here (rather than deriving `Serialize` on the public
/// [`Neighbor`]) so M1's public Rust API is left completely untouched.
#[derive(serde::Serialize)]
struct Hit {
    id: String,
    distance: f32,
}

impl From<Neighbor> for Hit {
    fn from(n: Neighbor) -> Self {
        Hit {
            id: n.id,
            distance: n.distance,
        }
    }
}

/// Map a JS metric string to the internal [`Metric`] enum.
fn metric_from_str(s: &str) -> Result<Metric, JsValue> {
    match s.to_ascii_lowercase().as_str() {
        "cosine" => Ok(Metric::Cosine),
        "dot" => Ok(Metric::Dot),
        "l2" | "euclidean" => Ok(Metric::L2),
        other => Err(JsValue::from_str(&format!(
            "unknown metric {other:?} (expected \"cosine\", \"dot\", or \"l2\")"
        ))),
    }
}

/// Convert a crate [`Error`] into a JS `Error` object with a readable message.
fn err_to_js(e: Error) -> JsValue {
    js_sys::Error::new(&e.to_string()).into()
}

/// JavaScript-facing HNSW vector index.
///
/// Thin wrapper over the pure-Rust [`Hnsw`]. All heavy lifting (graph
/// construction, SIMD distances, (de)serialization) happens in the core; this
/// type only marshals values across the wasm boundary.
#[wasm_bindgen]
pub struct FerrovecCore {
    inner: Hnsw,
}

#[wasm_bindgen]
impl FerrovecCore {
    /// Create an index for `dims`-dimensional vectors using the default config
    /// (cosine metric, `M = 16`, `ef_construction = 200`, `ef_search = 50`).
    #[wasm_bindgen(constructor)]
    pub fn new(dims: usize) -> FerrovecCore {
        console_error_panic_hook::set_once();
        FerrovecCore {
            inner: Hnsw::new(dims),
        }
    }

    /// Create an index with explicit tuning parameters.
    ///
    /// - `metric` is one of `"cosine"`, `"dot"`, `"l2"` (case-insensitive;
    ///   `"euclidean"` is accepted as an alias for `"l2"`).
    /// - `seed` is a JS number whose raw IEEE-754 bit pattern (`f64::to_bits`)
    ///   becomes the `u64` seed for the deterministic internal PRNG. This side-
    ///   steps JS's lack of a native `u64`: any JS number maps deterministically
    ///   to a seed, and passing the same number always yields the same index.
    #[wasm_bindgen(js_name = withConfig)]
    pub fn with_config(
        dims: usize,
        max_connections: usize,
        ef_construction: usize,
        ef_search: usize,
        metric: &str,
        seed: f64,
    ) -> Result<FerrovecCore, JsValue> {
        console_error_panic_hook::set_once();
        let metric = metric_from_str(metric)?;
        let config = Config {
            max_connections,
            ef_construction,
            ef_search,
            metric,
            seed: seed.to_bits(),
        };
        Ok(FerrovecCore {
            inner: Hnsw::with_config(dims, config),
        })
    }

    /// Insert (or upsert) `vector` under `id`. `vector` is a JS `Float32Array`.
    ///
    /// Rejects (throws) with a dimension-mismatch error if
    /// `vector.length != dims`.
    pub fn insert(&mut self, id: String, vector: &[f32]) -> Result<(), JsValue> {
        self.inner.insert(id, vector).map_err(err_to_js)
    }

    /// Search for the `k` nearest neighbours of `query`.
    ///
    /// Returns a JS array of plain objects `[{ id, distance }, ...]`, sorted
    /// nearest-first. Throws on a dimension mismatch.
    pub fn search(&self, query: &[f32], k: usize) -> Result<JsValue, JsValue> {
        let hits: Vec<Hit> = self
            .inner
            .search(query, k)
            .map_err(err_to_js)?
            .into_iter()
            .map(Hit::from)
            .collect();
        serde_wasm_bindgen::to_value(&hits).map_err(|e| JsValue::from_str(&e.to_string()))
    }

    /// Tombstone the vector stored under `id`. Returns `true` if a live entry
    /// existed and was removed.
    pub fn remove(&mut self, id: &str) -> bool {
        self.inner.remove(id)
    }

    /// Whether a live vector is stored under `id`.
    pub fn contains(&self, id: &str) -> bool {
        self.inner.contains(id)
    }

    /// Rebuild the index in place, dropping all tombstoned nodes and reclaiming
    /// the memory they held. `len` is unchanged and live search results stay
    /// correct; the internal storage shrinks to exactly the live set.
    pub fn compact(&mut self) {
        self.inner.compact();
    }

    /// Reset the index to empty, keeping the dimensionality and configuration.
    pub fn clear(&mut self) {
        self.inner.clear();
    }

    /// Number of live (non-tombstoned) vectors in the index.
    #[wasm_bindgen(js_name = len)]
    pub fn len(&self) -> usize {
        self.inner.len()
    }

    /// Whether the index has no live vectors.
    #[wasm_bindgen(js_name = isEmpty)]
    pub fn is_empty(&self) -> bool {
        self.inner.is_empty()
    }

    /// Dimensionality this index was created with.
    pub fn dims(&self) -> usize {
        self.inner.dims()
    }

    /// Serialize the whole index to bytes (a JS `Uint8Array`).
    #[wasm_bindgen(js_name = toBytes)]
    pub fn to_bytes(&self) -> Result<Vec<u8>, JsValue> {
        self.inner.to_bytes().map_err(err_to_js)
    }

    /// Rebuild an index from bytes produced by [`to_bytes`](Self::to_bytes).
    #[wasm_bindgen(js_name = fromBytes)]
    pub fn from_bytes(data: &[u8]) -> Result<FerrovecCore, JsValue> {
        Hnsw::from_bytes(data)
            .map(|inner| FerrovecCore { inner })
            .map_err(err_to_js)
    }
}
