/**
 * Render static/icons/icon.svg to the PNG sizes the manifest uses.
 *
 * Run `node tools/make-icons.ts` after changing the drawing; the PNGs are
 * committed, so a normal build does not need a browser.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'static', 'icons');
const svg = readFileSync(join(dir, 'icon.svg'), 'utf8');

const browser = await chromium.launch();
for (const size of [16, 32, 48, 128]) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(
    `<body style="margin:0;background:transparent"><div style="width:${size}px;height:${size}px">${svg}</div>`,
  );
  await page.screenshot({ path: join(dir, `icon-${size}.png`), omitBackground: true });
  await page.close();
}
await browser.close();
