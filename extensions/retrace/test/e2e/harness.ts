/**
 * Shared pieces of the end-to-end run and the benchmark:
 *
 * - a logging HTTP proxy that is the browser's *only* route to the network
 *   (`--proxy-server`, loopback included). It serves fixture pages for
 *   `*.test` hosts and refuses everything else, recording every request, so
 *   "no request left the machine" is checked against the full list of
 *   network requests Chromium attempted, from every context (pages, service
 *   worker, offscreen document, workers);
 * - launching Playwright's Chromium with the unpacked extension (new headless);
 * - calling the extension's service worker from one of its pages.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { readdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium, type BrowserContext, type Page } from 'playwright';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DIST = join(ROOT, 'dist');
export const OUT = join(ROOT, 'test', 'e2e', '.out');

export interface ProxyLogEntry {
  method: string;
  url: string;
  served: boolean;
}

export interface Proxy {
  port: number;
  log: ProxyLogEntry[];
  /** Replace or add pages: absolute URL (`http://host/path`) → HTML. */
  pages: Map<string, string>;
  close(): Promise<void>;
}

export async function startProxy(pages: Map<string, string>): Promise<Proxy> {
  const log: ProxyLogEntry[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? '';
    const html = pages.get(url.replace(/\?.*$/, ''));
    const isTestHost = /^http:\/\/[a-z0-9.-]+\.test(\/|$)/.test(url);
    if (html !== undefined) {
      log.push({ method: req.method ?? '?', url, served: true });
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }
    log.push({ method: req.method ?? '?', url, served: false });
    // Fixture hosts 404 for anything else (favicon...); the rest of the world is refused.
    res.writeHead(isTestHost ? 404 : 403, { 'content-type': 'text/plain' });
    res.end(isTestHost ? 'not found' : 'blocked by the retrace e2e proxy');
  });
  server.on('connect', (req: IncomingMessage, socket: Socket) => {
    log.push({ method: 'CONNECT', url: req.url ?? '', served: false });
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
  });
  server.on('connection', (s: Socket) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    log,
    pages,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}

export async function launch(profileDir: string, proxyPort: number, extraArgs: string[] = []): Promise<BrowserContext> {
  return chromium.launchPersistentContext(profileDir, {
    channel: 'chromium', // full Chromium in new headless mode: extensions load
    headless: true,
    args: [
      `--disable-extensions-except=${DIST}`,
      `--load-extension=${DIST}`,
      `--proxy-server=http://127.0.0.1:${proxyPort}`,
      // Route loopback through the proxy too, so nothing bypasses the log.
      '--proxy-bypass-list=<-loopback>',
      ...extraArgs,
    ],
  });
}

export async function extensionId(context: BrowserContext): Promise<string> {
  let [worker] = context.serviceWorkers();
  worker ??= await context.waitForEvent('serviceworker', { timeout: 30_000 });
  const match = /^chrome-extension:\/\/([a-p]{32})\//.exec(worker.url());
  if (!match?.[1]) throw new Error(`unexpected service worker url ${worker.url()}`);
  return match[1];
}

/** Send a request to the service worker from an extension page, as the UI does. */
export async function bg<T>(page: Page, req: Record<string, unknown>): Promise<T> {
  const reply = await page.evaluate(
    (r) => chrome.runtime.sendMessage({ to: 'background', req: r }),
    req,
  );
  const typed = reply as { ok: boolean; result?: T; error?: string } | undefined;
  if (!typed?.ok) throw new Error(`background ${String(req.kind)} failed: ${typed?.error ?? 'no reply'}`);
  return typed.result as T;
}

export async function dirSize(dir: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    total += entry.isDirectory() ? await dirSize(p) : (await stat(p)).size;
  }
  return total;
}

export function mb(bytes: number | null | undefined): string {
  return bytes == null ? 'n/a' : `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
