use ferrovec::{Config, Error, Hnsw, Metric, Neighbor};

/// A local, self-contained splitmix64 for generating deterministic test data,
/// independent of the crate's internal PRNG.
struct SplitMix64(u64);
impl SplitMix64 {
    fn new(seed: u64) -> Self {
        SplitMix64(seed)
    }
    fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
    fn next_f32(&mut self) -> f32 {
        (self.next_u64() >> 40) as f32 / (1u32 << 24) as f32
    }
    fn vector(&mut self, dims: usize) -> Vec<f32> {
        (0..dims).map(|_| self.next_f32() * 2.0 - 1.0).collect()
    }
}

fn brute_force_nearest(data: &[(String, Vec<f32>)], query: &[f32], metric: Metric) -> String {
    let mut best_id = String::new();
    let mut best = f32::INFINITY;
    for (id, v) in data {
        let d = dist(query, v, metric);
        if d < best {
            best = d;
            best_id = id.clone();
        }
    }
    best_id
}

fn dist(a: &[f32], b: &[f32], metric: Metric) -> f32 {
    let dot: f32 = a.iter().zip(b).map(|(x, y)| x * y).sum();
    match metric {
        Metric::Dot => 1.0 - dot,
        Metric::Cosine => {
            let na: f32 = a.iter().map(|x| x * x).sum::<f32>().sqrt();
            let nb: f32 = b.iter().map(|x| x * x).sum::<f32>().sqrt();
            if na == 0.0 || nb == 0.0 {
                1.0
            } else {
                1.0 - dot / (na * nb)
            }
        }
        Metric::L2 => a.iter().zip(b).map(|(x, y)| (x - y) * (x - y)).sum(),
    }
}

#[test]
fn basic_insert_and_search_returns_nearest() {
    let mut index = Hnsw::new(4);
    index.insert("a", &[1.0, 0.0, 0.0, 0.0]).unwrap();
    index.insert("b", &[0.0, 1.0, 0.0, 0.0]).unwrap();
    index.insert("c", &[0.0, 0.0, 1.0, 0.0]).unwrap();

    let res = index.search(&[0.95, 0.05, 0.0, 0.0], 1).unwrap();
    assert_eq!(res.len(), 1);
    assert_eq!(res[0].id, "a");
}

#[test]
fn empty_index_returns_empty() {
    let index = Hnsw::new(8);
    assert!(index.is_empty());
    assert_eq!(index.len(), 0);
    let res = index.search(&[0.0; 8], 5).unwrap();
    assert!(res.is_empty());
}

#[test]
fn dimension_mismatch_on_insert() {
    let mut index = Hnsw::new(4);
    let err = index.insert("a", &[1.0, 2.0]).unwrap_err();
    assert_eq!(
        err,
        Error::DimensionMismatch {
            expected: 4,
            got: 2
        }
    );
}

#[test]
fn dimension_mismatch_on_search() {
    let mut index = Hnsw::new(4);
    index.insert("a", &[1.0, 0.0, 0.0, 0.0]).unwrap();
    let err = index.search(&[1.0, 0.0], 1).unwrap_err();
    assert_eq!(
        err,
        Error::DimensionMismatch {
            expected: 4,
            got: 2
        }
    );
}

#[test]
fn k_zero_returns_empty() {
    let mut index = Hnsw::new(3);
    index.insert("a", &[1.0, 2.0, 3.0]).unwrap();
    let res = index.search(&[1.0, 2.0, 3.0], 0).unwrap();
    assert!(res.is_empty());
}

#[test]
fn remove_excludes_from_results() {
    let mut index = Hnsw::new(4);
    index.insert("a", &[1.0, 0.0, 0.0, 0.0]).unwrap();
    index.insert("b", &[0.0, 1.0, 0.0, 0.0]).unwrap();
    assert_eq!(index.len(), 2);

    assert!(index.remove("a"));
    assert!(!index.remove("a")); // already removed
    assert_eq!(index.len(), 1);

    let res = index.search(&[1.0, 0.0, 0.0, 0.0], 5).unwrap();
    assert!(res.iter().all(|n| n.id != "a"));
    assert_eq!(res.len(), 1);
    assert_eq!(res[0].id, "b");
}

#[test]
fn upsert_keeps_single_live_entry_with_new_vector() {
    let mut index = Hnsw::new(3);
    index.insert("x", &[1.0, 0.0, 0.0]).unwrap();
    index.insert("x", &[0.0, 0.0, 1.0]).unwrap(); // replace
    assert_eq!(index.len(), 1);

    // Nearest to the NEW vector should be "x"; only one live "x".
    let res = index.search(&[0.0, 0.0, 1.0], 5).unwrap();
    let hits: Vec<&Neighbor> = res.iter().filter(|n| n.id == "x").collect();
    assert_eq!(hits.len(), 1);
    assert!(hits[0].distance < 1e-4);
}

