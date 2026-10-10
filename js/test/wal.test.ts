/**
 * Write-ahead log framing (pure, Node). Backs exit criterion (2) — replay never
 * applies a torn record: a log cut at any byte of its last record, or with any
 * bit flipped inside a record, yields exactly the complete records before the
 * damage and never a partial one.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { WalCorruptError } from '../src/errors.ts';
import { crc32 } from '../src/crc32.ts';
import {
  WAL_MIN_HEADER_LEN,
  declaredWalHeaderLength,
  decodeWalHeader,
  encodeWalHeader,
  encodeWalRecord,
  scanWal,
  type WalRecord,
} from '../src/wal.ts';

const DIMS = 32;
const MODEL = 'Xenova/all-MiniLM-L6-v2';
/** Header length for {@link MODEL}: 26 fixed bytes + the model id. */
const HEADER_LEN = WAL_MIN_HEADER_LEN + MODEL.length;

/** Tiny seeded PRNG (mulberry32) so the fuzz is reproducible without deps. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function vec(seed: number, dims = DIMS): Float32Array {
  const rand = prng(seed);
  return Float32Array.from({ length: dims }, () => rand() * 2 - 1);
}

const RECORDS: WalRecord[] = [
  { kind: 'insert', id: 'cat', vector: vec(1), text: 'the cat sat on the mat' },
  { kind: 'insert', id: 'naïve-文書-🦀', vector: vec(2), text: 'unicode: café, 東京, emoji 🚀' },
  { kind: 'remove', id: 'cat' },
  { kind: 'insert', id: '', vector: vec(3), text: '' },
  { kind: 'remove', id: 'ключ-🔑' },
  { kind: 'insert', id: 'last', vector: vec(4), text: 'the final record in the log' },
];

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function buildLog(records: WalRecord[], baseSequence = 7n): { bytes: Uint8Array; ends: number[] } {
  const parts = [encodeWalHeader({ baseSequence, dims: DIMS, model: MODEL })];
  const ends: number[] = [];
  let end = HEADER_LEN;
  for (const r of records) {
    const enc = encodeWalRecord(r, DIMS);
    parts.push(enc);
    end += enc.length;
    ends.push(end);
  }
  return { bytes: concat(parts), ends };
}

test('header round-trips with the model id; magic reads "FVW2" in a hex dump', () => {
  const bytes = encodeWalHeader({ baseSequence: 0x1_0000_0002n, dims: 384, model: MODEL });
  assert.equal(bytes.length, 26 + 23);
  assert.equal(new TextDecoder().decode(bytes.subarray(0, 4)), 'FVW2');
  const view = new DataView(bytes.buffer);
  assert.equal(view.getUint16(4, true), 2, 'version 2, little-endian');
  assert.equal(view.getUint16(20, true), 23, 'u16 modelLen, little-endian');
  assert.equal(new TextDecoder().decode(bytes.subarray(22, 45)), MODEL, 'model id bytes at offset 22');
  assert.equal(view.getUint32(45, true), crc32(bytes.subarray(0, 45)), 'crc covers bytes[0..22+modelLen)');
  assert.deepEqual(decodeWalHeader(bytes), {
    baseSequence: 0x1_0000_0002n,
    dims: 384,
    model: MODEL,
    length: 49,
  });
  assert.equal(declaredWalHeaderLength(bytes), 49);
  // An empty model id ("unknown") is the minimum header; non-ASCII ids round-trip.
  assert.deepEqual(decodeWalHeader(encodeWalHeader({ baseSequence: 0n, dims: 32, model: '' })), {
    baseSequence: 0n,
    dims: 32,
    model: '',
    length: WAL_MIN_HEADER_LEN,
  });
  const unicode = 'modèle/埋め込み-🦀';
  const u = encodeWalHeader({ baseSequence: 9n, dims: 8, model: unicode });
  assert.equal(decodeWalHeader(u).model, unicode);
  assert.equal(decodeWalHeader(u).length, WAL_MIN_HEADER_LEN + new TextEncoder().encode(unicode).length);
});

test('bad magic / version / crc / short header throw WalCorruptError("bad-header")', () => {
  const good = encodeWalHeader({ baseSequence: 3n, dims: 32, model: MODEL });
  const isBadHeader = (err: unknown): boolean => {
    assert.ok(err instanceof WalCorruptError);
    assert.equal(err.name, 'WalCorruptError');
    assert.equal(err.reason, 'bad-header');
    return true;
  };

  const magic = good.slice();
  magic[3] = 0x33; // "FVW3"
  assert.throws(() => decodeWalHeader(magic), isBadHeader);

  // A different version with a recomputed-looking but now-stale crc still fails;
  // check both the version gate and the crc gate independently.
  const version = good.slice();
  new DataView(version.buffer).setUint16(4, 3, true);
  assert.throws(() => decodeWalHeader(version), isBadHeader);

  const crc = good.slice();
  crc[16] = crc[16]! ^ 0x01; // dims bit flip → crc mismatch
  assert.throws(() => decodeWalHeader(crc), isBadHeader);

  for (let len = 0; len < good.length; len++) {
    assert.throws(() => decodeWalHeader(good.subarray(0, len)), isBadHeader, `length ${len}`);
  }
  assert.throws(() => scanWal(magic, DIMS), isBadHeader, 'scanWal throws only for a bad header');
});

test('the header crc covers the model id and its length', () => {
  const good = encodeWalHeader({ baseSequence: 3n, dims: 32, model: MODEL });
  const isBadHeader = (err: unknown): boolean => {
    assert.ok(err instanceof WalCorruptError);
    assert.equal(err.reason, 'bad-header');
    return true;
  };
  // Every bit of every model byte: a same-length different model must not decode.
  for (let off = 22; off < 22 + MODEL.length; off++) {
    for (let bit = 0; bit < 8; bit++) {
      const flipped = good.slice();
      flipped[off] = flipped[off]! ^ (1 << bit);
      assert.throws(() => decodeWalHeader(flipped), isBadHeader, `model byte ${off}, bit ${bit}`);
    }
  }
  // A shorter modelLen moves the crc field: it no longer matches.
  const shorter = good.slice();
  new DataView(shorter.buffer).setUint16(20, MODEL.length - 1, true);
  assert.throws(() => decodeWalHeader(shorter), isBadHeader);
  // A swapped model with the old crc kept: rejected.
  const swapped = encodeWalHeader({ baseSequence: 3n, dims: 32, model: 'Xenova/all-MiniLM-L6-v3' });
  swapped.set(good.subarray(45, 49), 45);
  assert.throws(() => decodeWalHeader(swapped), isBadHeader);
});

test('an FVW1 log (24-byte header without a model id, never shipped) is rejected as bad-header', () => {
  // The exact FVW1 header encoding: "FVW1", u16 version 1, u16 flags,
  // u64 baseSequence, u32 dims, u32 crc32(bytes[0..20)).
  const fvw1 = new Uint8Array(24);
  const view = new DataView(fvw1.buffer);
  fvw1.set([0x46, 0x56, 0x57, 0x31], 0);
  view.setUint16(4, 1, true);
  view.setBigUint64(8, 0n, true);
  view.setUint32(16, DIMS, true);
  view.setUint32(20, crc32(fvw1.subarray(0, 20)), true);
  const record = encodeWalRecord(RECORDS[0]!, DIMS);
  const log = concat([fvw1, record]);
  assert.equal(declaredWalHeaderLength(log), null, 'not an FVW2 header prefix');
  for (const bytes of [fvw1, log]) {
    assert.throws(
      () => decodeWalHeader(bytes),
      (err: unknown) => err instanceof WalCorruptError && err.reason === 'bad-header',
    );
    assert.throws(
      () => scanWal(bytes, DIMS),
      (err: unknown) => err instanceof WalCorruptError && err.reason === 'bad-header',
    );
  }
  // Even with the FVW2 magic, version 1 is refused.
  const relabelled = fvw1.slice();
  relabelled[3] = 0x32;
  assert.throws(() => decodeWalHeader(relabelled), WalCorruptError);
});

test('declaredWalHeaderLength: a header cut inside its model id is recognisable as such', () => {
  const good = encodeWalHeader({ baseSequence: 0n, dims: DIMS, model: MODEL });
  for (let len = 22; len < good.length; len++) {
    assert.equal(declaredWalHeaderLength(good.subarray(0, len)), good.length, `cut at ${len}`);
  }
  assert.equal(declaredWalHeaderLength(good.subarray(0, 21)), null, 'modelLen not yet written');
  assert.equal(declaredWalHeaderLength(new TextEncoder().encode('definitely not a log header')), null);
});

test('records round-trip: inserts and removes, unicode ids and texts, 32-dim vectors', () => {
  const { bytes } = buildLog(RECORDS);
  const scan = scanWal(bytes, DIMS);
  assert.equal(scan.truncatedTail, false);
  assert.equal(scan.validLength, bytes.length);
  assert.equal(scan.records.length, RECORDS.length);
  for (let i = 0; i < RECORDS.length; i++) {
    const want = RECORDS[i]!;
    const got = scan.records[i]!;
    assert.equal(got.kind, want.kind);
    assert.equal(got.id, want.id);
    if (want.kind === 'insert' && got.kind === 'insert') {
      assert.equal(got.text, want.text);
      assert.deepEqual(Array.from(got.vector), Array.from(want.vector));
    }
  }
});

test('header-only log scans to zero records with no torn tail', () => {
  const header = encodeWalHeader({ baseSequence: 1n, dims: DIMS, model: MODEL });
  assert.deepEqual(scanWal(header, DIMS), { records: [], validLength: HEADER_LEN, truncatedTail: false });
});

test('torn tail at EVERY byte offset of the last record → exactly the N good records', () => {
  const { bytes, ends } = buildLog(RECORDS);
  const n = RECORDS.length - 1;
  const lastStart = ends[n - 1]!;
  for (let len = lastStart; len < bytes.length; len++) {
    const scan = scanWal(bytes.subarray(0, len), DIMS);
    assert.equal(scan.records.length, n, `cut at ${len}`);
    assert.equal(scan.validLength, lastStart, `cut at ${len}`);
    assert.equal(scan.truncatedTail, len > lastStart, `cut at ${len}`);
  }
});

test('a bit flip in any record stops the scan at that record (earlier records returned)', () => {
  const { bytes, ends } = buildLog(RECORDS);
  const starts = [HEADER_LEN, ...ends.slice(0, -1)];
  for (let r = 0; r < RECORDS.length; r++) {
    for (let off = starts[r]!; off < ends[r]!; off++) {
      for (const bit of [0, 7]) {
        const flipped = bytes.slice();
        flipped[off] = flipped[off]! ^ (1 << bit);
        const scan = scanWal(flipped, DIMS);
        assert.equal(scan.records.length, r, `record ${r}, byte ${off}, bit ${bit}`);
        assert.equal(scan.validLength, starts[r], `record ${r}, byte ${off}, bit ${bit}`);
        assert.equal(scan.truncatedTail, true);
      }
    }
  }
});

test('encode: an insert vector whose length is not dims throws', () => {
  assert.throws(() =>
    encodeWalRecord({ kind: 'insert', id: 'x', vector: new Float32Array(16), text: 't' }, DIMS),
  );
  // A remove carries no vector, so dims do not matter.
  assert.ok(encodeWalRecord({ kind: 'remove', id: 'x' }, DIMS).length > 0);
});
