/**
 * FVS2 snapshot framing: round-trip, CRC-32 vector, and the torn-write /
 * bit-flip fuzz that backs exit criterion (1) — any truncation or single-bit
 * corruption of a persisted snapshot is detected and never decodes to a wrong
 * index. Pure (no wasm): the core section is synthetic bytes.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { crc32, Crc32 } from '../src/crc32.ts';
import { SnapshotCorruptError } from '../src/errors.ts';
import { decodeSnapshot, encodeSnapshot, type SnapshotMeta } from '../src/snapshot.ts';

const META: SnapshotMeta = {
  embeddingSpace: { model: 'fake-fnv1a-32', dims: 32, metric: 'cosine' },
  count: 3,
  writer: 'ferrovec-js/test',
  createdAt: 1_700_000_000_000,
};

/** Tiny seeded PRNG (mulberry32) — deterministic fuzz without deps. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Synthetic core bytes starting with the core's own "FVEC" magic. */
function fakeCore(len: number, seed = 1): Uint8Array {
  const rand = mulberry32(seed);
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) out[i] = Math.floor(rand() * 256);
  out.set([0x46, 0x56, 0x45, 0x43], 0); // "FVEC"
  return out;
}

function assertCorrupt(fn: () => unknown, reason?: string, msg?: string): void {
  assert.throws(
    fn,
    (err: unknown) =>
      err instanceof SnapshotCorruptError &&
      err.name === 'SnapshotCorruptError' &&
      (reason === undefined || err.reason === reason),
    msg,
  );
}

/** A ~2 KB encoded snapshot. */
function sample2k(): Uint8Array {
  const texts = new Map<string, string>([
    ['a', 'the cat sat on the mat'],
    ['b', 'a feline napped on a rug'],
    ['c', 'quantum chromodynamics describes quarks'],
  ]);
  const bytes = encodeSnapshot(fakeCore(1700), texts, { sequence: 7n, meta: META });
  assert.ok(bytes.length >= 1900 && bytes.length <= 2200, `sample is ${bytes.length} bytes`);
  return bytes;
}

test('crc32: IEEE check vector "123456789" → 0xCBF43926 (one-shot and streaming)', () => {
  const input = new TextEncoder().encode('123456789');
  assert.equal(crc32(input), 0xcbf43926);
  assert.equal(new Crc32().update(input.subarray(0, 4)).update(input.subarray(4)).digest(), 0xcbf43926);
  assert.equal(crc32(new Uint8Array(0)), 0);
});

test('FVS2 round-trip with meta, sequence 7n, and non-empty texts', () => {
  const core = fakeCore(300);
  const texts = new Map([
    ['x', 'héllo wörld ✓'],
    ['auto-0', 'second'],
  ]);
  const bytes = encodeSnapshot(core, texts, { sequence: 7n, meta: META });
  assert.equal(new TextDecoder().decode(bytes.subarray(0, 4)), 'FVS2');

  const d = decodeSnapshot(bytes);
  assert.equal(d.formatVersion, 2);
  assert.equal(d.sequence, 7n);
  assert.deepEqual(d.meta, META);
  assert.deepEqual([...d.core], [...core]);
  assert.deepEqual([...d.texts], [...texts]);
});

test('FVS2 round-trip with empty texts', () => {
  const core = fakeCore(64);
  const bytes = encodeSnapshot(core, new Map(), { sequence: 1n, meta: { ...META, count: 0 } });
  const d = decodeSnapshot(bytes);
  assert.equal(d.formatVersion, 2);
  assert.equal(d.sequence, 1n);
  assert.equal(d.meta?.count, 0);
  assert.deepEqual([...d.core], [...core]);
  assert.equal(d.texts.size, 0);
});