#[test]
fn to_bytes_from_bytes_roundtrip_preserves_results() {
    let mut index = Hnsw::with_config(
        16,
        Config {
            seed: 12345,
            ..Config::default()
        },
    );
    let mut rng = SplitMix64::new(999);
    for i in 0..200 {
        let v = rng.vector(16);
        index.insert(format!("id{i}"), &v).unwrap();
    }
    index.remove("id5");
    index.remove("id7");

    let bytes = index.to_bytes().unwrap();
    let restored = Hnsw::from_bytes(&bytes).unwrap();
    assert_eq!(restored.len(), index.len());
    assert_eq!(restored.dims(), index.dims());

    let mut qr = SplitMix64::new(4321);
    for _ in 0..20 {
        let q = qr.vector(16);
        let a = index.search(&q, 10).unwrap();
        let b = restored.search(&q, 10).unwrap();
        assert_eq!(a, b);
    }
}

fn expect_err(res: Result<Hnsw, Error>) -> Error {
    match res {
        Ok(_) => panic!("expected an error, got Ok"),
        Err(e) => e,
    }
}

#[test]
fn from_bytes_rejects_bad_magic() {
    let err = expect_err(Hnsw::from_bytes(&[0, 1, 2, 3, 4, 5, 6, 7, 8]));
    assert_eq!(err, Error::BadFormat);
}

#[test]
fn from_bytes_rejects_short_input() {
    let err = expect_err(Hnsw::from_bytes(b"FV"));
    assert_eq!(err, Error::BadFormat);
}

#[test]
fn from_bytes_rejects_bad_version() {
    let mut index = Hnsw::new(3);
    index.insert("a", &[1.0, 2.0, 3.0]).unwrap();
    let mut bytes = index.to_bytes().unwrap();
    // Corrupt the version to 2 (LE u32 at offset 4).
    bytes[4] = 2;
    let err = expect_err(Hnsw::from_bytes(&bytes));
    assert_eq!(err, Error::VersionMismatch(2));
}

#[test]
fn config_and_defaults_are_exposed() {
    let index = Hnsw::new(10);
    let c = index.config();
    assert_eq!(c.max_connections, 16);
    assert_eq!(c.ef_construction, 200);
    assert_eq!(c.ef_search, 50);
    assert_eq!(c.metric, Metric::Cosine);
    assert_eq!(c.seed, 0x9E37_79B9_7F4A_7C15);
    assert_eq!(Metric::default(), Metric::Cosine);
}

fn recall_test(metric: Metric) -> f64 {
    let dims = 16;
    let n = 500;
    let mut index = Hnsw::with_config(
        dims,
        Config {
            metric,
            seed: 0xDEAD_BEEF,
            ..Config::default()
        },
    );
    let mut rng = SplitMix64::new(0xABCD_1234);
    let mut data: Vec<(String, Vec<f32>)> = Vec::with_capacity(n);
    for i in 0..n {
        let v = rng.vector(dims);
        let id = format!("v{i}");
        index.insert(id.clone(), &v).unwrap();
        data.push((id, v));
    }

    let mut qr = SplitMix64::new(0x5555_AAAA);
    let queries = 50;
    let mut hits = 0;
    for _ in 0..queries {
        let q = qr.vector(dims);
        let truth = brute_force_nearest(&data, &q, metric);
        let got = index.search(&q, 1).unwrap();
        if !got.is_empty() && got[0].id == truth {
            hits += 1;
        }
    }
    hits as f64 / queries as f64
}

#[test]
fn recall_cosine_is_high() {
    let recall = recall_test(Metric::Cosine);
    assert!(recall >= 0.9, "cosine top-1 recall too low: {recall}");
}

#[test]
fn recall_l2_is_high() {
    let recall = recall_test(Metric::L2);
    assert!(recall >= 0.9, "l2 top-1 recall too low: {recall}");
}

