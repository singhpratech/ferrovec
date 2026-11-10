/**
 * Turn ranked passages into ranked pages: one result per URL, scored by its
 * best passage, which also becomes the snippet. Plus the client-side filters
 * and the link to the passage.
 */

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
