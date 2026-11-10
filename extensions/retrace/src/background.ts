/**
 * Service worker: routing, privacy rules, omnibox, settings, toolbar.
 * Holds no index state; the store lives in the store host (see platform/).
 */

import { isBlocked } from './lib/blocklist.ts';
import { getPage, touchPage } from './lib/bookkeeping.ts';
import { omniboxSuggestions } from './lib/group.ts';
import { sha256Hex, urlHash } from './lib/hash.ts';
import { MAX_TEXT_CHARS, MIN_TEXT_CHARS } from './lib/settings.ts';
import { hostOf, normalizeUrl } from './lib/url.ts';
import type { BackgroundRequest, ExtractedPage, Hit, IndexJob, PageOutcome } from './lib/types.ts';
import {
  callHost,
  loadSettings,
  onBackgroundRequest,
  onBrowserStart,
  onSettingsChanged,
  onToolbarClick,
  openUrl,
  reapClosedHost,
  registerOmnibox,
  saveSettings,
  searchPageUrl,
  showPausedBadge,
  type SenderInfo,
} from './platform/index.ts';

/** Passages fetched per search; grouping by page and the UI filters work on these. */
const SEARCH_K = 60;
const OMNIBOX_K = 30;
const OMNIBOX_SUGGESTIONS = 5;

async function handlePage(page: ExtractedPage, sender: SenderInfo): Promise<PageOutcome> {
  if (sender.incognito) return { status: 'skipped', reason: 'incognito' };
  const settings = await loadSettings();
  if (settings.paused) return { status: 'skipped', reason: 'paused' };
  const url = normalizeUrl(page.url);
  if (!url) return { status: 'skipped', reason: 'not-http' };
  if (isBlocked(url, settings.blocklist)) return { status: 'skipped', reason: 'blocked' };
  const text = page.text.slice(0, MAX_TEXT_CHARS);
  if (text.length < MIN_TEXT_CHARS) return { status: 'skipped', reason: 'too-short' };

  const textHash = await sha256Hex(text);
  const visitedAt = new Date().toISOString();
  const title = page.title.trim().slice(0, 300) || url;

  // Unchanged revisit: bump the visit time, never touch the vectors (and do
  // not wake the store host).
  const known = await getPage(url);
  if (known && known.hash === textHash) {
    await touchPage(url, visitedAt, title);
    return { status: 'unchanged' };
  }

  const job: IndexJob = {
    url,
    urlHash: await urlHash(url),
    host: hostOf(url),
    title,
    text,
    textHash,
    visitedAt,
  };
  await callHost({ op: 'index', job });
  return { status: 'queued' };
}

async function search(q: string, k: number): Promise<Hit[]> {
  return callHost<Hit[]>({ op: 'search', q, k });
}

async function handle(req: BackgroundRequest, sender: SenderInfo): Promise<unknown> {
  // Only `page` may come from a web page's content script; everything else
  // is for Retrace's own pages.
  if (sender.fromWebPage && req.kind !== 'page') throw new Error(`refused ${req.kind} from a web page`);
  switch (req.kind) {
    case 'page':
      return handlePage(req.page, sender).catch((err: unknown) => {
        console.error('[retrace] could not queue page', req.page.url, err);
        throw err;
      });
    case 'search':
      return search(req.q, req.k ?? SEARCH_K);
    case 'stats':
      return callHost({ op: 'stats' });
    case 'status':
      return callHost({ op: 'status' });
    case 'pages':
      return callHost({ op: 'pages', limit: req.limit ?? 50 });
    case 'forget-host':
      return callHost({ op: 'forget-host', host: req.host });
    case 'forget-since':
      return callHost({ op: 'forget-since', since: req.since });
    case 'delete-all':
      return callHost({ op: 'delete-all' });
    case 'export':
      return callHost({ op: 'export' });
    case 'wait-idle':
      return callHost({ op: 'wait-idle', timeoutMs: req.timeoutMs ?? 60_000 });
    case 'get-settings':
      return loadSettings();
    case 'set-settings':
      return saveSettings(req.patch);
    case 'host-closed':
      await reapClosedHost();
      return true;
  }
}

onBackgroundRequest(handle);

registerOmnibox({
  async suggest(text) {
    if (text.trim().length < 2) return [];
    // Strong matches only: a weak one is not worth an address-bar slot.
    return omniboxSuggestions(await search(text, OMNIBOX_K), text, OMNIBOX_SUGGESTIONS);
  },
  enter(text, disposition) {
    const target = /^https?:\/\//i.test(text.trim()) ? text.trim() : searchPageUrl(text.trim());
    void openUrl(target, disposition);
  },
});

onToolbarClick(() => void openUrl(searchPageUrl()));

const refreshBadge = (): void => {
  void loadSettings().then((s) => showPausedBadge(s.paused));
};
onBrowserStart(refreshBadge);
onSettingsChanged((s) => void showPausedBadge(s.paused));
refreshBadge();
