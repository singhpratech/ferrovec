/**
 * Analyse a relevance measurement (measure.ts output) offline:
 *
 *   node test/relevance/analyze.ts [variant] [--grid] [--set tuning|held-out|all]
 *
 * Prints, per query: the target page's rank and score among grouped pages,
 * the top and runner-up scores, the gap, the target's passage count in the
 * top k, and whether its evidence was in the index at all. Then the score
 * distributions (target / best non-target / top of no-target queries), the
 * rank distribution, and how strong/weak rules classify the queries:
 *
 * - precision: strong results that are the target page / all strong results
 *   (strict); "lenient" also accepts a page in the target's related cluster;
 * - recall: target queries whose target page is strong;
 * - no-target queries with nothing strong.
 *
 * `--grid` searches the rule's parameters on the selected set.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { groupHits, queryOverlap, splitByStrength, STRENGTH_RULE, type PageResult, type StrengthRule } from '../../src/lib/group.ts';
import type { Hit } from '../../src/lib/types.ts';
import { RESULTS } from './cache.ts';
import { ALL_QUERIES, type Query } from './queries.ts';

const args = process.argv.slice(2);
const variant = args.find((a) => !a.startsWith('--') && !['tuning', 'held-out', 'held-out-2', 'all', 'tuned'].includes(a)) ?? 'passage';
const setArg = args.includes('--set') ? args[args.indexOf('--set') + 1]! : 'tuning';
const grid = args.includes('--grid');

/** Pages that are legitimately related: a strong result in the target's cluster is not a wrong answer. */
const CLUSTERS: string[][] = [
  ['rust-ownership', 'rust-borrowing', 'rust-lifetimes'],
  ['write-ahead-logging', 'b-tree', 'acid', 'sqlite'],
  ['mdn-opfs', 'mdn-indexeddb', 'mdn-web-workers'],
  ['coral-bleaching', 'great-barrier-reef'],
  ['sourdough', 'bakers-yeast'],
  ['espresso', 'coffee'],
  ['honey-bee', 'honeybee-dance'],
];
const related = (a: string, b: string): boolean => a === b || CLUSTERS.some((c) => c.includes(a) && c.includes(b));

interface Measured {
  pages: Record<string, string>;
  hits: Record<string, Hit[]>;
  passages: number;
  measuredAt: string;
}

export interface Row {
  q: Query;
  results: PageResult[];
  pageIdOf: (url: string) => string;
  targetRank: number | null; // 1-based; null = not among the grouped top-k pages
  targetScore: number | null;
  targetMatches: number;
  top: number;
  runnerUp: number;
  bestNonTarget: number;
  evidenceIndexed: boolean | null;
}

export async function load(v: string): Promise<{ rows: Row[]; measured: Measured }> {
  const measured = JSON.parse(await readFile(join(RESULTS, `hits-${v}.json`), 'utf8')) as Measured;
  const indexed = JSON.parse(await readFile(join(RESULTS, `indexed-${v}.json`), 'utf8')) as Record<
    string,
    { passages: string[] }
  >;
  const idByUrl = new Map(Object.entries(measured.pages).map(([id, url]) => [url, id]));
  const pageIdOf = (url: string): string => idByUrl.get(url) ?? url;
  const rows: Row[] = [];
  for (const q of ALL_QUERIES) {
    const hits = measured.hits[q.query];
    if (!hits) continue;
    const results = groupHits(hits);
    const idx = q.target ? results.findIndex((r) => pageIdOf(r.url) === q.target) : -1;
    const target = idx >= 0 ? results[idx]! : null;
    const evidenceIndexed =
      q.target && q.evidence
        ? (indexed[q.target]?.passages ?? []).some((p) => q.evidence!.every((w) => p.toLowerCase().includes(w.toLowerCase())))
        : null;
    rows.push({
      q,
      results,
      pageIdOf,
      targetRank: idx >= 0 ? idx + 1 : null,
      targetScore: target?.score ?? null,
      targetMatches: target?.matches ?? 0,
      top: results[0]?.score ?? 0,
      runnerUp: results[1]?.score ?? 0,
      bestNonTarget: Math.max(0, ...results.filter((r) => pageIdOf(r.url) !== q.target).map((r) => r.score)),
      evidenceIndexed,
    });
  }
  return { rows, measured };
}