test('torn-write fuzz: EVERY truncation of a 2 KB snapshot is rejected', () => {
  const bytes = sample2k();
  for (let len = 0; len < bytes.length; len++) {
    assertCorrupt(() => decodeSnapshot(bytes.subarray(0, len)), undefined, `truncation to ${len} decoded`);
  }
  // Sanity: the untruncated blob decodes.
  assert.equal(decodeSnapshot(bytes).sequence, 7n);
});

test('bit-flip fuzz: 500 seeded single-bit flips anywhere in the file are rejected', () => {
  const original = sample2k();
  const rand = mulberry32(0xf00d);
  for (let i = 0; i < 500; i++) {
    const offset = Math.floor(rand() * original.length);
    const bit = Math.floor(rand() * 8);
    const bytes = original.slice();
    bytes[offset] = bytes[offset]! ^ (1 << bit);
    assertCorrupt(() => decodeSnapshot(bytes), undefined, `flip @${offset} bit ${bit} decoded`);
  }
  // Every header byte specifically (the region most likely to dodge a CRC).
  for (let offset = 0; offset < 32; offset++) {
    for (let bit = 0; bit < 8; bit++) {
      const bytes = original.slice();
      bytes[offset] = bytes[offset]! ^ (1 << bit);
      assertCorrupt(() => decodeSnapshot(bytes), undefined, `header flip @${offset} bit ${bit} decoded`);
    }
  }
});

test('appended garbage (one extra trailing byte) is bad-length', () => {
  const bytes = sample2k();
  const longer = new Uint8Array(bytes.length + 1);
  longer.set(bytes);
  assertCorrupt(() => decodeSnapshot(longer), 'bad-length');
});

test('specific corruption reasons', () => {
  const bytes = sample2k();
  assertCorrupt(() => decodeSnapshot(bytes.subarray(0, 3)), 'too-short');
  assertCorrupt(() => decodeSnapshot(bytes.subarray(0, 31)), 'too-short');

  const badVersion = bytes.slice();
  badVersion[5] = 3;
  assertCorrupt(() => decodeSnapshot(badVersion), 'bad-version');

  const badCrc = bytes.slice();
  badCrc[bytes.length - 1] = badCrc[bytes.length - 1]! ^ 0x01;
  assertCorrupt(() => decodeSnapshot(badCrc), 'bad-crc');

  assertCorrupt(() => decodeSnapshot(new TextEncoder().encode('garbage!garbage!')), 'bad-magic');
});

test('legacy FVS1 blobs still decode as formatVersion 1', () => {
  const core = fakeCore(120);
  const json = new TextEncoder().encode(JSON.stringify([['cat', 'the cat sat on the mat']]));
  const blob = new Uint8Array(8 + core.length + json.length);
  const view = new DataView(blob.buffer);
  view.setUint32(0, 0x46565331, false); // "FVS1"
  view.setUint32(4, core.length, false);
  blob.set(core, 8);
  blob.set(json, 8 + core.length);

  const d = decodeSnapshot(blob);
  assert.equal(d.formatVersion, 1);
  assert.equal(d.sequence, 0n);
  assert.equal(d.meta, null);
  assert.deepEqual([...d.core], [...core]);
  assert.equal(d.texts.get('cat'), 'the cat sat on the mat');

  // FVS1 with no sidecar.
  const bare = new Uint8Array(8 + core.length);
  new DataView(bare.buffer).setUint32(0, 0x46565331, false);
  new DataView(bare.buffer).setUint32(4, core.length, false);
  bare.set(core, 8);
  assert.equal(decodeSnapshot(bare).texts.size, 0);

  // FVS1 whose declared core overruns the file is rejected, not silently short.
  assertCorrupt(() => decodeSnapshot(bare.subarray(0, 50)), 'bad-length');
});

test('legacy raw core bytes ("FVEC" magic, no framing) decode as formatVersion 1', () => {
  const core = fakeCore(80);
  const d = decodeSnapshot(core);
  assert.equal(d.formatVersion, 1);
  assert.equal(d.meta, null);
  assert.equal(d.core.length, 80);
  assert.equal(d.texts.size, 0);
});
