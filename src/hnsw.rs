use std::cmp::{Ordering, Reverse};
use std::collections::{BinaryHeap, HashMap, HashSet};

use serde::{Deserialize, Serialize};

use crate::config::{Config, Metric};
use crate::error::Error;

/// Magic bytes prepended to every serialized index.
const MAGIC: &[u8; 4] = b"FVEC";
/// On-disk serialization format version.
const FORMAT_VERSION: u32 = 1;
/// Maximum layer a node can be assigned.
const MAX_LEVEL: usize = 32;

/// A single search result: an id and its distance to the query.
///
/// Distances follow the "smaller is closer" convention of the index metric.
#[derive(Clone, Debug, PartialEq)]
pub struct Neighbor {
    /// The user-supplied id of the matched vector.
    pub id: String,
    /// Distance from the query to this vector under the index metric.
    pub distance: f32,
}

/// A graph node. Tombstoned (`deleted`) nodes remain in the graph for
/// connectivity but are filtered out of search results.
#[derive(Serialize, Deserialize, Clone, Debug)]
struct Node {
    id: String,
    /// `layers[l]` holds neighbor node-indices at layer `l`.
    /// The node's top layer is `layers.len() - 1`.
    layers: Vec<Vec<u32>>,
    deleted: bool,
}

/// Internal candidate used inside the priority queues.
#[derive(Clone, Copy, Debug)]
struct Candidate {
    dist: f32,
    node: u32,
}

impl PartialEq for Candidate {
    fn eq(&self, other: &Self) -> bool {
        self.node == other.node && self.dist.total_cmp(&other.dist) == Ordering::Equal
    }
}
impl Eq for Candidate {}
impl Ord for Candidate {
    fn cmp(&self, other: &Self) -> Ordering {
        self.dist
            .total_cmp(&other.dist)
            .then_with(|| self.node.cmp(&other.node))
    }
}
impl PartialOrd for Candidate {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

/// A hand-rolled HNSW (Hierarchical Navigable Small World) vector index.
///
/// The index supports upsert-style [`insert`](Hnsw::insert), tombstoning
/// [`remove`](Hnsw::remove), approximate nearest-neighbor
/// [`search`](Hnsw::search), and byte (de)serialization via
/// [`to_bytes`](Hnsw::to_bytes) / [`from_bytes`](Hnsw::from_bytes).
#[derive(Serialize, Deserialize, Clone)]
pub struct Hnsw {
    dims: usize,
    config: Config,
    nodes: Vec<Node>,
    /// Flat vector store: node `i` occupies `[i*dims .. (i+1)*dims]`.
    vectors: Vec<f32>,
    entry_point: Option<u32>,
    max_layer: usize,
    /// Rebuilt after deserialization; never persisted.
    #[serde(skip)]
    id_map: HashMap<String, u32>,
    live_count: usize,
    rng_state: u64,
    /// Level-generation multiplier `1 / ln(max_connections)`; never persisted.
    #[serde(skip)]
    m_l: f64,
}

impl Hnsw {
    /// Create a new index for `dims`-dimensional vectors using the default
    /// [`Config`].
    pub fn new(dims: usize) -> Self {
        Self::with_config(dims, Config::default())
    }

    /// Create a new index for `dims`-dimensional vectors with an explicit
    /// [`Config`].
    pub fn with_config(dims: usize, config: Config) -> Self {
        let m_l = compute_m_l(config.max_connections);
        let rng_state = config.seed;
        Hnsw {
            dims,
            config,
            nodes: Vec::new(),
            vectors: Vec::new(),
            entry_point: None,
            max_layer: 0,
            id_map: HashMap::new(),
            live_count: 0,
            rng_state,
            m_l,
        }
    }

    /// Number of live (non-tombstoned) vectors in the index.
    pub fn len(&self) -> usize {
        self.live_count
    }

    /// Returns `true` if there are no live vectors.
    pub fn is_empty(&self) -> bool {
        self.live_count == 0
    }

    /// Dimensionality this index was created with.
    pub fn dims(&self) -> usize {
        self.dims
    }

    /// The active configuration.
    pub fn config(&self) -> &Config {
        &self.config
    }

    // --- PRNG (deterministic splitmix64) -----------------------------------

