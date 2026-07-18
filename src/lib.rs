// `unsafe` is denied crate-wide; the sole exception is the wasm SIMD128 kernel
// in `simd::simd128`, which carries a scoped `#[allow(unsafe_code)]` and safety
// comments. All native, non-SIMD code stays unsafe-free.
#![deny(unsafe_code)]
#![doc = include_str!("../README.md")]

mod config;
mod error;
mod hnsw;
mod simd;

#[cfg(target_arch = "wasm32")]
mod wasm_api;

pub use config::{Config, Metric};
pub use error::Error;
pub use hnsw::{Hnsw, Neighbor};

#[cfg(target_arch = "wasm32")]
pub use wasm_api::FerrovecCore;
