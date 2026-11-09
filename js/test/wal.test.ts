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
  WAL_MAX_HEADER_LEN,
  WAL_MAX_MODEL_LEN,
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
  {
    kind: 'insert',
    id: 'meta',
    vector: vec(5),
    text: 'a document with metadata',
    metadataJson: JSON.stringify({ source: 'note', tags: ['a', 'ü'], n: 1, nested: { ok: true } }),
  },
  {
    kind: 'insert',
    id: 'last',
    vector: vec(4),
    text: 'the final record in the log, with metadata',
    metadataJson: '{"page":7}',
  },
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
      assert.equal(got.metadataJson, want.metadataJson);
      assert.equal('metadataJson' in got, want.metadataJson !== undefined, 'no metadata → no key');
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

test('the model id is bounded to 256 UTF-8 bytes: encode throws above it, decode and declared length reject it', () => {
  assert.equal(WAL_MAX_MODEL_LEN, 256);
  assert.equal(WAL_MAX_HEADER_LEN, 282);
  const longest = encodeWalHeader({ baseSequence: 1n, dims: DIMS, model: 'm'.repeat(256) });
  assert.equal(longest.length, WAL_MAX_HEADER_LEN);
  assert.equal(decodeWalHeader(longest).model.length, 256);
  assert.equal(declaredWalHeaderLength(longest), WAL_MAX_HEADER_LEN);
  assert.throws(() => encodeWalHeader({ baseSequence: 1n, dims: DIMS, model: 'm'.repeat(257) }), RangeError);
  // 129 two-byte characters = 258 UTF-8 bytes: the bound is in bytes, not characters.
  assert.throws(() => encodeWalHeader({ baseSequence: 1n, dims: DIMS, model: 'é'.repeat(129) }), RangeError);

  const isBadHeader = (err: unknown): boolean => err instanceof WalCorruptError && err.reason === 'bad-header';
  for (const modelLen of [257, 0x1000, 0xffff]) {
    const bytes = new Uint8Array(70_000);
    bytes.set(encodeWalHeader({ baseSequence: 1n, dims: DIMS, model: MODEL }));
    new DataView(bytes.buffer).setUint16(20, modelLen, true);
    assert.equal(declaredWalHeaderLength(bytes), null, `modelLen ${modelLen}: not a cut write`);
    assert.equal(declaredWalHeaderLength(bytes.subarray(0, 40)), null, `modelLen ${modelLen}, short file`);
    assert.throws(() => decodeWalHeader(bytes), isBadHeader, `modelLen ${modelLen}`);
  }
});

/** Frame a raw payload as `payloadLen ‖ crc32(payload) ‖ payload` (a CRC-valid record). */
function frame(payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + payload.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, payload.length, true);
  view.setUint32(4, crc32(payload), true);
  out.set(payload, 8);
  return out;
}

/** The payload of an encoded record (everything after its 8-byte prefix). */
function payloadOf(record: WalRecord): Uint8Array {
  return encodeWalRecord(record, DIMS).slice(8);
}

test('kind 3: an insert with metadata is kind 3 with a trailing u32 metaLen + JSON; without metadata it stays kind 1', () => {
  const metadataJson = JSON.stringify({ source: 'note', addedAt: 1_700_000_000_000, title: 'café 🦀' });
  const withMeta = payloadOf({ kind: 'insert', id: 'm', vector: vec(9), text: 'hello', metadataJson });
  const plain = payloadOf({ kind: 'insert', id: 'm', vector: vec(9), text: 'hello' });
  assert.equal(withMeta[0], 3, 'kind 3 = insert with metadata');
  assert.equal(plain[0], 1, 'kind 1 = insert (unchanged)');
  const metaBytes = new TextEncoder().encode(metadataJson);
  assert.equal(withMeta.length, plain.length + 4 + metaBytes.length, 'kind 1 layout + u32 metaLen + JSON');
  assert.deepEqual(withMeta.subarray(1, plain.length), plain.subarray(1), 'same id/vector/text layout as kind 1');
  const view = new DataView(withMeta.buffer, withMeta.byteOffset, withMeta.byteLength);
  assert.equal(view.getUint32(plain.length, true), metaBytes.length, 'u32 metaLen, little-endian');
  assert.deepEqual(withMeta.subarray(plain.length + 4), metaBytes);

  const header = encodeWalHeader({ baseSequence: 0n, dims: DIMS, model: MODEL });
  const scan = scanWal(concat([header, frame(withMeta), frame(plain)]), DIMS);
  assert.equal(scan.truncatedTail, false);
  assert.equal(scan.records.length, 2);
  const [a, b] = scan.records;
  assert.ok(a?.kind === 'insert' && b?.kind === 'insert');
  assert.equal(a.metadataJson, metadataJson);
  assert.deepEqual(JSON.parse(a.metadataJson!), JSON.parse(metadataJson));
  assert.equal(a.text, 'hello');
  assert.equal(b.metadataJson, undefined, 'a kind-1 record decodes with no metadata');
  assert.equal('metadataJson' in b, false);
});

