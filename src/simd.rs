//! Distance kernels.
//!
//! The scalar functions ([`dot_scalar`], [`l2_sq_scalar`]) are the **reference
//! implementations** and are always available on every target. On
//! `wasm32 + simd128` the public [`dot`] / [`l2_sq`] dispatch to a hand-written
//! SIMD128 path ([`simd128`]); on every other target they forward straight to
//! the scalar reference.
//!
//! The SIMD path accumulates in four independent lanes and then folds them,
//! which under IEEE-754 can differ from the strictly left-to-right scalar sum
//! by a few ULPs. It does not change the ordering of nearest neighbours — the
//! wasm integration test asserts `search` returns the same nearest id as a
//! scalar brute-force computed alongside it.

/// Scalar dot product — the correctness reference.
///
/// Used directly as the dispatch target on every non-SIMD target; on
/// `wasm32 + simd128` the SIMD kernel takes over, so it is dead there but kept
/// as the documented reference.
#[cfg_attr(all(target_arch = "wasm32", target_feature = "simd128"), allow(dead_code))]
#[inline]
pub(crate) fn dot_scalar(a: &[f32], b: &[f32]) -> f32 {
    let mut sum = 0.0f32;
    for (x, y) in a.iter().zip(b.iter()) {
        sum += x * y;
    }
    sum
}

/// Scalar squared-L2 distance — the correctness reference.
///
/// See [`dot_scalar`] on why this is `dead_code`-allowed under `wasm32 + simd128`.
#[cfg_attr(all(target_arch = "wasm32", target_feature = "simd128"), allow(dead_code))]
#[inline]
pub(crate) fn l2_sq_scalar(a: &[f32], b: &[f32]) -> f32 {
    let mut sum = 0.0f32;
    for (x, y) in a.iter().zip(b.iter()) {
        let diff = x - y;
        sum += diff * diff;
    }
    sum
}

// --- Public dispatch ------------------------------------------------------

/// Dot product. SIMD128-accelerated on `wasm32 + simd128`, scalar elsewhere.
#[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
#[inline]
pub(crate) fn dot(a: &[f32], b: &[f32]) -> f32 {
    simd128::dot(a, b)
}

/// Dot product (scalar reference path).
#[cfg(not(all(target_arch = "wasm32", target_feature = "simd128")))]
#[inline]
pub(crate) fn dot(a: &[f32], b: &[f32]) -> f32 {
    dot_scalar(a, b)
}

/// Squared-L2 distance. SIMD128-accelerated on `wasm32 + simd128`, scalar elsewhere.
#[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
#[inline]
pub(crate) fn l2_sq(a: &[f32], b: &[f32]) -> f32 {
    simd128::l2_sq(a, b)
}

/// Squared-L2 distance (scalar reference path).
#[cfg(not(all(target_arch = "wasm32", target_feature = "simd128")))]
#[inline]
pub(crate) fn l2_sq(a: &[f32], b: &[f32]) -> f32 {
    l2_sq_scalar(a, b)
}

// --- SIMD128 kernel -------------------------------------------------------
//
// This is the only module in the crate permitted to use `unsafe`, and only for
// the wasm `v128_load` intrinsic. Native, non-SIMD code stays unsafe-free
// (`#![deny(unsafe_code)]` at the crate root). Everything here is gated to
// `wasm32 + simd128` and never compiled for native targets.
#[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
#[allow(unsafe_code)]
mod simd128 {
    use core::arch::wasm32::*;

    /// SIMD128 dot product. Functionally equivalent to
    /// [`super::dot_scalar`]; see the module docs on lane-wise summation.
    #[inline]
    pub(crate) fn dot(a: &[f32], b: &[f32]) -> f32 {
        debug_assert_eq!(a.len(), b.len());
        let n = a.len();
        let chunks = n / 4;
        let mut acc = f32x4_splat(0.0);
        for i in 0..chunks {
            let off = i * 4;
            // SAFETY: `off + 4 <= n` for every `i < n / 4`, and both slices have
            // length `n`, so each 16-byte (4 × f32) load reads only in-bounds
            // elements. wasm `v128_load` permits unaligned loads.
            let va = unsafe { v128_load(a.as_ptr().add(off) as *const v128) };
            let vb = unsafe { v128_load(b.as_ptr().add(off) as *const v128) };
            acc = f32x4_add(acc, f32x4_mul(va, vb));
        }
        let mut sum = f32x4_extract_lane::<0>(acc)
            + f32x4_extract_lane::<1>(acc)
            + f32x4_extract_lane::<2>(acc)
            + f32x4_extract_lane::<3>(acc);
        for i in (chunks * 4)..n {
            sum += a[i] * b[i];
        }
        sum
    }

    /// SIMD128 squared-L2 distance. Functionally equivalent to
    /// [`super::l2_sq_scalar`]; see the module docs on lane-wise summation.
    #[inline]
    pub(crate) fn l2_sq(a: &[f32], b: &[f32]) -> f32 {
        debug_assert_eq!(a.len(), b.len());
        let n = a.len();
        let chunks = n / 4;
        let mut acc = f32x4_splat(0.0);
        for i in 0..chunks {
            let off = i * 4;
            // SAFETY: identical bounds argument as `dot` above.
            let va = unsafe { v128_load(a.as_ptr().add(off) as *const v128) };
            let vb = unsafe { v128_load(b.as_ptr().add(off) as *const v128) };
            let diff = f32x4_sub(va, vb);
            acc = f32x4_add(acc, f32x4_mul(diff, diff));
        }
        let mut sum = f32x4_extract_lane::<0>(acc)
            + f32x4_extract_lane::<1>(acc)
            + f32x4_extract_lane::<2>(acc)
            + f32x4_extract_lane::<3>(acc);
        for i in (chunks * 4)..n {
            let d = a[i] - b[i];
            sum += d * d;
        }
        sum
    }
}
