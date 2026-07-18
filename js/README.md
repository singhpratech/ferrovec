# ferrovec

Text-in vector search for the browser: [transformers.js](https://github.com/huggingface/transformers.js)
embeddings over a Rust/wasm HNSW core, running on a dedicated Web Worker, with
**OPFS persistence** so your index survives reloads.

You give it text. It embeds, indexes, and searches — off the main thread.

**`0.2.0`** — the three-line browser API (embeddings + OPFS persistence) is here.
· [Website](https://singhpratech.github.io/ferrovec/) · [GitHub](https://github.com/singhpratech/ferrovec) · [Rust core on crates.io](https://crates.io/crates/ferrovec)

## Install

```sh
npm install ferrovec
```

## Three-line API

```ts
import { Ferrovec } from 'ferrovec';

const db = await Ferrovec.open('notes');        // spawns the worker, loads the model
await db.insert('the cat sat on the mat');      // embed + index (returns its id)
const hits = await db.query('a napping kitten', 5); // → [{ id, text, score }, ...]
```

Full surface:

```ts
const id = await db.insert('some text', { id: 'doc-1' }); // explicit id (upsert)
const hits = await db.query('query text', 10);            // k nearest, nearest-first
await db.remove('doc-1');                                 // → boolean
await db.size();                                          // → number of live items
await db.close();                                         // final flush + terminate worker
```

Each hit is `{ id: string; text?: string; score: number }`, where `score` is
cosine similarity (higher = closer, ≈1 for near-duplicates).

## Persistence (OPFS)

By default an index is **persisted** to the [Origin Private File System](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system)
so it survives page reloads:

```ts
const db = await Ferrovec.open('notes');   // persist: true by default
// ... insert / remove ...
await db.close();                          // guarantees a final snapshot to disk

// Later — after a full reload — reopening the same name restores everything:
const again = await Ferrovec.open('notes');
await again.size();                        // your items are still there
console.log(again.persistent);             // true when running from disk
```

How it works:

- The worker opens `ferrovec/<name>/index.bin` in OPFS via a
  `FileSystemSyncAccessHandle` (worker-only, secure-context-only).
- Writes are **full snapshots, debounced ~250 ms**: each `insert`/`remove` marks
  the store dirty and schedules one `write(at:0)` → `truncate` → `flush`.
  `close()` always performs a final synchronous flush before releasing the lock.
- The snapshot contains the serialized vector index **and** the id→text sidecar,
  framed together so a reload restores both atomically.

**Graceful degradation — it never crashes:**

- Opt out with `Ferrovec.open('notes', { persist: false })` for pure in-memory.
- Where OPFS sync access is unavailable (Node, insecure context, unsupported
  browser) it transparently falls back to in-memory.
- The sync handle takes an **exclusive lock**. If another tab already holds it,
  the open logs a warning and falls back to in-memory (cross-tab leader election
  is a future milestone).

Check the resolved mode with `db.persistent` (`true` = writing to disk).

> **Secure context required.** OPFS sync access handles only work over HTTPS or
> `http://localhost`. Persistence is silently disabled elsewhere.

## Bundler setup

`Ferrovec.open` spawns the worker with the standard, statically-analyzable
pattern:

```ts
new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
```

Modern bundlers understand this out of the box:

- **Vite** — works with no configuration.
- **webpack 5** — works with no configuration (native `new URL` + Web Worker support).

The worker (`dist/worker.js`) and the wasm core (`dist/core/`) are shipped in the
package and resolved relative to the module URL, so no extra copy step is needed.
If your bundler does not support the `new URL(..., import.meta.url)` worker
pattern, point it at the published `ferrovec/worker` entry.

## Advanced / Node usage

`Ferrovec` is the Worker-backed main-thread proxy. For non-browser environments
(or custom embedders), drive the `Engine` directly — it has no Worker/DOM
coupling and accepts injected embedders and cores:

```ts
import { Engine, createCore } from 'ferrovec';

const engine = await Engine.create({ embedder: myEmbedder, core: await createCore(384) });
await engine.insert('hello world');
const hits = await engine.query('hi there', 5);
```

The default embedder is `Xenova/all-MiniLM-L6-v2` (384-dim). Pass `{ model }` /
`{ device }` to `Ferrovec.open` or `Engine.create` to change it.

## Roadmap

| | Milestone | Status |
| --- | --- | --- |
| **M1–M2** | Rust HNSW core + WASM boundary + SIMD | ✅ shipped |
| **M3** | Web Worker + transformers.js auto-embedding | ✅ `0.2.0` |
| **M4** | OPFS persistence (survives reloads) | ✅ `0.2.0` |
| **M5** | Three-line browser API on npm | ✅ `0.2.0` |
| **M6** | Cross-tab leader election (Web Locks) | ⏭ next → `0.3.0` |

The pure-Rust HNSW core is published separately on [crates.io](https://crates.io/crates/ferrovec).

## License

MIT
