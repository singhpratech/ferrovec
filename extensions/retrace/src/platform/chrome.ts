/**
 * Everything Chrome-specific in Retrace: the `chrome.*` calls and where the
 * store host lives. On Chrome (and Edge/Brave) the store host is an offscreen
 * document; a Firefox port would replace this one file with one that runs the
 * store host in its background page and maps these functions onto `browser.*`.
 *
 * Every other module is platform-neutral and talks to the browser only through
 * the functions exported here (re-exported by `./index.ts`).
 */

import { withDefaults } from '../lib/settings.ts';
import type { BackgroundRequest, HostRequest, Reply, Settings } from '../lib/types.ts';

// ---------------------------------------------------------------------------
// Messaging envelope
// ---------------------------------------------------------------------------

/** Messages are broadcast to every extension context; `to` says who answers. */
type Envelope = { to: 'background'; req: BackgroundRequest } | { to: 'host'; req: HostRequest };

export class RemoteError extends Error {}

function unwrap<T>(reply: Reply<T> | undefined, what: string): T {
  if (reply === undefined) throw new RemoteError(`${what}: no response`);
  if (reply.ok) return reply.result;
  const error = new RemoteError(reply.error);
  if (reply.name) error.name = reply.name;
  throw error;
}

function toReply(err: unknown): Reply<never> {
  return err instanceof Error
    ? { ok: false, error: err.message, name: err.name }
    : { ok: false, error: String(err) };
}

/** Who sent a request to the background, as far as the privacy rules care. */
export interface SenderInfo {
  /** The sending tab is incognito (never true when incognito is "not_allowed"). */
  incognito: boolean;
  /** Sent by a content script in a web page (not by an extension page). */
  fromWebPage: boolean;
}

/** UI pages and the content script → service worker. */
export async function sendToBackground<T>(req: BackgroundRequest): Promise<T> {
  const envelope: Envelope = { to: 'background', req };
  return unwrap<T>(await chrome.runtime.sendMessage(envelope), req.kind);
}

/** Service worker: answer {@link sendToBackground}. */
export function onBackgroundRequest(
  handler: (req: BackgroundRequest, sender: SenderInfo) => Promise<unknown>,
): void {
  chrome.runtime.onMessage.addListener((message: Envelope, sender, sendResponse) => {
    if (message?.to !== 'background') return false;
    const info: SenderInfo = {
      incognito: sender.tab?.incognito === true,
      fromWebPage: sender.tab !== undefined && !(sender.url ?? '').startsWith(chrome.runtime.getURL('')),
    };
    handler(message.req, info).then(
      (result) => sendResponse({ ok: true, result } satisfies Reply),
      (err: unknown) => sendResponse(toReply(err)),
    );
    return true;
  });
}

// ---------------------------------------------------------------------------
// The store host: an offscreen document on Chrome
// ---------------------------------------------------------------------------

const OFFSCREEN_PATH = 'offscreen.html';
/** Error name the host answers with while it is shutting down or shut. */
export const HOST_CLOSED = 'HostClosedError';

let creating: Promise<void> | null = null;

async function hostExists(): Promise<boolean> {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT' as chrome.runtime.ContextType],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)],
  });
  return contexts.length > 0;
}

async function ensureHost(): Promise<void> {
  if (await hostExists()) return;
  creating ??= chrome.offscreen
    .createDocument({
      url: OFFSCREEN_PATH,
      reasons: ['WORKERS' as chrome.offscreen.Reason],
      justification:
        'Hosts the local search index: a Web Worker that embeds page text and stores it in OPFS.',
    })
    .catch((err: unknown) => {
      // Lost a creation race with another caller: the document exists, which is fine.
      if (!String(err).includes('single offscreen')) throw err;
    })
    .finally(() => {
      creating = null;
    });
  await creating;
}

async function closeHost(): Promise<void> {
  if (await hostExists()) {
    await chrome.offscreen.closeDocument().catch(() => {
      /* already gone */
    });
  }
}

/**
 * Service worker → store host. Creates the offscreen document on demand. If
 * the host has just shut itself down for idleness (or vanished), it is
 * recreated and the request retried.
 */
export async function callHost<T>(req: HostRequest): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    await ensureHost();
    let reply: Reply<T> | undefined;
    try {
      const envelope: Envelope = { to: 'host', req };
      reply = await chrome.runtime.sendMessage(envelope);
    } catch (err) {
      // "Receiving end does not exist": the document is still loading or just closed.
      lastError = err;
      await new Promise((r) => setTimeout(r, 100 * (attempt + 1)));
      continue;
    }
    if (reply && !reply.ok && reply.name === HOST_CLOSED) {
      lastError = new RemoteError(reply.error);
      await closeHost();
      continue;
    }
    return unwrap(reply, `host ${req.op}`);
  }
  throw lastError instanceof Error ? lastError : new RemoteError(`host ${req.op} failed`);
}

