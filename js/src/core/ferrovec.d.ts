/* tslint:disable */
/* eslint-disable */

/**
 * JavaScript-facing HNSW vector index.
 *
 * Thin wrapper over the pure-Rust [`Hnsw`]. All heavy lifting (graph
 * construction, SIMD distances, (de)serialization) happens in the core; this
 * type only marshals values across the wasm boundary.
 */
export class FerrovecCore {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Reset the index to empty, keeping the dimensionality and configuration.
     */
    clear(): void;
    /**
     * Rebuild the index in place, dropping all tombstoned nodes and reclaiming
     * the memory they held. `len` is unchanged and live search results stay
     * correct; the internal storage shrinks to exactly the live set.
     */
    compact(): void;
    /**
     * Whether a live vector is stored under `id`.
     */
    contains(id: string): boolean;
    /**
     * Dimensionality this index was created with.
     */
    dims(): number;
    /**
     * Rebuild an index from bytes produced by [`to_bytes`](Self::to_bytes).
     */
    static fromBytes(data: Uint8Array): FerrovecCore;
    /**
     * Insert (or upsert) `vector` under `id`. `vector` is a JS `Float32Array`.
     *
     * Rejects (throws) with a dimension-mismatch error if
     * `vector.length != dims`.
     */
    insert(id: string, vector: Float32Array): void;
    /**
     * Whether the index has no live vectors.
     */
    isEmpty(): boolean;
    /**
     * Number of live (non-tombstoned) vectors in the index.
     */
    len(): number;
    /**
     * Create an index for `dims`-dimensional vectors using the default config
     * (cosine metric, `M = 16`, `ef_construction = 200`, `ef_search = 50`).
     */
    constructor(dims: number);
    /**
     * Tombstone the vector stored under `id`. Returns `true` if a live entry
     * existed and was removed.
     */
    remove(id: string): boolean;
    /**
     * Search for the `k` nearest neighbours of `query`.
     *
     * Returns a JS array of plain objects `[{ id, distance }, ...]`, sorted
     * nearest-first. Throws on a dimension mismatch.
     */
    search(query: Float32Array, k: number): any;
    /**
     * Serialize the whole index to bytes (a JS `Uint8Array`).
     */
    toBytes(): Uint8Array;
    /**
     * Create an index with explicit tuning parameters.
     *
     * - `metric` is one of `"cosine"`, `"dot"`, `"l2"` (case-insensitive;
     *   `"euclidean"` is accepted as an alias for `"l2"`).
     * - `seed` is a JS number whose raw IEEE-754 bit pattern (`f64::to_bits`)
     *   becomes the `u64` seed for the deterministic internal PRNG. This side-
     *   steps JS's lack of a native `u64`: any JS number maps deterministically
     *   to a seed, and passing the same number always yields the same index.
     */
    static withConfig(dims: number, max_connections: number, ef_construction: number, ef_search: number, metric: string, seed: number): FerrovecCore;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_ferroveccore_free: (a: number, b: number) => void;
    readonly ferroveccore_clear: (a: number) => void;
    readonly ferroveccore_compact: (a: number) => void;
    readonly ferroveccore_contains: (a: number, b: number, c: number) => number;
    readonly ferroveccore_dims: (a: number) => number;
    readonly ferroveccore_fromBytes: (a: number, b: number) => [number, number, number];
    readonly ferroveccore_insert: (a: number, b: number, c: number, d: number, e: number) => [number, number];
    readonly ferroveccore_isEmpty: (a: number) => number;
    readonly ferroveccore_len: (a: number) => number;
    readonly ferroveccore_new: (a: number) => number;
    readonly ferroveccore_remove: (a: number, b: number, c: number) => number;
    readonly ferroveccore_search: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly ferroveccore_toBytes: (a: number) => [number, number, number, number];
    readonly ferroveccore_withConfig: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number, number];
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
