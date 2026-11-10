import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { RealPage } from './pages.ts';

export const CACHE = join(dirname(fileURLToPath(import.meta.url)), '.cache');
export const RESULTS = join(dirname(fileURLToPath(import.meta.url)), '.results');

export function cachePath(page: RealPage): string {
  return join(CACHE, `${page.id}.html`);
}