    fn next_u64(&mut self) -> u64 {
        self.rng_state = self.rng_state.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.rng_state;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    fn next_f64(&mut self) -> f64 {
        (self.next_u64() >> 11) as f64 / (1u64 << 53) as f64
    }

    fn random_level(&mut self) -> usize {
        let r = self.next_f64().max(f64::MIN_POSITIVE);
        let lvl = (-r.ln() * self.m_l).floor();
        if lvl <= 0.0 {
            0
        } else if lvl as usize > MAX_LEVEL {
            MAX_LEVEL
        } else {
            lvl as usize
        }
    }

    // --- Distance helpers --------------------------------------------------

    #[inline]
    fn vector(&self, i: u32) -> &[f32] {
        let start = i as usize * self.dims;
        &self.vectors[start..start + self.dims]
    }

    fn distance(&self, a: &[f32], b: &[f32]) -> f32 {
        use crate::simd::{dot, l2_sq};
        match self.config.metric {
            Metric::Dot => 1.0 - dot(a, b),
            Metric::Cosine => {
                let d = dot(a, b);
                let na = dot(a, a).sqrt();
                let nb = dot(b, b).sqrt();
                if na == 0.0 || nb == 0.0 {
                    1.0
                } else {
                    1.0 - d / (na * nb)
                }
            }
            Metric::L2 => l2_sq(a, b),
        }
    }

    #[inline]
    fn dist_query(&self, query: &[f32], node: u32) -> f32 {
        self.distance(query, self.vector(node))
    }

    #[inline]
    fn dist_nodes(&self, a: u32, b: u32) -> f32 {
        self.distance(self.vector(a), self.vector(b))
    }

    // --- Core HNSW routines ------------------------------------------------

    /// Standard HNSW SEARCH-LAYER. Returns up to `ef` nearest candidates found
    /// on `layer`, reachable from `entry_points`.
    fn search_layer(
        &self,
        query: &[f32],
        entry_points: &[u32],
        ef: usize,
        layer: usize,
    ) -> Vec<Candidate> {
        let mut visited: HashSet<u32> = HashSet::with_capacity(entry_points.len() * 8);
        // Min-heap of candidates still to expand (nearest first).
        let mut candidates: BinaryHeap<Reverse<Candidate>> = BinaryHeap::new();
        // Max-heap of best results found so far (farthest first), capped at ef.
        let mut results: BinaryHeap<Candidate> = BinaryHeap::new();

        for &ep in entry_points {
            if visited.insert(ep) {
                let d = self.dist_query(query, ep);
                let c = Candidate { dist: d, node: ep };
                candidates.push(Reverse(c));
                results.push(c);
            }
        }
        while results.len() > ef {
            results.pop();
        }

        while let Some(Reverse(current)) = candidates.pop() {
            if let Some(farthest) = results.peek() {
                if results.len() >= ef && current.dist > farthest.dist {
                    break;
                }
            }

            let neighbors = {
                let node = &self.nodes[current.node as usize];
                if layer < node.layers.len() {
                    node.layers[layer].clone()
                } else {
                    Vec::new()
                }
            };

            for nb in neighbors {
                if visited.insert(nb) {
                    let d = self.dist_query(query, nb);
                    let admit = results.len() < ef
                        || results.peek().is_none_or(|far| d < far.dist);
                    if admit {
                        let c = Candidate { dist: d, node: nb };
                        candidates.push(Reverse(c));
                        results.push(c);
                        while results.len() > ef {
                            results.pop();
                        }
                    }
                }
            }
        }

        results.into_vec()
    }

    /// HNSW neighbor-selection heuristic. Keeps a candidate `e` only if it is
    /// closer to `base` than to every already-selected neighbor. Returns at
    /// most `m` node indices.
    fn select_neighbors(&self, base: u32, candidate_nodes: &[u32], m: usize) -> Vec<u32> {
        let mut cands: Vec<Candidate> = Vec::with_capacity(candidate_nodes.len());
        let mut seen: HashSet<u32> = HashSet::with_capacity(candidate_nodes.len());
        for &n in candidate_nodes {
            if n == base || !seen.insert(n) {
                continue;
            }
            cands.push(Candidate {
                dist: self.dist_nodes(base, n),
                node: n,
            });
        }
        cands.sort_unstable();

        let mut selected: Vec<u32> = Vec::with_capacity(m);
        for c in cands {
            if selected.len() >= m {
                break;
            }
            let mut keep = true;
            for &r in &selected {
                // Reject e if it is closer to an already-kept r than to base.
                if self.dist_nodes(c.node, r) < c.dist {
                    keep = false;
                    break;
                }
            }
            if keep {
                selected.push(c.node);
            }
        }
        selected
    }

    // --- Public mutation / query ------------------------------------------

    /// Insert (or upsert) a vector under `id`.
    ///
    /// If `id` is already present, the existing node is tombstoned and a fresh
    /// node is inserted, so only one live entry per id ever remains.
    ///
    /// # Errors
    /// Returns [`Error::DimensionMismatch`] if `vector.len() != self.dims()`.
    pub fn insert(&mut self, id: impl Into<String>, vector: &[f32]) -> Result<(), Error> {
        let id: String = id.into();
        if vector.len() != self.dims {
            return Err(Error::DimensionMismatch {
                expected: self.dims,
                got: vector.len(),
            });
        }

        // Upsert: tombstone any existing live node with this id.
        if let Some(&old) = self.id_map.get(&id) {
            let node = &mut self.nodes[old as usize];
            if !node.deleted {
                node.deleted = true;
                self.live_count -= 1;
            }
            self.id_map.remove(&id);
        }

        let new_idx = self.nodes.len() as u32;
        self.vectors.extend_from_slice(vector);
        let level = self.random_level();
        self.nodes.push(Node {
            id: id.clone(),
            layers: vec![Vec::new(); level + 1],
            deleted: false,
        });
        self.id_map.insert(id, new_idx);
        self.live_count += 1;

        // First node ever: becomes the entry point.
        let entry = match self.entry_point {
            Some(e) => e,
            None => {
                self.entry_point = Some(new_idx);
                self.max_layer = level;
                return Ok(());
            }
        };

        let max_layer = self.max_layer;
        let mut ep = entry;

        // Phase 1: descend from the top down to just above the new node's level,
        // greedily following the single nearest neighbor.
        let mut lc = max_layer;
        while lc > level {
            let found = self.search_layer(vector, &[ep], 1, lc);
            if let Some(nearest) = found.iter().min_by(|a, b| a.cmp(b)) {
                ep = nearest.node;
            }
            lc -= 1;
        }

        // Phase 2: from min(max_layer, level) down to 0, connect the new node.
        let mut entry_points = vec![ep];
        let mut lc = max_layer.min(level) as isize;
        while lc >= 0 {
            let layer = lc as usize;
            let found = self.search_layer(vector, &entry_points, self.config.ef_construction, layer);
            let cand_nodes: Vec<u32> = found.iter().map(|c| c.node).collect();
            let selected = self.select_neighbors(new_idx, &cand_nodes, self.config.max_connections);

            // Connect bidirectionally at this layer.
            for &nb in &selected {
                self.nodes[new_idx as usize].layers[layer].push(nb);
                self.nodes[nb as usize].layers[layer].push(new_idx);
            }

            // Prune each touched neighbor back down to its cap.
            let cap = if layer == 0 {
                2 * self.config.max_connections
            } else {
                self.config.max_connections
            };
            for &nb in &selected {
                let current = self.nodes[nb as usize].layers[layer].clone();
                if current.len() > cap {
                    let pruned = self.select_neighbors(nb, &current, cap);
                    self.nodes[nb as usize].layers[layer] = pruned;
                }
            }

            // Carry the found candidates down as entry points for the next layer.
            entry_points = if cand_nodes.is_empty() {
                vec![ep]
            } else {
                cand_nodes
            };
            lc -= 1;
        }

        // Grow the graph height if this node reached a new top level.
        if level > self.max_layer {
            self.max_layer = level;
            self.entry_point = Some(new_idx);
        }

        Ok(())
    }

    /// Tombstone the vector stored under `id`.
    ///
    /// Returns `true` if a live entry existed and was removed, `false`
    /// otherwise. The node stays in the graph for connectivity but is excluded
    /// from future search results.
    pub fn remove(&mut self, id: &str) -> bool {
        if let Some(&idx) = self.id_map.get(id) {
            let node = &mut self.nodes[idx as usize];
            if !node.deleted {
                node.deleted = true;
                self.live_count -= 1;
            }
            self.id_map.remove(id);
            true
        } else {
            false
        }
    }

    /// Returns `true` if a live vector is stored under `id`.
    ///
    /// Tombstoned (removed or upserted-over) ids report `false`.
    pub fn contains(&self, id: &str) -> bool {
        self.id_map.contains_key(id)
    }

    /// Reset the index to empty, keeping [`dims`](Hnsw::dims) and the active
    /// [`Config`].
    ///
    /// All nodes and vectors are dropped, the entry point is cleared, and the
    /// internal PRNG is rewound to `config.seed` so a subsequent rebuild is
    /// deterministic. After `clear`, [`len`](Hnsw::len) is `0` and the index can
    /// be inserted into again.
    pub fn clear(&mut self) {
        self.nodes.clear();
        self.vectors.clear();
        self.entry_point = None;
        self.max_layer = 0;
        self.id_map.clear();
        self.live_count = 0;
        self.rng_state = self.config.seed;
    }

    /// Rebuild the index in place, dropping all tombstoned nodes.
    ///
    /// [`remove`](Hnsw::remove) and upserting [`insert`](Hnsw::insert) only
    /// tombstone the old node; it lingers in the graph and vector store to
    /// preserve connectivity, so memory grows under churn. `compact` reclaims
    /// that space: it collects every live vector (in insertion order), resets
    /// the graph, and re-inserts each one through the normal build path.
    ///
    /// The PRNG is rewound to `config.seed` first, so compacting is
    /// deterministic and yields the same graph a fresh build of the surviving
    /// vectors (inserted in the same order) would. [`len`](Hnsw::len) is
    /// unchanged, previously-removed ids stay gone, and search results for live
    /// data remain correct — while the internal node and vector counts drop to
    /// exactly the live set.
    pub fn compact(&mut self) {
        // Snapshot the live set in insertion order before tearing down state.
        let mut live: Vec<(String, Vec<f32>)> = Vec::with_capacity(self.live_count);
        for i in 0..self.nodes.len() {
            if !self.nodes[i].deleted {
                let id = self.nodes[i].id.clone();
                let v = self.vector(i as u32).to_vec();
                live.push((id, v));
            }
        }

        self.clear();

        for (id, v) in live {
            // Re-inserting an already-accepted vector cannot fail: dimensions
            // are unchanged and each live id is unique.
            debug_assert_eq!(v.len(), self.dims);
            let _ = self.insert(id, &v);
        }
    }

    /// Search for the `k` nearest neighbors of `query`.
    ///
    /// Results are sorted ascending by distance (nearest first), exclude
    /// tombstoned nodes, and contain at most `k` entries.
    ///
    /// # Errors
    /// Returns [`Error::DimensionMismatch`] if `query.len() != self.dims()`.
    pub fn search(&self, query: &[f32], k: usize) -> Result<Vec<Neighbor>, Error> {
        if query.len() != self.dims {
            return Err(Error::DimensionMismatch {
                expected: self.dims,
                got: query.len(),
            });
        }
        if k == 0 {
            return Ok(Vec::new());
        }
        let mut ep = match self.entry_point {
            Some(e) => e,
            None => return Ok(Vec::new()),
        };

        // Greedy descent through the upper layers.
        let mut lc = self.max_layer;
        while lc >= 1 {
            let found = self.search_layer(query, &[ep], 1, lc);
            if let Some(nearest) = found.iter().min_by(|a, b| a.cmp(b)) {
                ep = nearest.node;
            }
            lc -= 1;
        }

        let ef = self.config.ef_search.max(k);
        let found = self.search_layer(query, &[ep], ef, 0);

        let mut cands: Vec<Candidate> = found
            .into_iter()
            .filter(|c| !self.nodes[c.node as usize].deleted)
            .collect();
        cands.sort_unstable();
        cands.truncate(k);

        Ok(cands
            .into_iter()
            .map(|c| Neighbor {
                id: self.nodes[c.node as usize].id.clone(),
                distance: c.dist,
            })
            .collect())
    }

    // --- Serialization -----------------------------------------------------

    /// Serialize the index to bytes: an 8-byte header (`b"FVEC"` + LE format
    /// version) followed by the postcard-encoded payload.
    pub fn to_bytes(&self) -> Result<Vec<u8>, Error> {
        let payload: Vec<u8> =
            postcard::to_allocvec(self).map_err(|e| Error::Serialize(e.to_string()))?;
        let mut out = Vec::with_capacity(8 + payload.len());
        out.extend_from_slice(MAGIC);
        out.extend_from_slice(&FORMAT_VERSION.to_le_bytes());
        out.extend_from_slice(&payload);
        Ok(out)
    }

    /// Deserialize an index previously produced by [`to_bytes`](Hnsw::to_bytes).
    ///
    /// Validates the magic header and format version, then rebuilds the derived
    /// `id_map` and `m_l` fields.
    ///
    /// # Errors
    /// - [`Error::BadFormat`] if the blob is too short or has a bad magic.
    /// - [`Error::VersionMismatch`] if the format version is unsupported.
    /// - [`Error::Deserialize`] if the payload fails to decode.
    pub fn from_bytes(data: &[u8]) -> Result<Self, Error> {
        if data.len() < 8 || &data[0..4] != MAGIC {
            return Err(Error::BadFormat);
        }
        let version = u32::from_le_bytes([data[4], data[5], data[6], data[7]]);
        if version != FORMAT_VERSION {
            return Err(Error::VersionMismatch(version));
        }

        let mut index: Hnsw =
            postcard::from_bytes(&data[8..]).map_err(|e| Error::Deserialize(e.to_string()))?;

        // Rebuild derived, non-persisted state.
        index.id_map = HashMap::with_capacity(index.nodes.len());
        for (i, node) in index.nodes.iter().enumerate() {
            if !node.deleted {
                index.id_map.insert(node.id.clone(), i as u32);
            }
        }
        index.m_l = compute_m_l(index.config.max_connections);

        Ok(index)
    }
}

/// Level-generation multiplier `1 / ln(max_connections)`, guarded so a
/// `max_connections` of 0 or 1 does not produce a non-finite result.
fn compute_m_l(max_connections: usize) -> f64 {
    if max_connections <= 1 {
        1.0
    } else {
        1.0 / (max_connections as f64).ln()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splitmix_is_deterministic() {
        let mut a = Hnsw::new(4);
        let mut b = Hnsw::new(4);
        for _ in 0..100 {
            assert_eq!(a.next_u64(), b.next_u64());
        }
    }

    #[test]
    fn next_f64_in_unit_interval() {
        let mut h = Hnsw::new(4);
        for _ in 0..10_000 {
            let r = h.next_f64();
            assert!((0.0..1.0).contains(&r));
        }
    }

    #[test]
    fn random_level_is_capped() {
        let mut h = Hnsw::new(4);
        for _ in 0..100_000 {
            assert!(h.random_level() <= MAX_LEVEL);
        }
    }

    #[test]
    fn dot_distance_zero_for_identical_unit() {
        let h = Hnsw::with_config(
            3,
            Config {
                metric: Metric::Dot,
                ..Config::default()
            },
        );
        let v = [1.0, 0.0, 0.0];
        assert!((h.distance(&v, &v) - 0.0).abs() < 1e-6);
    }

    #[test]
    fn cosine_guards_zero_norm() {
        let h = Hnsw::with_config(
            3,
            Config {
                metric: Metric::Cosine,
                ..Config::default()
            },
        );
        let zero = [0.0, 0.0, 0.0];
        let v = [1.0, 2.0, 3.0];
        assert_eq!(h.distance(&zero, &v), 1.0);
        assert_eq!(h.distance(&zero, &zero), 1.0);
    }

    #[test]
    fn l2_is_squared_euclidean() {
        let h = Hnsw::with_config(
            2,
            Config {
                metric: Metric::L2,
                ..Config::default()
            },
        );
        let a = [0.0, 0.0];
        let b = [3.0, 4.0];
        assert!((h.distance(&a, &b) - 25.0).abs() < 1e-6);
    }
}
