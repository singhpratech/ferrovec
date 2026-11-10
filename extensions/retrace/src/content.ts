/**
 * Content script (http/https, top frame, document_idle): extract the page's
 * readable text and hand it to the service worker. Never blocks the page:
 * the work runs in an idle callback and the message is fire-and-forget.
 *
 * Skips pages that are paused, blocklisted, have a password field, are not
 * HTML, or have too little text. The service worker re-checks the rules.
 */

import { Readability } from '@mozilla/readability';

import { isBlocked } from './lib/blocklist.ts';
import { MAX_TEXT_CHARS, MIN_TEXT_CHARS } from './lib/settings.ts';
import type { Settings } from './lib/types.ts';
import { loadSettings, sendToBackground } from './platform/index.ts';

const BLOCK_TAGS = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'BR', 'DD', 'DIV', 'DL', 'DT', 'FIGCAPTION',
  'FIGURE', 'FOOTER', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'HR', 'LI', 'MAIN', 'NAV',
  'OL', 'P', 'PRE', 'SECTION', 'TABLE', 'TD', 'TH', 'TR', 'UL',
]);
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'IFRAME']);

/** Text of `root` with one paragraph per line (block elements break lines). */
function blockText(root: Node): string {
  const lines: string[] = [];
  let current = '';
  const flush = (): void => {
    const line = current.replace(/\s+/g, ' ').trim();
    if (line) lines.push(line);
    current = '';
  };
  const walk = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      current += node.textContent ?? '';
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const tag = (node as Element).tagName.toUpperCase();
    if (SKIP_TAGS.has(tag)) return;
    const block = BLOCK_TAGS.has(tag);
    if (block) flush();
    for (const child of node.childNodes) walk(child);
    if (block) flush();
  };
  walk(root);
  flush();
  return lines.join('\n');
}

function extract(): { title: string; text: string } {
  let title = document.title;
  let text = '';
  try {
    const article = new Readability(document.cloneNode(true) as Document).parse();
    if (article?.content) {
      const parsed = new DOMParser().parseFromString(article.content, 'text/html');
      text = blockText(parsed.body);
      if (article.title) title = article.title;
    }
  } catch {
    /* fall back below */
  }
  if (text.length < MIN_TEXT_CHARS) text = (document.body?.innerText ?? '').replace(/\n{2,}/g, '\n');
  return { title, text };
}

/**
 * Settings are read as soon as the script is injected, so that the work below
 * can run synchronously up to the point the message is posted: a tab closed
 * before the browser was idle still gets its page sent from `pagehide`.
 */
let settings: Settings | null = null;
const settingsReady = loadSettings().then((s) => {
  settings = s;
  return s;
});

/** Extract and post the page; synchronous once settings are known. */
function collectAndSend(current: Settings): void {
  if (location.protocol !== 'http:' && location.protocol !== 'https:') return;
  if (window.top !== window) return;
  if (!/html/i.test(document.contentType)) return;
  if (document.querySelector('input[type="password" i]')) return;
  if (current.paused || isBlocked(location.href, current.blocklist)) return;

  const { title, text } = extract();
  if (text.length < MIN_TEXT_CHARS) return;
  sendToBackground({
    kind: 'page',
    page: {
      url: location.href,
      title,
      text: text.slice(0, MAX_TEXT_CHARS),
      lang: document.documentElement.lang || '',
    },
  }).catch((err: unknown) => {
    // The extension was reloaded or the service worker is unavailable: skip this page.
    console.debug('[retrace] page not sent', err);
  });
}

let started = false;
const start = (): void => {
  if (started) return;
  started = true;
  if (settings) {
    collectAndSend(settings);
    return;
  }
  settingsReady.then(collectAndSend, (err: unknown) => console.debug('[retrace] no settings', err));
};
if ('requestIdleCallback' in window) requestIdleCallback(start, { timeout: 3000 });
else setTimeout(start, 500);
// A page closed or hidden before the browser was idle is still sent.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') start();
});
window.addEventListener('pagehide', start);
