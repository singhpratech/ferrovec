use serde::{Deserialize, Serialize};

/// Distance metric used to compare vectors.
///
/// All metrics are expressed so that **smaller means closer**.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Default)]
pub enum Metric {
    /// Cosine distance: `1 - cos(a, b)`. Zero-norm vectors yield `1.0`.
    #[default]
    Cosine,
    /// Dot-product distance: `1 - dot(a, b)`.
    Dot,
    /// Squared Euclidean (L2) distance.
    L2,
}

/// Tunable parameters controlling index construction and search.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Config {
    /// Maximum number of connections (`M`) per node per layer.
    ///
    /// Layer 0 is allowed up to `2 * max_connections`.
    pub max_connections: usize,
    /// Size of the dynamic candidate list used while inserting.
    pub ef_construction: usize,
    /// Size of the dynamic candidate list used while searching.
    pub ef_search: usize,
    /// Distance metric.
    pub metric: Metric,
    /// Seed for the deterministic internal PRNG (splitmix64).
    pub seed: u64,
}

impl Default for Config {
    fn default() -> Self {
        Config {
            max_connections: 16,
            ef_construction: 200,
            ef_search: 50,
            metric: Metric::Cosine,
            seed: 0x9E37_79B9_7F4A_7C15,
        }
    }
}
