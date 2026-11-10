/**
 * Download the real-content corpus (pages.ts) into test/relevance/.cache/
 * (gitignored), once. Pages already cached are skipped, so a measurement can be
 * re-run on exactly the same text; delete the cache to refresh it.
 *
 *   node test/relevance/fetch.ts
 */

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { CACHE, cachePath } from './cache.ts';
import { PAGES } from './pages.ts';

await mkdir(CACHE, { recursive: true });
const manifestPath = join(CACHE, 'manifest.json');
let manifest: Record<string, { url: string; fetchedAt: string; bytes: number }> = {};
try {
  manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
} catch {
  /* first run */
}

for (const page of PAGES) {
  const path = cachePath(page);
  if (await stat(path).then(() => true, () => false)) continue;
  const response = await fetch(page.url, {
    headers: { 'user-agent': 'retrace-relevance-measurement/0.1 (offline evaluation script)' },
  });
  if (!response.ok) {
    console.error(`FAILED ${page.url}: HTTP ${response.status}`);
    process.exitCode = 1;
    continue;
  }
  const html = await response.text();
  await writeFile(path, html);
  manifest[page.id] = { url: page.url, fetchedAt: new Date().toISOString(), bytes: html.length };
  console.log(`fetched ${page.id} (${(html.length / 1024).toFixed(0)} KiB)`);
  await new Promise((r) => setTimeout(r, 300)); // be polite
}
await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
console.log(`${Object.keys(manifest).length} pages cached in ${CACHE}`);
