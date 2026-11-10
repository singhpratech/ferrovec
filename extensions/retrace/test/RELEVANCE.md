# Relevance: how Retrace decides a result is a close match

Measured 2026-11-10 on the built extension (all-MiniLM-L6-v2, q8, wasm),
pages fetched 2026-11-10. Reproduce with:

```
node test/relevance/fetch.ts          # cache the 35 pages (gitignored)
npm run build
node test/relevance/measure.ts        # index them, run every query, save raw hits
node test/relevance/analyze.ts passage --set held-out-2   # or tuning / held-out / all, --grid
```

## Method

- **Corpus: 35 real long-form pages.** 28 Wikipedia articles, 3 Rust book
  chapters (ownership, borrowing, lifetimes) and 3 MDN pages (OPFS, IndexedDB,
  Web Workers). They cover clearly different topics plus deliberately related
  groups: the Rust book, databases (write-ahead logging, B-tree, ACID,
  SQLite), browser storage, coral bleaching / Great Barrier Reef, sourdough /
  baker's yeast, espresso / coffee, and honey bee / waggle dance. The list is
  in `relevance/pages.ts`.
- **Indexing path.** The pages are served from a cache by the test proxy, and
  each is opened in a tab. The real content script (Readability) extracts
  them, and the real store host chunks and embeds them. Result: 399 passages,
  at most 12 per page.
- **Searching.** Every query goes through the service worker with k = 60
  passages, like the search page, and is then grouped by page.
- **Queries (122 in all, in `relevance/queries.ts`).** Each query either names
  the page a reader would have in mind, or has no target page.

  | Set | Target queries | No-target queries | Written |
  |---|---|---|---|
  | tuning | 42 | 15 | before any score was seen |
  | held-out 1 | 24 | 9 | after rule v1 was chosen |
  | held-out 2 | 22 | 10 | after the final rule was chosen, never used to choose anything |

- **Metrics.**
  - Precision (strict): strong results that are the target page, divided by
    all strong results. "Lenient" also accepts a page in the target's
    related group (for example another Rust chapter).
  - Recall: target queries whose target page is strong.
  - No-target clean: no-target queries with nothing strong.

## What the data says

**Retrieval is not the problem.** Across all 88 target queries, the target
page ranked 1st 83 times, 2nd 3 times and 3rd twice; it was never outside the
top 60 passages. The misses were sibling pages in a related group ranking
higher.

On a first run only 25 of 35 pages were indexed. The cause: the harness
closed tabs before the content script had sent the page. That fed a fix to
the content script (below) and a stricter harness. All numbers here are from
runs where all 35 pages were indexed.

**Score distributions (all 122 queries):**

| | n | min | p25 | median | p75 | max |
| --- | --- | --- | --- | --- | --- | --- |
| target page | 88 | 0.292 | 0.490 | 0.561 | 0.646 | 0.806 |
| best non-target page, same queries | 88 | 0.162 | 0.292 | 0.362 | 0.473 | 0.611 |
| top page, no-target queries | 34 | 0.116 | 0.220 | 0.326 | 0.399 | 0.532 |
| lead of top over runner-up, target ranked 1st | 83 | 0.019 | 0.128 | 0.200 | 0.272 | 0.415 |
| lead of top over runner-up, no-target queries | 34 | 0.002 | 0.015 | 0.039 | 0.108 | 0.209 |
| query-word overlap, top page's best passage, target 1st | 83 | 0.000 | 0.429 | 0.600 | 0.800 | 1.000 |
| query-word overlap, top page's best passage, no target | 34 | 0.000 | 0.000 | 0.200 | 0.333 | 0.667 |

Score alone overlaps heavily: no-target tops reach 0.53, and a loose
paraphrase of a real target can score 0.29. Two signals separate them better:
how far the top page leads the runner-up, and how many of the query's words
its best passage contains.

The number of a page's passages in the top k does not separate them here.
Most top pages contribute all 12 of their passages to the top 60, whether
they match or not.

**Embedding "title. passage" instead of the passage alone (tuning set):**

| | target 1st | coordinator's query rank / score | final rule: precision, recall, no-target clean |
| --- | --- | --- | --- |
| passage only | 40/42 | 3rd / 0.292 | 93%, 98%, 93% |
| title. passage | 40/42 | 3rd / 0.256 | 91%, 95%, 93% |