/** Service worker: the host reported it shut down; close its document if it is still the shut one. */
export async function reapClosedHost(): Promise<void> {
  if (!(await hostExists())) return;
  try {
    const envelope: Envelope = { to: 'host', req: { op: 'ping' } };
    const reply = (await chrome.runtime.sendMessage(envelope)) as Reply<{ closed: boolean }> | undefined;
    if (reply?.ok && reply.result.closed) await closeHost();
  } catch {
    /* gone already */
  }
}

/** Store host context: answer {@link callHost}. */
export function serveHost(handler: (req: HostRequest) => Promise<unknown>): void {
  chrome.runtime.onMessage.addListener((message: Envelope, _sender, sendResponse) => {
    if (message?.to !== 'host') return false;
    handler(message.req).then(
      (result) => sendResponse({ ok: true, result } satisfies Reply),
      (err: unknown) => sendResponse(toReply(err)),
    );
    return true;
  });
}

/** Store host context: tell the service worker the host has shut down and can be reaped. */
export function notifyHostClosed(): void {
  const envelope: Envelope = { to: 'background', req: { kind: 'host-closed' } };
  chrome.runtime.sendMessage(envelope).catch(() => {
    /* the service worker reaps it on the next call instead */
  });
}

// ---------------------------------------------------------------------------
// Settings (chrome.storage.local)
// ---------------------------------------------------------------------------

const SETTINGS_KEY = 'settings';

export async function loadSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  return withDefaults(stored[SETTINGS_KEY] as Partial<Settings> | undefined);
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await loadSettings()), ...patch };
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

export function onSettingsChanged(callback: (settings: Settings) => void): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !(SETTINGS_KEY in changes)) return;
    callback(withDefaults(changes[SETTINGS_KEY]?.newValue as Partial<Settings> | undefined));
  });
}

// ---------------------------------------------------------------------------
// Toolbar, tabs, omnibox, lifecycle
// ---------------------------------------------------------------------------

export function searchPageUrl(query?: string): string {
  const base = chrome.runtime.getURL('search.html');
  return query ? `${base}?q=${encodeURIComponent(query)}` : base;
}

export type Disposition = 'currentTab' | 'newForegroundTab' | 'newBackgroundTab';

export async function openUrl(url: string, disposition: Disposition = 'newForegroundTab'): Promise<void> {
  if (disposition === 'currentTab') {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id !== undefined) {
      await chrome.tabs.update(tab.id, { url });
      return;
    }
  }
  await chrome.tabs.create({ url, active: disposition !== 'newBackgroundTab' });
}

export async function showPausedBadge(paused: boolean): Promise<void> {
  await chrome.action.setBadgeText({ text: paused ? 'off' : '' });
  await chrome.action.setBadgeBackgroundColor({ color: '#6b6b6b' });
  await chrome.action.setTitle({
    title: paused ? 'Retrace (indexing paused)' : 'Retrace: search what you have read',
  });
}

export function onToolbarClick(callback: () => void): void {
  chrome.action.onClicked.addListener(() => callback());
}

export function onBrowserStart(callback: () => void): void {
  chrome.runtime.onStartup.addListener(callback);
  chrome.runtime.onInstalled.addListener(callback);
}

export interface OmniboxSuggestion {
  /** What Enter on this suggestion hands back (a URL to open). */
  content: string;
  /** Plain text title and snippet; markup is applied here. */
  title: string;
  detail: string;
}

function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export function registerOmnibox(handlers: {
  suggest: (text: string) => Promise<OmniboxSuggestion[]>;
  enter: (text: string, disposition: Disposition) => void;
}): void {
  chrome.omnibox.setDefaultSuggestion({
    description: 'Search what you have read: <match>%s</match> (Enter for all results)',
  });
  let latest = 0;
  chrome.omnibox.onInputChanged.addListener((text, suggest) => {
    const ticket = ++latest;
    handlers.suggest(text).then(
      (suggestions) => {
        if (ticket !== latest) return; // a newer keystroke superseded this one
        suggest(
          suggestions.map((s) => ({
            content: s.content,
            description: `<match>${escapeXml(s.title)}</match> <dim>${escapeXml(s.detail)}</dim>`,
          })),
        );
      },
      () => {
        /* no suggestions while the index is unavailable */
      },
    );
  });
  chrome.omnibox.onInputEntered.addListener((text, disposition) => {
    handlers.enter(text, disposition as Disposition);
  });
}
