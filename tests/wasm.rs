//! End-to-end wasm test: drives `FerrovecCore` through the wasm-bindgen
//! boundary and validates that `search` (which uses the SIMD128 distance
//! kernel under `wasm32 + simd128`) returns the same nearest id as a scalar
//! brute-force computed here in the test.
//!
//! Compiled only for `wasm32`; on native targets the whole file is `cfg`-ed out
//! to an empty crate, so `cargo test` (native) ignores it.
#![cfg(target_arch = "wasm32")]

use ferrovec::FerrovecCore;
use wasm_bindgen_test::*;

/// Scalar reference cosine distance (mirrors the crate's default metric).
fn cosine_distance(a: &[f32], b: &[f32]) -> f32 {
    let dot: f32 = a.iter().zip(b).map(|(x, y)| x * y).sum();
    let na: f32 = a.iter().map(|x| x * x).sum::<f32>().sqrt();
    let nb: f32 = b.iter().map(|x| x * x).sum::<f32>().sqrt();
    if na == 0.0 || nb == 0.0 {
        1.0
    } else {
        1.0 - dot / (na * nb)
    }
}

fn brute_force_nearest(data: &[(&str, Vec<f32>)], query: &[f32]) -> String {
    let mut best_id = String::new();
    let mut best = f32::INFINITY;
    for (id, v) in data {
        let d = cosine_distance(query, v);
        if d < best {
            best = d;
            best_id = (*id).to_string();
        }
    }
    best_id
}

/// A hit parsed back out of the JS value returned by `search`.
#[derive(serde::Deserialize)]
struct Hit {
    id: String,
    #[allow(dead_code)]
    distance: f32,
}

#[wasm_bindgen_test]
fn search_matches_scalar_brute_force() {
    // 8-dim vectors so the SIMD path runs two full f32x4 chunks (no remainder).
    let data: Vec<(&str, Vec<f32>)> = vec![
        ("a", vec![1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]),
        ("b", vec![0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]),
        ("c", vec![0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0]),
        ("d", vec![0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]),
        ("e", vec![0.9, 0.1, 0.05, 0.0, 0.0, 0.0, 0.0, 0.0]),
        ("f", vec![-0.5, -0.4, 0.2, 0.1, 0.3, 0.0, 0.6, 0.2]),
    ];

    let mut idx = FerrovecCore::new(8);
    for (id, v) in &data {
        idx.insert((*id).to_string(), v).unwrap();
    }
    assert_eq!(idx.len(), data.len());
    assert!(!idx.is_empty());
    assert_eq!(idx.dims(), 8);

    // Query closest to "e".
    let query = vec![0.95, 0.08, 0.02, 0.0, 0.0, 0.0, 0.0, 0.0];

    let js = idx.search(&query, 1).unwrap();
    let hits: Vec<Hit> = serde_wasm_bindgen::from_value(js).unwrap();
    assert_eq!(hits.len(), 1);

    let expected = brute_force_nearest(&data, &query);
    assert_eq!(hits[0].id, expected, "SIMD search disagreed with scalar brute force");

    // Round-trip through to_bytes / from_bytes preserves results.
    let bytes = idx.to_bytes().unwrap();
    let restored = FerrovecCore::from_bytes(&bytes).unwrap();
    let js2 = restored.search(&query, 1).unwrap();
    let hits2: Vec<Hit> = serde_wasm_bindgen::from_value(js2).unwrap();
    assert_eq!(hits2[0].id, expected);

    // remove works.
    assert!(idx.remove("e"));
    assert_eq!(idx.len(), data.len() - 1);
}
