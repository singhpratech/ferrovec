/** The search page: search, filters, and the privacy controls. Plain DOM. */

import { DEFAULT_BLOCKLIST } from '../lib/blocklist.ts';
import {
  filterResults,
  groupHits,
  passageLink,
  relativeTime,
  snippetFor,
  splitByStrength,
  TIME_RANGES,
  type PageResult,
} from '../lib/group.ts';
import type { ExportData, ForgetResult, Hit, PageRecord, Settings, Stats } from '../lib/types.ts';
import { sendToBackground } from '../platform/index.ts';

const K_PLAIN = 60;
const K_FILTERED = 200;

function $<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing`);
  return el as T;
}

const qInput = $<HTMLInputElement>('q');
const hostSelect = $<HTMLSelectElement>('filter-host');
const timeSelect = $<HTMLSelectElement>('filter-time');
const statusEl = $<HTMLParagraphElement>('status');
const resultsEl = $<HTMLOListElement>('results');
const weakEl = $<HTMLOListElement>('weak-results');
const weakerEl = $<HTMLDetailsElement>('weaker');
const weakerSummary = $<HTMLElement>('weaker-summary');
const noStrongEl = $<HTMLParagraphElement>('no-strong');
const resultsHeading = $<HTMLHeadingElement>('results-heading');
const emptyEl = $<HTMLParagraphElement>('empty');
const template = $<HTMLTemplateElement>('result-template');

let lastResults: PageResult[] = [];
let searchSeq = 0;

function formatBytes(n: number | null): string {
  if (n === null) return 'n/a';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/** Fill `list` with result items; the snippet starts at (and marks) the sentence matching `query`. */
function renderList(list: HTMLOListElement, results: PageResult[], query: string): void {
  list.replaceChildren();
  for (const r of results) {
    const node = template.content.firstElementChild!.cloneNode(true) as HTMLLIElement;
    const snippet = snippetFor(r.snippet, query);
    const link = node.querySelector<HTMLAnchorElement>('.title')!;
    link.textContent = r.title || r.url;
    // Scroll to (and highlight) the marked sentence, or the passage start.
    link.href = passageLink(r.url, snippet.mark || r.snippet);
    link.title = r.url;
    node.querySelector('.host')!.textContent = r.host;
    const when = node.querySelector<HTMLElement>('.when')!;
    when.textContent = relativeTime(r.visitedAt);
    when.title = new Date(r.visitedAt).toLocaleString();
    node.querySelector('.more')!.textContent =
      r.matches > 1 ? `${r.matches} matching passages` : '';
    // Page text goes in as text nodes only, never as markup.
    const p = node.querySelector<HTMLParagraphElement>('.snippet')!;
    p.replaceChildren();
    if (r.snippet) {
      if (snippet.lead) p.append('… ');
      if (snippet.mark) {
        const mark = document.createElement('mark');
        mark.textContent = snippet.mark;
        p.append(mark);
      }
      p.append(snippet.rest);
      if (snippet.cut) p.append('…');
    }
    node.dataset.url = r.url;
    node.dataset.host = r.host;
    node.dataset.score = r.score.toFixed(3);
    node.querySelector<HTMLButtonElement>('.forget-link')!.addEventListener('click', () => {
      void forgetHost(r.host);
    });
    list.append(node);
  }
}

/**
 * Show search results: strong matches as results, weak ones behind a
 * disclosure (collapsed, or open as "nearest pages" when nothing is strong),
 * and a plain statement when nothing is strong.
 */
function renderSearch(results: PageResult[], query: string): void {
  const { strong, weak } = splitByStrength(results, query);
  resultsHeading.textContent = 'Results';
  renderList(resultsEl, strong, query);
  renderList(weakEl, weak, query);
  noStrongEl.hidden = strong.length > 0 || weak.length === 0;
  weakerEl.hidden = weak.length === 0;
  // With no close match the nearest pages are the whole answer, so show them.
  weakerEl.open = strong.length === 0;
  weakerSummary.textContent =
    strong.length === 0
      ? `Nearest ${weak.length === 1 ? 'page' : `${weak.length} pages`}`
      : `${weak.length} weaker match${weak.length === 1 ? '' : 'es'}`;
  emptyEl.hidden = results.length > 0;
  emptyEl.textContent = 'Nothing you have read matches that yet.';
}

/** Show a plain list (recently read pages, or an error). */
function renderPlain(results: PageResult[], heading: string, emptyText: string): void {
  resultsHeading.textContent = heading;
  renderList(resultsEl, results, '');
  weakEl.replaceChildren();
  weakerEl.hidden = true;
  noStrongEl.hidden = true;
  emptyEl.hidden = results.length > 0;
  emptyEl.textContent = emptyText;
}

function refreshHostOptions(results: PageResult[]): void {
  const current = hostSelect.value;
  const hosts = [...new Set(results.map((r) => r.host))].sort();
  if (current && !hosts.includes(current)) hosts.unshift(current);
  hostSelect.replaceChildren(new Option('All sites', ''), ...hosts.map((h) => new Option(h, h)));
  hostSelect.value = current;
}

function filtered(): PageResult[] {
  const range = TIME_RANGES[timeSelect.value];
  return filterResults(lastResults, {
    ...(hostSelect.value ? { host: hostSelect.value } : {}),
    ...(range !== undefined ? { since: Date.now() - range } : {}),
  });
}

async function runSearch(): Promise<void> {
  const q = qInput.value.trim();
  const seq = ++searchSeq;
  const url = new URL(location.href);
  if (q) url.searchParams.set('q', q);
  else url.searchParams.delete('q');
  history.replaceState(null, '', url);
  if (!q) {
    await showRecent();
    return;
  }
  document.body.dataset.state = 'searching';
  const filtering = hostSelect.value !== '' || timeSelect.value !== 'any';
  const started = performance.now();
  try {
    const hits = await sendToBackground<Hit[]>({ kind: 'search', q, k: filtering ? K_FILTERED : K_PLAIN });
    if (seq !== searchSeq) return;
    lastResults = groupHits(hits);
    refreshHostOptions(lastResults);
    const shown = filtered();
    renderSearch(shown, q);
    const close = splitByStrength(shown, q).strong.length;
    statusEl.textContent = `${close} close match${close === 1 ? '' : 'es'} in ${Math.round(performance.now() - started)} ms`;
  } catch (err) {
    if (seq !== searchSeq) return;
    renderPlain([], 'Results', `Search failed: ${(err as Error).message}`);
  } finally {
    if (seq === searchSeq) document.body.dataset.state = 'ready';
  }
}

async function showRecent(): Promise<void> {
  try {
    const pages = await sendToBackground<PageRecord[]>({ kind: 'pages', limit: 30 });
    lastResults = pages.map((p) => ({
      url: p.url,
      title: p.title,
      host: p.host,
      visitedAt: p.visitedAt,
      score: 0,
      snippet: '',
      chunk: 0,
      matches: 0,
    }));
    refreshHostOptions(lastResults);
    renderPlain(
      filtered(),
      'Recently read',
      'Nothing indexed yet. Read a few pages, then search for what you remember.',
    );
    statusEl.textContent = '';
  } catch (err) {
    renderPlain([], 'Recently read', `Could not load the index: ${(err as Error).message}`);
  } finally {
    document.body.dataset.state = 'ready';
  }
}

let debounce: ReturnType<typeof setTimeout> | undefined;
qInput.addEventListener('input', () => {
  clearTimeout(debounce);
  debounce = setTimeout(() => void runSearch(), 250);
});
$<HTMLFormElement>('search-form').addEventListener('submit', (event) => {
  event.preventDefault();
  clearTimeout(debounce);
  void runSearch();
});
hostSelect.addEventListener('change', () => void runSearch());
timeSelect.addEventListener('change', () => void runSearch());

// ---------------------------------------------------------------------------
// Privacy controls
// ---------------------------------------------------------------------------

async function refreshStats(): Promise<void> {
  try {
    const stats = await sendToBackground<Stats>({ kind: 'stats' });
    const set = (key: string, value: string): void => {
      const el = document.querySelector(`[data-stat="${key}"]`);
      if (el) el.textContent = value;
    };
    set('pages', stats.pages.toLocaleString());
    set('passages', stats.passages.toLocaleString());
    set('storeBytes', formatBytes(stats.storeBytes));
    set('usageBytes', formatBytes(stats.usageBytes));
  } catch {
    /* leave the dashes */
  }
}

async function refreshSettings(): Promise<void> {
  const settings = await sendToBackground<Settings>({ kind: 'get-settings' });
  renderPaused(settings.paused);
  $<HTMLTextAreaElement>('blocklist').value = settings.blocklist.join('\n');
}

function renderPaused(paused: boolean): void {
  $<HTMLButtonElement>('pause').textContent = paused ? 'Resume indexing' : 'Pause indexing';
  $<HTMLButtonElement>('pause').dataset.paused = String(paused);
  $<HTMLParagraphElement>('pause-state').textContent = paused
    ? 'Paused. New pages are not indexed until you resume.'
    : 'Pages you read are being indexed.';
  document.body.classList.toggle('paused', paused);
}

$<HTMLButtonElement>('pause').addEventListener('click', async () => {
  const paused = $<HTMLButtonElement>('pause').dataset.paused !== 'true';
  const settings = await sendToBackground<Settings>({ kind: 'set-settings', patch: { paused } });
  renderPaused(settings.paused);
});

async function saveBlocklist(lines: string[]): Promise<void> {
  const settings = await sendToBackground<Settings>({ kind: 'set-settings', patch: { blocklist: lines } });
  $<HTMLTextAreaElement>('blocklist').value = settings.blocklist.join('\n');
  $<HTMLSpanElement>('blocklist-note').textContent = 'Saved.';
}

$<HTMLButtonElement>('blocklist-save').addEventListener('click', () => {
  const lines = $<HTMLTextAreaElement>('blocklist')
    .value.split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  void saveBlocklist(lines);
});
$<HTMLButtonElement>('blocklist-reset').addEventListener('click', () => {
  void saveBlocklist([...DEFAULT_BLOCKLIST]);
});

const forgetNote = $<HTMLParagraphElement>('forget-note');

function reportForget(what: string, result: ForgetResult): void {
  forgetNote.textContent = `${what}: removed ${result.pages} page${result.pages === 1 ? '' : 's'} and ${result.passages} passage${result.passages === 1 ? '' : 's'}.`;
}

async function afterForget(): Promise<void> {
  await Promise.all([refreshStats(), runSearch()]);
}

async function forgetHost(host: string): Promise<void> {
  const clean = host.trim().toLowerCase();
  if (!clean) return;
  forgetNote.textContent = `Forgetting ${clean}…`;
  try {
    const result = await sendToBackground<ForgetResult>({ kind: 'forget-host', host: clean });
    reportForget(`Forgot ${clean}`, result);
    await afterForget();
  } catch (err) {
    forgetNote.textContent = `Could not forget ${clean}: ${(err as Error).message}`;
  }
}

$<HTMLFormElement>('forget-site-form').addEventListener('submit', (event) => {
  event.preventDefault();
  void forgetHost($<HTMLInputElement>('forget-host').value);
});

$<HTMLButtonElement>('forget-hour').addEventListener('click', async () => {
  forgetNote.textContent = 'Forgetting the last hour…';
  const since = new Date(Date.now() - 3600_000).toISOString();
  try {
    reportForget('Forgot the last hour', await sendToBackground<ForgetResult>({ kind: 'forget-since', since }));
    await afterForget();
  } catch (err) {
    forgetNote.textContent = `Could not forget: ${(err as Error).message}`;
  }
});

$<HTMLButtonElement>('delete-all').addEventListener('click', async () => {
  if (!confirm('Delete every page and passage Retrace has stored? This cannot be undone.')) return;
  forgetNote.textContent = 'Deleting everything…';
  try {
    reportForget('Deleted everything', await sendToBackground<ForgetResult>({ kind: 'delete-all' }));
    await afterForget();
  } catch (err) {
    forgetNote.textContent = `Could not delete: ${(err as Error).message}`;
  }
});

$<HTMLButtonElement>('export').addEventListener('click', async () => {
  const data = await sendToBackground<ExportData>({ kind: 'export' });
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `retrace-export-${data.exportedAt.slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const initial = new URL(location.href).searchParams.get('q') ?? '';
qInput.value = initial;
document.body.dataset.state = 'loading';
void refreshSettings();
void refreshStats();
void runSearch();