#[test]
fn compact_drops_tombstones_and_preserves_live_results() {
    let dims = 16;
    let n = 200;
    let mut index = Hnsw::with_config(
        dims,
        Config {
            seed: 0x0102_0304,
            ..Config::default()
        },
    );

    let mut rng = SplitMix64::new(0xC0FF_EE00);
    let mut vectors: Vec<(String, Vec<f32>)> = Vec::with_capacity(n);
    for i in 0..n {
        let v = rng.vector(dims);
        let id = format!("id{i}");
        index.insert(id.clone(), &v).unwrap();
        vectors.push((id, v));
    }

    // Remove every third id.
    let removed: Vec<String> = (0..n)
        .filter(|i| i % 3 == 0)
        .map(|i| format!("id{i}"))
        .collect();
    for id in &removed {
        assert!(index.remove(id));
    }
    let live_before = index.len();
    assert_eq!(live_before, n - removed.len());

    // Record the nearest live id for each surviving vector used as its own
    // query (distance ~0, so top-1 is robustly that id).
    let survivors: Vec<(String, Vec<f32>)> = vectors
        .iter()
        .filter(|(id, _)| !removed.contains(id))
        .cloned()
        .collect();
    let before: Vec<String> = survivors
        .iter()
        .map(|(_, v)| index.search(v, 1).unwrap()[0].id.clone())
        .collect();

    let size_before = index.to_bytes().unwrap().len();

    index.compact();

    // len unchanged; removed ids gone; live search results preserved.
    assert_eq!(index.len(), live_before);
    for id in &removed {
        assert!(!index.contains(id), "removed id {id} reappeared after compact");
    }
    for (id, _) in &survivors {
        assert!(index.contains(id), "live id {id} vanished after compact");
    }
    for ((_, v), expected) in survivors.iter().zip(&before) {
        let got = index.search(v, 1).unwrap();
        assert_eq!(&got[0].id, expected, "top-1 changed for a survivor after compact");
    }
    // Removed ids never surface in results.
    for id in &removed {
        let (_, v) = vectors.iter().find(|(vid, _)| vid == id).unwrap();
        let hits = index.search(v, 10).unwrap();
        assert!(hits.iter().all(|h| &h.id != id));
    }

    // Internal storage actually shrank (tombstoned vectors were reclaimed).
    let size_after = index.to_bytes().unwrap().len();
    assert!(
        size_after < size_before,
        "serialized size did not shrink: {size_before} -> {size_after}"
    );
}

#[test]
fn clear_empties_and_index_is_reusable() {
    let mut index = Hnsw::new(3);
    index.insert("a", &[1.0, 0.0, 0.0]).unwrap();
    index.insert("b", &[0.0, 1.0, 0.0]).unwrap();
    assert_eq!(index.len(), 2);

    index.clear();
    assert!(index.is_empty());
    assert_eq!(index.len(), 0);
    assert!(!index.contains("a"));
    assert!(index.search(&[1.0, 0.0, 0.0], 5).unwrap().is_empty());
    assert_eq!(index.dims(), 3);

    // Reusable after clearing.
    index.insert("c", &[0.0, 0.0, 1.0]).unwrap();
    assert_eq!(index.len(), 1);
    let res = index.search(&[0.0, 0.0, 1.0], 1).unwrap();
    assert_eq!(res[0].id, "c");
}

#[test]
fn compact_matches_fresh_build_of_survivors() {
    let dims = 16;
    let n = 300;
    let cfg = Config {
        seed: 0xBEEF_CAFE,
        ..Config::default()
    };

    // Build A: insert everything, remove a subset, then compact.
    let mut a = Hnsw::with_config(dims, cfg.clone());
    let mut rng = SplitMix64::new(0x1357_9BDF);
    let mut vectors: Vec<(String, Vec<f32>)> = Vec::with_capacity(n);
    for i in 0..n {
        let v = rng.vector(dims);
        let id = format!("id{i}");
        a.insert(id.clone(), &v).unwrap();
        vectors.push((id, v));
    }
    let removed: Vec<String> = (0..n)
        .filter(|i| i % 4 == 0)
        .map(|i| format!("id{i}"))
        .collect();
    for id in &removed {
        a.remove(id);
    }
    a.compact();

    // Build B fresh: insert only the survivors, in the original insertion order.
    let mut b = Hnsw::with_config(dims, cfg);
    for (id, v) in &vectors {
        if !removed.contains(id) {
            b.insert(id.clone(), v).unwrap();
        }
    }

    assert_eq!(a.len(), b.len());

    // Top-1 agreement across several queries (approximate-NN ordering allowed).
    let mut qr = SplitMix64::new(0x2468_ACE0);
    for _ in 0..40 {
        let q = qr.vector(dims);
        let ra = a.search(&q, 1).unwrap();
        let rb = b.search(&q, 1).unwrap();
        assert_eq!(ra[0].id, rb[0].id, "compacted index disagreed with fresh build");
    }
}

#[test]
fn results_sorted_ascending_by_distance() {
    let mut index = Hnsw::with_config(
        8,
        Config {
            metric: Metric::L2,
            ..Config::default()
        },
    );
    let mut rng = SplitMix64::new(77);
    for i in 0..100 {
        let v = rng.vector(8);
        index.insert(format!("n{i}"), &v).unwrap();
    }
    let mut qr = SplitMix64::new(88);
    let q = qr.vector(8);
    let res = index.search(&q, 10).unwrap();
    assert!(res.len() <= 10);
    for w in res.windows(2) {
        assert!(w[0].distance <= w[1].distance);
    }
}
