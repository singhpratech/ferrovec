# ferrovec kill-the-tab chaos results

**Claim under test:** once `insert()` has resolved (the write is *acknowledged*),
the document survives the tab being killed at any moment, with no `close()` and
no `flush()`.

**What one cycle does** (`test/chaos/harness.ts`): open a fresh page on a persistent
browser profile and open the store (strict durability) with the real coordinator,
A/B slot store, write-ahead log and wasm HNSW core, using a deterministic fake
embedder so no model is downloaded. Insert a random batch of 1–20 documents, then
kill the page (`page.close({ runBeforeUnload: false })`) after a random number of
acknowledgements, often while the next insert is in flight. A checkpoint (full
snapshot plus log reset) runs every 50 logged records, so some kills also land
near checkpoints. The next cycle's page reopens the store (decode the snapshot,
then replay the log) and checks that the store holds at least as many documents
as were ever acknowledged. It also checks that every id acknowledged in the
previous cycle, plus 20 sampled older ids, comes back first for an exact-text
query with its stored text intact. A final reopen checks every acknowledged id.

| browser | cycles | acked writes | lost | torn tails recovered | reopen p50 / p95 (ms) | date | ferrovec commit |
|---|---:|---:|---:|---:|---:|---|---|
| Chromium 149 (headless, Playwright) | 1,000 | 5,887 | **0** | 1 | 64.3 / 82.6 | 2026-10-10 | 67bb5c6 |
| Firefox 151 (headless, Playwright) | 1,000 | 6,012 | **0** | 0 | 174 / 325 | 2026-10-10 | 67bb5c6 |
| WebKit 26.5 (Playwright) | — | — | — | — | — | not run | could not launch on the test host (missing system library `libavif16`) |

Notes:

- **Lost** counts acknowledged ids missing on reopen. In both runs the store
  was never smaller than the number of acknowledged writes (0 size violations),
  and every id was the top-1 hit for its own text (0 fallbacks).
- **Torn tails recovered** counts reopens where the log ended in a partial
  record, which was cut off and never applied. In strict mode that record had
  not been acknowledged.
- **Reopen** is the time to open the store in a fresh page, measured from the
  `open` request to its response. It includes worker start, wasm init,
  snapshot decode and log replay. The index grows to about 6,000 documents over
  a run, so later reopens are slower, most visibly in Firefox.
- Kills landed mid-batch in 773 of 1,000 Chromium cycles and 816 of 1,000
  Firefox cycles; the remaining cycles were killed right after the batch's last
  acknowledgement.
- Seeds: Chromium `830120441`, Firefox `1046975639`. They make batch sizes and
  kill points reproducible, but not the timing.
- Negative control: when the harness was run against a build whose log write
  was deferred by 30 ms (simulating the old 250 ms snapshot debounce), all 259
  acknowledged writes in a 30-cycle run were reported lost. The harness does
  detect loss.
- Durability scope: OPFS `flush()` gives content consistency, not `fsync`.
  These results cover tab and worker kills, not power loss or OS crashes.

Rivals (EdgeVec, VecLite, @ruvector/wasm): pending, to be run with the same
harness in a follow-up.

Re-run:

```sh
cd js
npm run test:chaos                         # 100 cycles, Chromium
CYCLES=1000 npm run test:chaos             # the published Chromium run
CYCLES=1000 BROWSER=firefox npm run test:chaos
```

Each run prints a JSON summary and writes it to `test/chaos/results/`
(gitignored).
