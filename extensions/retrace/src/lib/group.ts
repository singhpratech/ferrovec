/**
 * Turn ranked passages into ranked pages: one result per URL, scored by its
 * best passage, which also becomes the snippet. Plus the client-side filters
 * and the link to the passage.
 */

import { splitSentences } from './chunk.ts';
import type { Hit } from './types.ts';

export interface PageResult {
  url: string;
  title: string;
  host: string;
  /** Latest known visit (ISO). */
  visitedAt: string;
  /** Score of the best passage. */
  score: number;
  /** The best passage's text. */
  snippet: string;
  /** Index of the best passage within the page. */
  chunk: number;
  /** Number of the page's passages among the hits. */
  matches: number;
}

export function groupHits(hits: readonly Hit[]): PageResult[] {
  const byUrl = new Map<string, PageResult>();
  for (const hit of hits) {
    const { meta } = hit;
    const visitedAt = latest(hit.lastVisitedAt, meta.visitedAt);
    const existing = byUrl.get(meta.url);
    if (!existing) {
      byUrl.set(meta.url, {
        url: meta.url,
        title: meta.title,
        host: meta.host,
        visitedAt,
        score: hit.score,
        snippet: hit.text,
        chunk: meta.chunk,
        matches: 1,
      });
      continue;
    }
    existing.matches += 1;
    existing.visitedAt = latest(existing.visitedAt, visitedAt);
    if (hit.score > existing.score) {
      existing.score = hit.score;
      existing.snippet = hit.text;
      existing.chunk = meta.chunk;
      existing.title = meta.title;
    }
  }
  return [...byUrl.values()].sort((a, b) => b.score - a.score || (a.url < b.url ? -1 : 1));
}

function latest(a: string | undefined, b: string): string {
  if (!a) return b;
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

export interface ResultFilter {
  /** Keep only this host (and its subdomains). */
  host?: string;
  /** Keep only pages visited at or after this time. */
  since?: number;
}

export function filterResults(results: readonly PageResult[], filter: ResultFilter): PageResult[] {
  const host = filter.host?.trim().toLowerCase();
  return results.filter((r) => {
    if (host && r.host !== host && !r.host.endsWith(`.${host}`)) return false;
    if (filter.since !== undefined && Date.parse(r.visitedAt) < filter.since) return false;
    return true;
  });
}

// ---------------------------------------------------------------------------
// Strong and weak results
// ---------------------------------------------------------------------------

/**
 * The strong/weak rule, for the top page and then the rest:
 *
 * - The top page is strong when its score clears `floor`; or, below that,
 *   when it clears `lowFloor` AND clearly stands out: it leads the runner-up
 *   page by at least `minGap`, or its best passage contains at least
 *   `minOverlap` of the query's content words (see {@link queryOverlap}).
 * - Every other page is strong only if it clears `floor` and is within
 *   `margin` of the top score.
 * - If the top page is not strong, nothing is.
 */
export interface StrengthRule {
  floor: number;
  lowFloor: number;
  minGap: number;
  minOverlap: number;
  margin: number;
}

/**
 * Chosen from real-content measurements (35 real pages, test/relevance);
 * test/RELEVANCE.md has the data, the method and held-out precision/recall.
 */
export const STRENGTH_RULE: StrengthRule = {
  floor: 0.48,
  lowFloor: 0.3,
  minGap: 0.15,
  minOverlap: 0.6,
  margin: 0.05,
};

/** Share of the query's content words that occur in `passage` (0 for a query with none). */
export function queryOverlap(query: string, passage: string): number {
  const q = contentWords(query);
  if (q.size === 0) return 0;
  const p = contentWords(passage);
  let n = 0;
  for (const w of q) if (p.has(w)) n++;
  return n / q.size;
}

/**
 * Split ranked results (best first, as {@link groupHits} returns them) into
 * strong matches, shown as results, and weak ones, offered behind a
 * disclosure. Order is kept within each part. `query` feeds the word-overlap
 * signal; without it only the scores count.
 */
export function splitByStrength(
  results: readonly PageResult[],
  query = '',
  rule: StrengthRule = STRENGTH_RULE,
): { strong: PageResult[]; weak: PageResult[] } {
  const [top, second] = results;
  if (!top) return { strong: [], weak: [] };
  const gap = top.score - (second?.score ?? 0);
  const standsOut = gap >= rule.minGap || (query !== '' && queryOverlap(query, top.snippet) >= rule.minOverlap);
  const topStrong = top.score >= rule.floor || (top.score >= rule.lowFloor && standsOut);
  if (!topStrong) return { strong: [], weak: [...results] };
  const strong: PageResult[] = [top];
  const weak: PageResult[] = [];
  for (const r of results.slice(1)) {
    (r.score >= rule.floor && r.score >= top.score - rule.margin ? strong : weak).push(r);
  }
  return { strong, weak };
}

// ---------------------------------------------------------------------------
// Snippets
// ---------------------------------------------------------------------------

const STOPWORDS = new Set(
  (
    'a an and are as at be been but by can could did do does for from had has have how i if in into is it its ' +
    'me my no not of on or our so than that the their them then there these they this to too up us was we ' +
    'were what when where which while who why will with would you your about after all also any before can ' +
    'get got just more most much only other out over same should some such very'
  ).split(' '),
);

/** Lower-cased content words of `text`, lightly stemmed (plural and common verb endings). */
export function contentWords(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    if (raw.length < 3 || STOPWORDS.has(raw)) continue;
    out.add(stem(raw));
  }
  return out;
}

