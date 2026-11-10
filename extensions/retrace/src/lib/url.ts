/**
 * URL normalisation for bookkeeping keys: one page, one entry, however it was
 * reached. Strips the fragment and common tracking parameters and sorts what
 * is left; only http(s) URLs are indexable.
 */

/** Exact query-parameter names that only track the visit, never select content. */
const TRACKING_PARAMS = new Set([
  'fbclid',
  'gclid',
  'gclsrc',
  'dclid',
  'gbraid',
  'wbraid',
  'msclkid',
  'yclid',
  'twclid',
  'ttclid',
  'li_fat_id',
  'igshid',
  'mc_cid',
  'mc_eid',
  '_hsenc',
  '_hsmi',
  'mkt_tok',
  'oly_anon_id',
  'oly_enc_id',
  'vero_id',
  'ref_src',
  'ref_url',
  's_cid',
  '_ga',
  '_gl',
]);

/** Query-parameter prefixes that only track the visit. */
const TRACKING_PREFIXES = ['utm_', 'pk_', 'mtm_'];

export function isTrackingParam(name: string): boolean {
  const lower = name.toLowerCase();
  return TRACKING_PARAMS.has(lower) || TRACKING_PREFIXES.some((p) => lower.startsWith(p));
}

/**
 * Normalise `raw` for use as a page key, or return `null` when it is not an
 * http(s) URL. Lower-cases the host (and drops a default port, via `URL`),
 * removes the fragment and tracking parameters, and sorts the remaining query
 * parameters so their order does not create duplicate pages.
 */
export function normalizeUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  url.hash = '';
  url.username = '';
  url.password = '';
  const kept = [...url.searchParams].filter(([name]) => !isTrackingParam(name));
  kept.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  url.search = '';
  for (const [name, value] of kept) url.searchParams.append(name, value);
  return url.href;
}

/** The host (no port) of an http(s) URL, lower-cased; `''` when it does not parse. */
export function hostOf(raw: string): string {
  try {
    return new URL(raw).hostname.toLowerCase();
  } catch {
    return '';
  }
}
