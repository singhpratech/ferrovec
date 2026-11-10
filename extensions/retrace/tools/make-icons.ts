/**
 * Draws Retrace's toolbar/store icons (a looping arrow on a rounded square)
 * into static/icons/icon-{16,32,48,128}.png. No dependencies: shapes are
 * rasterised with 4x4 supersampling and written as RGBA PNGs with node:zlib.
 * Run `node tools/make-icons.ts` after changing the drawing; the PNGs are
 * committed.
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const BG = [0x2f, 0x5d, 0x50];
const FG = [0xf6, 0xf3, 0xec];

type Vec = [number, number];

function insideRoundRect(x: number, y: number, r: number): boolean {
  const qx = Math.abs(x - 0.5) - (0.5 - r);
  const qy = Math.abs(y - 0.5) - (0.5 - r);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  return outside + Math.min(Math.max(qx, qy), 0) - r <= 0;
}

function insideTriangle(p: Vec, a: Vec, b: Vec, c: Vec): boolean {
  const s = (p1: Vec, p2: Vec, p3: Vec): number =>
    (p1[0] - p3[0]) * (p2[1] - p3[1]) - (p2[0] - p3[0]) * (p1[1] - p3[1]);
  const d1 = s(p, a, b);
  const d2 = s(p, b, c);
  const d3 = s(p, c, a);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

/** Foreground coverage test in unit coordinates (y down). */
function foreground(x: number, y: number, size: number): boolean {
  const c: Vec = [0.5, 0.52];
  const R = 0.27;
  const t = size <= 16 ? 0.13 : 0.1;
  const dx = x - c[0];
  const dy = y - c[1];
  const angle = (Math.atan2(dy, dx) * 180) / Math.PI; // -180..180, 0 = right, -90 = up
  const onRing = Math.abs(Math.hypot(dx, dy) - R) <= t / 2;
  const inGap = angle > -95 && angle < -25;
  if (onRing && !inGap) return true;
  // Arrowhead at the gap's upper end (-95°), pointing anticlockwise (back).
  const a = (-95 * Math.PI) / 180;
  const p: Vec = [c[0] + R * Math.cos(a), c[1] + R * Math.sin(a)];
  const tangent: Vec = [Math.sin(a), -Math.cos(a)]; // direction of decreasing angle
  const normal: Vec = [Math.cos(a), Math.sin(a)];
  const w = t * 1.35;
  const tip: Vec = [p[0] - tangent[0] * t * 1.5, p[1] - tangent[1] * t * 1.5];
  const b1: Vec = [p[0] + normal[0] * w + tangent[0] * t * 0.4, p[1] + normal[1] * w + tangent[1] * t * 0.4];
  const b2: Vec = [p[0] - normal[0] * w + tangent[0] * t * 0.4, p[1] - normal[1] * w + tangent[1] * t * 0.4];
  return insideTriangle([x, y], tip, b1, b2);
}

function render(size: number): Buffer {
  const SS = 4;
  const rows: Buffer[] = [];
  for (let py = 0; py < size; py++) {
    const row = Buffer.alloc(1 + size * 4);
    row[0] = 0; // filter: none
    for (let px = 0; px < size; px++) {
      let bg = 0;
      let fg = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (px + (sx + 0.5) / SS) / size;
          const y = (py + (sy + 0.5) / SS) / size;
          if (!insideRoundRect(x, y, 0.22)) continue;
          // Mirrored: the arrow loops back (anticlockwise), not "reload".
          if (foreground(1 - x, y, size)) fg++;
          else bg++;
        }
      }
      const total = SS * SS;
      const alpha = (bg + fg) / total;
      const mix = bg + fg === 0 ? 0 : fg / (bg + fg);
      const o = 1 + px * 4;
      for (let ch = 0; ch < 3; ch++) row[o + ch] = Math.round(BG[ch]! * (1 - mix) + FG[ch]! * mix);
      row[o + 3] = Math.round(alpha * 255);
    }
    rows.push(row);
  }
  return encodePng(size, size, Buffer.concat(rows));
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(width: number, height: number, raw: Buffer): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const outDir = join(root, 'static', 'icons');
await mkdir(outDir, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  await writeFile(join(outDir, `icon-${size}.png`), render(size));
}
console.log(`icons written to ${outDir}`);