function stem(word: string): string {
  for (const suffix of ['ing', 'ed', 'es', 's']) {
    if (word.length - suffix.length >= 3 && word.endsWith(suffix)) return word.slice(0, -suffix.length);
  }
  return word;
}

export interface Snippet {
  /** The snippet starts mid-passage (show a leading ellipsis). */
  lead: boolean;
  /** The sentence to highlight; `''` when no sentence shares a word with the query. */
  mark: string;
  /** Text after the highlighted sentence (or the whole snippet when `mark` is empty). */
  rest: string;
  /** The snippet was cut short (show a trailing ellipsis). */
  cut: boolean;
}

/**
 * Pick the snippet for `passage`: start at the sentence sharing the most
 * content words with `query` (the earliest on a tie) and highlight it. When no
 * sentence shares a word (a purely semantic match), start at the passage
 * start and highlight nothing. At most `maxChars` characters, cut on a word.
 */
export function snippetFor(passage: string, query: string, maxChars = 320): Snippet {
  const sentences = passage
    .split(/\n+/)
    .flatMap((p) => splitSentences(p.replace(/\s+/g, ' ').trim()))
    .filter(Boolean);
  const q = contentWords(query);
  let best = -1;
  let bestOverlap = 0;
  sentences.forEach((sentence, i) => {
    let overlap = 0;
    for (const w of contentWords(sentence)) if (q.has(w)) overlap++;
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      best = i;
    }
  });
  const from = Math.max(0, best);
  const mark = best >= 0 ? sentences[best]! : '';
  const after = sentences.slice(best >= 0 ? from + 1 : from).join(' ');
  const full = mark ? (after ? `${mark} ${after}` : mark) : after;
  const cut = full.length > maxChars;
  // Cut at `n` characters; drop a word only if the cut fell inside it.
  const clip = (s: string, n: number): string => {
    if (s.length <= n) return s;
    const head = s.slice(0, n);
    return (/\s/.test(s[n]!) ? head : head.replace(/\S*$/, '')).trimEnd();
  };
  if (mark.length >= maxChars) {
    return { lead: from > 0, mark: clip(mark, maxChars), rest: '', cut: true };
  }
  const rest = mark ? clip(after ? ` ${after}` : '', maxChars - mark.length) : clip(after, maxChars);
  return { lead: from > 0, mark, rest, cut };
}

/** One omnibox suggestion as plain text (the platform layer adds markup). */
export interface Suggestion {
  /** URL opened on Enter: the page, scrolled to the matched sentence. */
  content: string;
  title: string;
  detail: string;
}

/** Address-bar suggestions for `query`: strong matches only, best first. */
export function omniboxSuggestions(hits: readonly Hit[], query: string, max = 5): Suggestion[] {
  const { strong } = splitByStrength(groupHits(hits), query);
  return strong.slice(0, max).map((p) => {
    const snippet = snippetFor(p.snippet, query, 120);
    return {
      content: passageLink(p.url, snippet.mark || p.snippet),
      title: p.title,
      detail: `${p.host}: ${snippet.mark}${snippet.rest}`,
    };
  });
}

/** The time-range choices the search page offers, in milliseconds back from now. */
export const TIME_RANGES: Record<string, number | undefined> = {
  any: undefined,
  day: 24 * 3600_000,
  week: 7 * 24 * 3600_000,
  month: 30 * 24 * 3600_000,
  year: 365 * 24 * 3600_000,
};

/** Encode a text-directive term: percent-encode everything a directive treats specially. */
function encodeTextTerm(s: string): string {
  return encodeURIComponent(s).replace(/-/g, '%2D');
}

/**
 * `url` with a text fragment (`#:~:text=`) that scrolls to and highlights the
 * start of `passage`. Uses the first few words of the passage's first
 * paragraph; returns `url` unchanged when there is too little to anchor on.
 */
export function passageLink(url: string, passage: string, words = 8): string {
  const firstParagraph = passage.split(/\n/).find((p) => p.trim().split(/\s+/).length >= 3);
  if (!firstParagraph) return url;
  const start = firstParagraph
    .trim()
    .split(/\s+/)
    .slice(0, words)
    .join(' ')
    // A directive term may not end mid-punctuation that the page renders differently.
    .replace(/[\s,;:]+$/, '');
  if (!start) return url;
  const base = url.replace(/#.*$/, '');
  return `${base}#:~:text=${encodeTextTerm(start)}`;
}

/** "3 days ago"-style label for an ISO time. */
export function relativeTime(iso: string, now = Date.now(), locale?: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const seconds = Math.round((t - now) / 1000);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  const steps: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['year', 365 * 86400],
    ['month', 30 * 86400],
    ['week', 7 * 86400],
    ['day', 86400],
    ['hour', 3600],
    ['minute', 60],
  ];
  for (const [unit, size] of steps) {
    if (Math.abs(seconds) >= size) return rtf.format(Math.round(seconds / size), unit);
  }
  return rtf.format(0, 'minute');
}