export interface Evaluation {
  precision: number;
  lenientPrecision: number;
  recall: number;
  noTargetClean: number;
  strongTotal: number;
  tp: number;
  lenientTp: number;
  targets: number;
  noTargets: number;
  confusions: string[];
}

export function evaluate(rows: Row[], rule: StrengthRule): Evaluation {
  let strongTotal = 0;
  let tp = 0;
  let lenientTp = 0;
  let found = 0;
  let clean = 0;
  const confusions: string[] = [];
  for (const r of rows) {
    const { strong } = splitByStrength(r.results, r.q.query, rule);
    const ids = strong.map((s) => r.pageIdOf(s.url));
    strongTotal += ids.length;
    if (r.q.target) {
      const hit = ids.includes(r.q.target);
      if (hit) found++;
      tp += ids.filter((id) => id === r.q.target).length;
      lenientTp += ids.filter((id) => related(id, r.q.target!)).length;
      const wrong = ids.filter((id) => id !== r.q.target);
      if (!hit || wrong.length) {
        confusions.push(
          `${hit ? 'extra ' : 'MISSED'} "${r.q.query}" → target ${r.q.target} (rank ${r.targetRank ?? '-'}, ${fmt(r.targetScore)}); strong: [${ids.map((id, i) => `${id} ${fmt(strong[i]!.score)}`).join(', ')}]`,
        );
      }
    } else {
      if (ids.length === 0) clean++;
      else confusions.push(`FALSE  "${r.q.query}" (no target); strong: [${ids.map((id, i) => `${id} ${fmt(strong[i]!.score)}`).join(', ')}]`);
    }
  }
  const targets = rows.filter((r) => r.q.target).length;
  const noTargets = rows.length - targets;
  return {
    precision: strongTotal ? tp / strongTotal : 1,
    lenientPrecision: strongTotal ? lenientTp / strongTotal : 1,
    recall: targets ? found / targets : 1,
    noTargetClean: noTargets ? clean / noTargets : 1,
    strongTotal,
    tp,
    lenientTp,
    targets,
    noTargets,
    confusions,
  };
}

export function fmt(n: number | null | undefined): string {
  return n == null ? '  -  ' : n.toFixed(3);
}

function stats(xs: number[]): string {
  if (!xs.length) return 'n/a';
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number): number => s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
  return `n=${s.length}  min ${fmt(s[0])}  p25 ${fmt(q(0.25))}  median ${fmt(q(0.5))}  p75 ${fmt(q(0.75))}  max ${fmt(s[s.length - 1])}`;
}

function pct(x: number): string {
  return `${(x * 100).toFixed(0)}%`;
}

