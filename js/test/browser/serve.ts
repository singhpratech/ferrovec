/**
 * Shared fixture server for the browser tests.
 *
 * Bundles the fake-embedder worker (`opfs.worker.ts`, which drives the *real*
 * coordinator/persistence/snapshot/engine/wasm code) with esbuild, places the
 * wasm blob alongside it, and serves the lot over `http://localhost` — a secure
 * context, so OPFS sync access **and** the Web Locks API are enabled. Used by
 * both `opfs.test.ts` (persistence round-trip + same-page election) and
 * `coord.test.ts` (two-page cross-tab coordination + failover).
 */

import { createServer, type Server } from 'node:http';
import { mkdtemp, writeFile, copyFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';

const here = dirname(fileURLToPath(import.meta.url));

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
};

const INDEX_HTML =
  '<!doctype html><html><head><meta charset="utf-8"><title>ferrovec</title></head><body>ok</body></html>';

export interface Fixture {
  server: Server;
  origin: string;
  dir: string;
}

/** Bundle the worker + assets into a temp dir and serve it over localhost. */
export async function serveFixture(): Promise<Fixture> {
  const { build } = await import('esbuild');
  const dir = await mkdtemp(join(tmpdir(), 'ferrovec-opfs-'));

  await build({
    entryPoints: [join(here, 'opfs.worker.ts')],
    outfile: join(dir, 'opfs.worker.js'),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    // core-loader's Node branch dynamically imports these; the branch is dead in
    // a browser, so leave the (never-executed) imports unresolved rather than
    // failing the bundle.
    external: ['node:fs/promises', 'node:url'],
  });

  // The wasm glue fetches `ferrovec_bg.wasm` relative to the (bundled) worker
  // module URL, so place it alongside the worker bundle.
  await copyFile(join(here, '../../src/core/ferrovec_bg.wasm'), join(dir, 'ferrovec_bg.wasm'));
  await writeFile(join(dir, 'index.html'), INDEX_HTML);

  const server = createServer(async (req, res) => {
    try {
      const path = req.url === '/' || !req.url ? '/index.html' : req.url.split('?')[0]!;
      const body = await readFile(join(dir, path));
      res.setHeader('Content-Type', MIME[extname(path)] ?? 'application/octet-stream');
      res.end(body);
    } catch {
      res.statusCode = 404;
      res.end('not found');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return { server, origin: `http://localhost:${port}`, dir };
}