test('kind 1 records written by 0.4 still decode (hand-built bytes, no metadata)', () => {
  // kind 1 exactly as 0.4 encoded it: u8 1, u16 idLen, id, f32[dims], u32 textLen, text.
  const id = new TextEncoder().encode('old');
  const text = new TextEncoder().encode('written by 0.4');
  const v = vec(11);
  const payload = new Uint8Array(1 + 2 + id.length + DIMS * 4 + 4 + text.length);
  const view = new DataView(payload.buffer);
  let off = 0;
  view.setUint8(off, 1);
  view.setUint16((off += 1), id.length, true);
  payload.set(id, (off += 2));
  off += id.length;
  for (let i = 0; i < DIMS; i++, off += 4) view.setFloat32(off, v[i]!, true);
  view.setUint32(off, text.length, true);
  payload.set(text, off + 4);
  const header = encodeWalHeader({ baseSequence: 3n, dims: DIMS, model: MODEL });
  const scan = scanWal(concat([header, frame(payload)]), DIMS);
  assert.equal(scan.records.length, 1);
  const rec = scan.records[0]!;
  assert.ok(rec.kind === 'insert');
  assert.equal(rec.id, 'old');
  assert.equal(rec.text, 'written by 0.4');
  assert.equal(rec.metadataJson, undefined);
  assert.deepEqual(Array.from(rec.vector), Array.from(v));
});

test('kind 3: a truncated or overlong metaLen, bad JSON, or non-object JSON stops the scan at that record', () => {
  const header = encodeWalHeader({ baseSequence: 0n, dims: DIMS, model: MODEL });
  const good = encodeWalRecord(RECORDS[0]!, DIMS);
  const full = payloadOf({ kind: 'insert', id: 'x', vector: vec(12), text: 'tx', metadataJson: '{"a":1}' });
  const metaLenAt = full.length - 4 - '{"a":1}'.length;

  const withMetaLen = (metaLen: number): Uint8Array => {
    const p = full.slice();
    new DataView(p.buffer).setUint32(metaLenAt, metaLen, true);
    return p;
  };
  const withJson = (json: string): Uint8Array => {
    const bytes = new TextEncoder().encode(json);
    const p = new Uint8Array(metaLenAt + 4 + bytes.length);
    p.set(full.subarray(0, metaLenAt));
    new DataView(p.buffer).setUint32(metaLenAt, bytes.length, true);
    p.set(bytes, metaLenAt + 4);
    return p;
  };
  const cases: Array<[string, Uint8Array]> = [
    // The record (with a correct CRC) ends inside the u32 metaLen field.
    ...[0, 1, 2, 3].map((n): [string, Uint8Array] => [`metaLen cut to ${n} bytes`, full.slice(0, metaLenAt + n)]),
    ['metaLen longer than the payload', withMetaLen(8)],
    ['metaLen shorter than the payload', withMetaLen(3)],
    ['metaLen 0xffffffff', withMetaLen(0xffffffff)],
    ['JSON that does not parse', withJson('{"a":')],
    ['JSON array, not an object', withJson('[1,2]')],
    ['JSON null', withJson('null')],
    ['JSON string', withJson('"text"')],
    ['invalid UTF-8', (() => {
      const p = withJson('{"a":"xx"}');
      p[p.length - 3] = 0xff;
      return p;
    })()],
  ];
  for (const [label, payload] of cases) {
    const scan = scanWal(concat([header, good, frame(payload), good]), DIMS);
    assert.equal(scan.records.length, 1, label);
    assert.equal(scan.validLength, header.length + good.length, label);
    assert.equal(scan.truncatedTail, true, label);
  }
  // Sanity: the untouched payload decodes.
  assert.equal(scanWal(concat([header, frame(full)]), DIMS).records.length, 1);
});