async function main(): Promise<void> {
  const { rows: all, measured } = await load(variant);
  const rows =
    setArg === 'all'
      ? all
      : setArg === 'tuned'
        ? all.filter((r) => r.q.set !== 'held-out-2')
        : all.filter((r) => r.q.set === setArg);
  console.log(`variant ${variant}, set ${setArg}: ${rows.length} queries over ${Object.keys(measured.pages).length} pages / ${measured.passages} passages (measured ${measured.measuredAt})\n`);

  console.log('rank  target  top    2nd    gap    m  ev  query → target');
  for (const r of rows) {
    const rank = r.targetRank === null ? (r.q.target ? ' >k' : '   ') : String(r.targetRank).padStart(3);
    const ev = r.evidenceIndexed === null ? '  ' : r.evidenceIndexed ? 'y ' : 'n ';
    console.log(
      `${rank}  ${fmt(r.targetScore)}  ${fmt(r.top)}  ${fmt(r.runnerUp)}  ${fmt(r.top - r.runnerUp)}  ${String(r.targetMatches).padStart(2)}  ${ev}  "${r.q.query}" → ${r.q.target ?? '(none)'}${r.targetRank && r.targetRank > 1 ? `  [top: ${r.pageIdOf(r.results[0]!.url)}]` : ''}`,
    );
  }

  const withTarget = rows.filter((r) => r.q.target);
  const noTarget = rows.filter((r) => !r.q.target);
  console.log('\nscore distributions');
  console.log(`  target page:                      ${stats(withTarget.map((r) => r.targetScore ?? 0))}`);
  console.log(`  best non-target, target queries:  ${stats(withTarget.map((r) => r.bestNonTarget))}`);
  console.log(`  top page, no-target queries:      ${stats(noTarget.map((r) => r.top))}`);
  console.log(`  gap top − 2nd, target ranked 1:   ${stats(withTarget.filter((r) => r.targetRank === 1).map((r) => r.top - r.runnerUp))}`);
  console.log(`  gap top − 2nd, no-target queries: ${stats(noTarget.map((r) => r.top - r.runnerUp))}`);
  console.log(`  target passages in top k (rank 1): ${stats(withTarget.filter((r) => r.targetRank === 1).map((r) => r.targetMatches))}`);
  const topOverlap = (r: Row): number => queryOverlap(r.q.query, r.results[0]?.snippet ?? '');
  console.log(`  query-word overlap, top page, target ranked 1: ${stats(withTarget.filter((r) => r.targetRank === 1).map(topOverlap))}`);
  console.log(`  query-word overlap, top page, no-target:       ${stats(noTarget.map(topOverlap))}`);
  console.log(`  top page passages in top k (no-target): ${stats(noTarget.map((r) => r.results[0]?.matches ?? 0))}`);

  const ranks = withTarget.map((r) => r.targetRank);
  const count = (f: (x: number | null) => boolean): number => ranks.filter(f).length;
  console.log('\nrank of the target page (grouped pages, k = 60 passages)');
  console.log(
    `  1: ${count((x) => x === 1)}   2: ${count((x) => x === 2)}   3: ${count((x) => x === 3)}   4-10: ${count((x) => x !== null && x >= 4 && x <= 10)}   >10: ${count((x) => x !== null && x > 10)}   not in top k: ${count((x) => x === null)}   (of ${withTarget.length})`,
  );
  const notFirst = withTarget.filter((r) => r.targetRank !== 1);
  console.log(
    `  not ranked first: ${notFirst.length}; of those, evidence not in the index (12-passage cap / extraction): ${notFirst.filter((r) => r.evidenceIndexed === false).length}`,
  );

  const report = (name: string, rule: StrengthRule): Evaluation => {
    const e = evaluate(rows, rule);
    console.log(
      `\n${name} ${JSON.stringify(rule)}\n  precision ${pct(e.precision)} (${e.tp}/${e.strongTotal}), lenient ${pct(e.lenientPrecision)}; recall ${pct(e.recall)} (of ${e.targets}); no-target clean ${pct(e.noTargetClean)} (of ${e.noTargets})`,
    );
    for (const c of e.confusions) console.log(`    ${c}`);
    return e;
  };
  report('old rule (floor 0.34, margin 0.15)', { floor: 0.34, lowFloor: 0.34, minGap: 9, minOverlap: 9, margin: 0.15 });
  report('current rule', STRENGTH_RULE);

  if (grid) {
    const candidates: Array<{ rule: StrengthRule; e: Evaluation; score: number }> = [];
    for (const floor of [0.3, 0.32, 0.34, 0.36, 0.38, 0.4, 0.42, 0.45])
      for (const lowFloor of [0.15, 0.18, 0.2, 0.22, 0.25, 0.28, 0.3])
        for (const minGap of [0.04, 0.06, 0.08, 0.1, 0.12, 0.15])
          for (const minOverlap of [0.3, 0.4, 0.5, 0.6, 9])
            for (const margin of [0.1, 0.15]) {
              if (lowFloor > floor) continue;
              const rule = { floor, lowFloor, minGap, minOverlap, margin };
              const e = evaluate(rows, rule);
              // Favour recall, but every false strong result costs more than a miss.
              const fp = e.strongTotal - e.lenientTp;
              candidates.push({ rule, e, score: e.recall * e.targets - 2 * fp });
            }
    candidates.sort((a, b) => b.score - a.score);
    console.log('\ngrid: best by (found targets − 2 × wrong strong results)');
    for (const c of candidates.slice(0, 15)) {
      console.log(
        `  ${JSON.stringify(c.rule)}  recall ${pct(c.e.recall)}  precision ${pct(c.e.precision)} lenient ${pct(c.e.lenientPrecision)}  no-target clean ${pct(c.e.noTargetClean)}`,
      );
    }
  }
  await writeFile(join(RESULTS, `analysis-${variant}-${setArg}.json`), JSON.stringify(evaluate(rows, STRENGTH_RULE), null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