It is no better, so it was **not adopted**: stored vectors are unchanged and
no re-index is needed. The switch stays in `src/lib/embed.ts` for future
measurements, with "passage" as the default.

## The rule (`STRENGTH_RULE` in `src/lib/group.ts`)

- The **top page** is strong if its score is **≥ 0.48**, or if it is
  **≥ 0.30** and stands out. Standing out means one of:
  - it leads the runner-up page by **≥ 0.15**, or
  - its best passage contains **≥ 60 %** of the query's content words.
- **Other pages** are strong only if they score ≥ 0.48 and are within
  **0.05** of the top score.
- If the top page is not strong, nothing is. The search page then says
  "Nothing you have read matches closely" and offers everything as weaker
  matches. The omnibox suggests strong results only.

**How it was chosen.**

1. A grid search on the tuning set gave rule v1: floor 0.42, margin 0.10,
   otherwise the same.
2. On held-out set 1, v1 rejected only 56 % of no-target queries, because
   held-out 1 has near-topic queries (tokio, MongoDB, service-worker caching,
   coffee-shop prices, the Colosseum) and the tuning no-target queries were
   mostly far-off.
3. Rule v2 was then chosen from the recall vs no-target trade-off on tuning +
   held-out 1, which raised the floor to 0.48 and narrowed the margin to
   0.05. Held-out set 2 was written after that.

## Results

| set | rule | precision (strict) | precision (lenient) | recall | no-target clean |
| --- | --- | --- | --- | --- | --- |
| **held-out 2** (final, unseen) | **final** | **84 % (21/25)** | **88 %** | **95 % (21/22)** | **70 % (7/10)** |
| held-out 2 | previous (0.34 floor, 0.15 margin) | 61 % (22/36) | 81 % | 100 % | 50 % |
| tuning (fitted) | final | 93 % (41/44) | 98 % | 98 % | 93 % |
| held-out 1 (used to choose the final rule) | final | 81 % (21/26) | 88 % | 88 % | 78 % |
| held-out 1 | v1 (0.42 floor, 0.10 margin) | 68 % (23/34) | 76 % | 96 % | 56 % |
| all 122 | final | 87 % (83/95) | 93 % | 94 % | 82 % |
| all 122 | previous | 61 % (86/142) | 80 % | 98 % | 59 % |

**Confusions on held-out 2 with the final rule:**

- *missed:* "references that are guaranteed not to point at freed memory" →
  rust-borrowing ranked 2nd (0.489) behind rust-ownership (0.611), which is
  shown as strong instead. That is a ranking miss between two related chapters.
- *false:* "the deepest point in the ocean" → Plate tectonics (0.410; its best
  passage shares "ocean" and "point").
- *false:* "the history of the egyptian sphinx" → Great Pyramid of Giza (0.514).
- *false:* "training for a triathlon" → Marathon (0.399, leads by 0.209).

**The query reported from the headed run:** "why did my variable become
invalid after I passed it to a function". The ownership chapter ranks 3rd
(0.292), behind the borrowing chapter (0.345, whose opening also covers
passing a String to a function) and the lifetimes chapter (0.343). The top
page leads by 0.002, so nothing is strong and the page says so; all three
chapters are in the weaker list.

This is a ranking problem between near-identical chapters. A looser cutoff
would not fix it: it would mark the wrong chapter strong and add false
positives elsewhere.

## Limits

- **Near-topic queries.** A question about a topic close to something you
  read (the Sphinx after reading about the Pyramids) can show that page as a
  close match. MiniLM scores topical closeness, not whether the page answers
  the question. About 3 in 10 no-target held-out queries got a strong result.
- **Loosely worded queries.** A loosely worded query for one of several near
  identical pages (sibling chapters) may rank a sibling first, or show nothing
  close.
- **The thresholds are tied to this setup:** all-MiniLM-L6-v2 q8, k = 60, 12
  passages per page, and a 35-page store. In a much larger store the
  runner-up is usually closer, so the "leads the runner-up" signal fires less
  often and more results will be weak; this has not been measured.
- **Who wrote the queries.** One person wrote all of them, against labels they
  also chose, and the held-out sets are small (33 and 32 queries). Treat the
  percentages as ±10 points.
- **Extraction and the passage cap.** Only the first 12 passages (about 2,600
  words) of a page are indexed; for these queries that never decided a miss.
  Pages are served from a cache, so live versions may differ.
