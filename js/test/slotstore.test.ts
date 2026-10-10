/**
 * A/B slot store + write-ahead log under Node, against an in-memory
 * {@link SlotFileSystem} fake whose writes can "crash" after N bytes (throw,
 * leave a partial file, and make every later write/truncate/flush on that file
 * system fail until {@link kill}) to simulate a tab killed mid-write. Backs the
 * Phase 0 criteria — a valid on-disk index is never overwritten by an empty one;
 * a crash mid-checkpoint leaves the previous one intact — and the Phase 1 ones:
 * acknowledged appends survive a kill, a torn log tail is never replayed, and
 * checkpoints are crash-consistent with the log (no double-apply, no gap).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { EmptyOverwriteRefusedError, StoreCorruptError } from '../src/errors.ts';
import {
  SlotStore,
  type SlotFile,
  type SlotFileSystem,
  type SlotStoreOptions,
  type SnapshotSource,
  type StoreFile,
} from '../src/persistence.ts';
import { decodeSnapshot } from '../src/snapshot.ts';
import { decodeWalHeader, encodeWalHeader, encodeWalRecord, scanWal, type WalRecord } from '../src/wal.ts';

const DIMS = 32;

class MemFS implements SlotFileSystem {
  readonly files = new Map<string, Uint8Array>();
  readonly log: string[] = [];
  readonly open_ = new Set<MemFile>();
  /** When set, the next matching write stores only this many bytes and then throws. */
  crashAfterBytes: number | null = null;
  /** Restrict {@link crashAfterBytes} to writes of this file (`null` = any file). */
  crashOn: StoreFile | null = null;
  /** Set by a crash: the "tab" is dead, so every later mutation throws until kill(). */
  dead = false;

  async open(file: StoreFile): Promise<SlotFile | null> {
    if (!this.files.has(file)) {
      if (file === 'index.bin') return null;
      this.files.set(file, new Uint8Array(0));
    }
    const handle = new MemFile(this, file);
    this.open_.add(handle);
    return handle;
  }

  async remove(file: string): Promise<void> {
    this.log.push(`remove ${file}`);
    this.files.delete(file);
  }

  seq(file: string): bigint {
    return decodeSnapshot(this.files.get(file)!).sequence;
  }

  /** The log's header base sequence and its records. */
  wal(): { base: bigint; records: WalRecord[]; size: number } {
    const bytes = this.files.get('wal.bin')!;
    const header = decodeWalHeader(bytes);
    return { base: header.baseSequence, records: scanWal(bytes, header.dims).records, size: bytes.length };
  }

  count(entry: string): number {
    return this.log.filter((l) => l === entry).length;
  }
}

class MemFile implements SlotFile {
  readonly fs: MemFS;
  readonly name: StoreFile;

  constructor(fs: MemFS, name: StoreFile) {
    this.fs = fs;
    this.name = name;
  }

  #data(): Uint8Array {
    return this.fs.files.get(this.name)!;
  }

  #alive(): void {
    if (this.fs.dead) throw new Error('simulated tab kill: the file system is gone');
  }

  read(buffer: Uint8Array, { at }: { at: number }): number {
    const data = this.#data();
    const n = Math.max(0, Math.min(buffer.length, data.length - at));
    buffer.set(data.subarray(at, at + n));
    return n;
  }

  write(buffer: Uint8Array, { at }: { at: number }): number {
    this.#alive();
    const crashes =
      this.fs.crashAfterBytes !== null && (this.fs.crashOn === null || this.fs.crashOn === this.name);
    const len = crashes ? Math.min(buffer.length, this.fs.crashAfterBytes!) : buffer.length;
    const data = this.#data();
    const next = new Uint8Array(Math.max(data.length, at + len));
    next.set(data);
    next.set(buffer.subarray(0, len), at);
    this.fs.files.set(this.name, next);
    this.fs.log.push(`write ${this.name}`);
    if (crashes) {
      this.fs.crashAfterBytes = null;
      this.fs.crashOn = null;
      this.fs.dead = true;
      throw new Error('simulated tab kill mid-write');
    }
    return len;
  }

  truncate(newSize: number): void {
    this.#alive();
    const data = this.#data();
    const next = new Uint8Array(newSize);
    next.set(data.subarray(0, Math.min(newSize, data.length)));
    this.fs.files.set(this.name, next);
    this.fs.log.push(`truncate ${this.name}`);
  }

  getSize(): number {
    return this.#data().length;
  }

  flush(): void {
    this.#alive();
    this.fs.log.push(`flush ${this.name}`);
  }

  close(): void {
    this.fs.log.push(`close ${this.name}`);
    this.fs.open_.delete(this);
  }
}

/** Synthetic core bytes (the store never interprets them). */
function fakeCore(tag: number): Uint8Array {
  const out = new Uint8Array(64 + tag * 7);
  out.set([0x46, 0x56, 0x45, 0x43], 0); // "FVEC"
  out.fill(tag & 0xff, 4);
  return out;
}

/** A producer whose content changes with `state.count`. */
function producer(state: { count: number }): () => SnapshotSource {
  return () => ({
    core: fakeCore(state.count),
    texts: new Map(Array.from({ length: state.count }, (_, i) => [`id-${i}`, `text ${i}`] as [string, string])),
    meta: {
      embeddingSpace: { model: 'fake-fnv1a-32', dims: DIMS, metric: 'cosine' },
      count: state.count,
      writer: 'test',
      createdAt: 0,
    },
  });
}

/** A legacy FVS1 `index.bin` blob: magic, core length, core, texts JSON. */
function fvs1(core: Uint8Array, texts: Array<[string, string]>): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(texts));
  const blob = new Uint8Array(8 + core.length + json.length);
  new DataView(blob.buffer).setUint32(0, 0x46565331, false); // "FVS1"
  new DataView(blob.buffer).setUint32(4, core.length, false);
  blob.set(core, 8);
  blob.set(json, 8 + core.length);
  return blob;
}

function ins(id: string, fill = 1): WalRecord {
  return { kind: 'insert', id, vector: new Float32Array(DIMS).fill(fill), text: `text of ${id}` };
}

/** Log one mutation and checkpoint it (what flush() does after any mutation). */
async function commit(store: SlotStore, kind: 'insert' | 'remove' = 'insert', id = 'x'): Promise<void> {
  await store.append(kind === 'insert' ? ins(id) : { kind: 'remove', id });
  await store.flush();
}

/** Abandon a store as a killed tab would: its handles simply go away. */
function kill(fs: MemFS): void {
  fs.open_.clear();
  fs.dead = false;
}

function open(fs: MemFS, opts: SlotStoreOptions = {}): Promise<SlotStore> {
  return SlotStore.open(fs, opts);
}

/** Yield one macrotask: lets a strict-mode threshold checkpoint (scheduled after the ack) run. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

test('fresh open alternates slot-a / slot-b with increasing sequence', async () => {
  const fs = new MemFS();
  const store = await open(fs);
  assert.equal(store.initialSnapshot, null);
  assert.equal(store.nextSequence, 1n);
  assert.equal(fs.files.has('index.bin'), false, 'the legacy probe must not create index.bin');

  const state = { count: 1 };
  store.bind(producer(state));

  await commit(store);
  assert.equal(fs.seq('slot-a.bin'), 1n);
  assert.equal(fs.files.get('slot-b.bin')!.length, 0);
  assert.deepEqual(fs.wal(), { base: 1n, records: [], size: 24 }, 'log reset onto seq 1 after the checkpoint');

  state.count = 2;
  await commit(store);
  assert.equal(fs.seq('slot-b.bin'), 2n);
  assert.equal(fs.seq('slot-a.bin'), 1n);

  state.count = 3;
  await commit(store);
  assert.equal(fs.seq('slot-a.bin'), 3n);
  assert.equal(fs.seq('slot-b.bin'), 2n);
  assert.equal(store.onDiskCount, 3);

  await store.close();
  assert.equal(fs.open_.size, 0);

  const reopened = await open(fs);
  assert.equal(reopened.initialSnapshot?.sequence, 3n);
  assert.equal(reopened.initialSnapshot?.texts.size, 3);
  assert.equal(reopened.nextSequence, 4n);
  assert.deepEqual(reopened.initialReplay, [], 'nothing logged since the last checkpoint');
  assert.equal(reopened.walDims, DIMS);
  await reopened.close();
});

test('crash during checkpoint write (slot torn) → open picks the old snapshot and replays the full log (B === S)', async () => {
  const fs = new MemFS();
  const store = await open(fs);
  const state = { count: 1 };
  store.bind(producer(state));
  await commit(store); // seq 1 → slot-a
  state.count = 2;
  await commit(store); // seq 2 → slot-b
  const slotB = fs.files.get('slot-b.bin')!.slice();

  // Three acknowledged appends on top of seq 2, then a checkpoint torn halfway.
  await store.append(ins('p'));
  await store.append(ins('q'));
  await store.append({ kind: 'remove', id: 'p' });
  state.count = 5; // a larger snapshot, torn halfway
  fs.crashOn = 'slot-a.bin';
  fs.crashAfterBytes = 100;
  await assert.rejects(store.flush(), /simulated tab kill/);
  kill(fs);

  assert.throws(() => fs.seq('slot-a.bin'), 'slot-a must now be torn');
  assert.deepEqual(fs.files.get('slot-b.bin'), slotB, 'the other slot is untouched');
  assert.equal(fs.wal().base, 2n, 'the log was not reset: (b) never ran');

  const reopened = await open(fs);
  assert.equal(reopened.initialSnapshot?.sequence, 2n, 'recovers the previous commit');
  assert.equal(reopened.initialSnapshot?.meta?.count, 2);
  assert.equal(reopened.nextSequence, 3n);
  assert.deepEqual(
    reopened.initialReplay.map((r) => `${r.kind} ${r.id}`),
    ['insert p', 'insert q', 'remove p'],
    'the full log is replayed on top of the older snapshot',
  );

  reopened.bind(producer({ count: 3 }));
  await reopened.flush(); // the replayed records alone warrant a checkpoint
  assert.equal(fs.seq('slot-a.bin'), 3n, 'the next commit overwrites the torn slot');
  assert.deepEqual(fs.wal(), { base: 3n, records: [], size: 24 });
  assert.equal(fs.seq('slot-b.bin'), 2n);
  await reopened.close();
});

test('both slots corrupt → StoreCorruptError listing both slots', async () => {
  const fs = new MemFS();
  fs.files.set('slot-a.bin', new TextEncoder().encode('not a snapshot at all'));
  fs.files.set('slot-b.bin', new Uint8Array([0x46, 0x56, 0x53, 0x32, 0, 2]));
  await assert.rejects(open(fs), (err: unknown) => {
    assert.ok(err instanceof StoreCorruptError);
    assert.equal(err.name, 'StoreCorruptError');
    assert.equal(err.slots.length, 2);
    assert.deepEqual(
      err.slots.map((s) => s.file),
      ['slot-a.bin', 'slot-b.bin'],
    );
    assert.deepEqual(
      err.slots.map((s) => s.reason),
      ['bad-magic', 'too-short'],
    );
    return true;
  });
  assert.equal(fs.open_.size, 0, 'handles opened during a failed open are closed');
  assert.ok(fs.files.get('slot-a.bin')!.length > 0, 'corrupt data is left in place');
});

test('both slots empty + corrupt legacy index.bin → StoreCorruptError', async () => {
  const fs = new MemFS();
  fs.files.set('index.bin', new TextEncoder().encode('garbage-garbage-garbage'));
  await assert.rejects(open(fs), (err: unknown) => {
    assert.ok(err instanceof StoreCorruptError);
    assert.deepEqual(err.slots, [{ file: 'index.bin', reason: 'bad-magic' }]);
    return true;
  });
  assert.equal(fs.open_.size, 0);
});

test('legacy migration: FVS1 index.bin → slot-a seq 1, index.bin removed', async () => {
  const fs = new MemFS();
  fs.files.set('index.bin', fvs1(fakeCore(2), [['cat', 'the cat sat on the mat']]));

  const store = await open(fs);
  assert.equal(store.initialSnapshot?.formatVersion, 1);
  assert.equal(store.initialSnapshot?.texts.get('cat'), 'the cat sat on the mat');
  assert.equal(store.nextSequence, 1n);
  assert.equal(store.onDiskCount, 1, 'a legacy FVS1 file carries one text per live item');
  assert.equal(fs.files.has('index.bin'), true, 'not removed before the first commit');

  store.bind(producer({ count: 1 }));
  await commit(store);
  await store.close(); // awaits the best-effort removal
  assert.equal(fs.files.has('index.bin'), false, 'legacy file removed after the first commit');
  assert.equal(fs.seq('slot-a.bin'), 1n);
  assert.equal(fs.log.filter((l) => l === 'remove index.bin').length, 1);
});

test('empty-overwrite guard: refuses count 0 over on-disk count 3 unless something was removed', async () => {
  const fs = new MemFS();
  const seed = await open(fs);
  seed.bind(producer({ count: 3 }));
  await commit(seed);
  await seed.close();

  const store = await open(fs);
  assert.equal(store.onDiskCount, 3);
  const before = { a: fs.files.get('slot-a.bin')!.slice(), b: fs.files.get('slot-b.bin')!.slice() };
  store.bind(producer({ count: 0 }));

  await store.append(ins('y'));
  await assert.rejects(store.flush(), (err: unknown) => {
    assert.ok(err instanceof EmptyOverwriteRefusedError);
    assert.equal(err.onDiskCount, 3);
    return true;
  });
  assert.deepEqual(fs.files.get('slot-a.bin'), before.a, 'slot-a unchanged');
  assert.deepEqual(fs.files.get('slot-b.bin'), before.b, 'slot-b unchanged');
  assert.equal(fs.wal().records.length, 1, 'the refused checkpoint left the log intact');

  await store.append({ kind: 'remove', id: 'y' });
  await store.flush();
  const committed = decodeSnapshot(fs.files.get('slot-b.bin')!);
  assert.equal(committed.sequence, 2n);
  assert.equal(committed.meta?.count, 0, 'after a remove the empty snapshot IS committed');
  assert.equal(store.onDiskCount, 0);
  await store.close();
});

test('close() checkpoints logged records before closing all three handles', async () => {
  const fs = new MemFS();
  const store = await open(fs);
  store.bind(producer({ count: 2 }));
  await store.append(ins('a'));
  await store.close();

  assert.equal(fs.seq('slot-a.bin'), 1n);
  const flushAt = fs.log.indexOf('flush slot-a.bin');
  assert.ok(flushAt >= 0);
  assert.ok(flushAt < fs.log.indexOf('close slot-a.bin'), 'checkpoint precedes handle close');
  assert.ok(flushAt < fs.log.indexOf('close slot-b.bin'));
  assert.ok(fs.log.lastIndexOf('flush wal.bin') < fs.log.indexOf('close wal.bin'));
  assert.deepEqual(fs.wal(), { base: 1n, records: [], size: 24 });
  assert.equal(fs.open_.size, 0);
  await store.close(); // idempotent
});

test('close() still closes both handles and rethrows when the final commit throws', async () => {
  const fs = new MemFS();
  const store = await open(fs);
  store.bind(() => {
    throw new Error('producer exploded');
  });
  await store.append(ins('a'));
  await assert.rejects(store.close(), /producer exploded/);
  assert.equal(fs.open_.size, 0, 'all handles closed despite the failed checkpoint');
  assert.equal(fs.wal().records.length, 1, 'the logged record survives the failed checkpoint');
  assert.equal(fs.files.get('slot-a.bin')!.length, 0, 'nothing written');
});

test('close() before bind() never writes (the coordinator closes an unbound store on mismatch)', async () => {
  const fs = new MemFS();
  const seed = await open(fs);
  seed.bind(producer({ count: 2 }));
  await commit(seed);
  await seed.close();
  const snapshotBefore = fs.files.get('slot-a.bin')!.slice();
  fs.log.length = 0;

  const store = await open(fs);
  await store.close();
  assert.deepEqual(
    fs.log,
    ['close slot-a.bin', 'close slot-b.bin', 'close wal.bin'],
    'no write/flush happened',
  );
  assert.deepEqual(fs.files.get('slot-a.bin'), snapshotBefore);
  assert.equal(fs.files.get('slot-b.bin')!.length, 0);
});

test('torn first migration commit (torn slot-a, empty slot-b, intact FVS1 index.bin) re-migrates', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const fs = new MemFS();
  const texts: Array<[string, string]> = [
    ['cat', 'the cat sat on the mat'],
    ['dog', 'a dog chased the ball'],
  ];
  fs.files.set('index.bin', fvs1(fakeCore(2), texts));

  // The first migration commit is torn: slot-a holds a partial FVS2 blob.
  const first = await open(fs);
  first.bind(producer({ count: 2 }));
  await first.append(ins('dog'));
  fs.crashOn = 'slot-a.bin';
  fs.crashAfterBytes = 40;
  await assert.rejects(first.flush(), /simulated tab kill/);
  kill(fs);
  assert.ok(fs.files.get('slot-a.bin')!.length > 0, 'slot-a is torn, not empty');
  assert.throws(() => fs.seq('slot-a.bin'));
  assert.equal(fs.files.get('slot-b.bin')!.length, 0);
  assert.equal(fs.files.has('index.bin'), true, 'legacy file survives a failed commit');

  const store = await open(fs);
  assert.equal(store.initialSnapshot?.formatVersion, 1, 'opens from the legacy file');
  assert.equal(store.initialSnapshot?.texts.get('dog'), 'a dog chased the ball');
  assert.equal(store.nextSequence, 1n);
  assert.equal(store.onDiskCount, 2);
  assert.equal(warn.mock.callCount(), 1, 'warns once about the torn slot');
  assert.match(String(warn.mock.calls[0]!.arguments[0]), /torn slot-a\.bin/);
  assert.deepEqual(
    store.initialReplay.map((r) => r.id),
    ['dog'],
    'the log (based on the legacy snapshot, sequence 0) is replayed',
  );

  store.bind(producer({ count: 2 }));
  await store.flush();
  await store.close();
  assert.equal(fs.seq('slot-a.bin'), 1n, 'the next commit overwrites the torn slot');
  assert.equal(fs.files.has('index.bin'), false, 'legacy file removed after the successful commit');
  assert.equal(fs.open_.size, 0);
});

test('torn slot-b + empty slot-a + no index.bin → StoreCorruptError (a torn fresh store stays an error)', async () => {
  const fs = new MemFS();
  fs.files.set('slot-b.bin', new Uint8Array([0x46, 0x56, 0x53, 0x32, 0, 2, 0, 0, 0, 0]));
  await assert.rejects(open(fs), (err: unknown) => {
    assert.ok(err instanceof StoreCorruptError);
    assert.deepEqual(err.slots, [
      { file: 'slot-a.bin', reason: 'empty' },
      { file: 'slot-b.bin', reason: 'too-short' },
    ]);
    return true;
  });
  assert.equal(fs.open_.size, 0, 'handles opened during a failed open are closed');
  assert.ok(fs.files.get('slot-b.bin')!.length > 0, 'torn data is left in place');
});

test('legacy FVS1 onDiskCount = sidecar size, so the empty-overwrite guard protects it', async () => {
  const fs = new MemFS();
  fs.files.set(
    'index.bin',
    fvs1(fakeCore(3), [
      ['a', 'alpha'],
      ['b', 'beta'],
      ['c', 'gamma'],
    ]),
  );
  const store = await open(fs);
  assert.equal(store.initialSnapshot?.formatVersion, 1);
  assert.equal(store.onDiskCount, 3);

  store.bind(producer({ count: 0 }));
  await store.append(ins('d'));
  await assert.rejects(store.flush(), (err: unknown) => {
    assert.ok(err instanceof EmptyOverwriteRefusedError);
    assert.equal(err.onDiskCount, 3);
    return true;
  });
  assert.equal(fs.files.get('slot-a.bin')!.length, 0, 'nothing written');
  assert.equal(fs.files.get('slot-b.bin')!.length, 0);
  assert.equal(fs.files.has('index.bin'), true, 'legacy file kept');
  await assert.rejects(store.close(), EmptyOverwriteRefusedError);
  assert.equal(fs.open_.size, 0);

  // A raw core with no text sidecar is still an unknown count.
  const raw = new MemFS();
  raw.files.set('index.bin', fakeCore(3));
  const rawStore = await open(raw);
  assert.equal(rawStore.initialSnapshot?.texts.size, 0);
  assert.equal(rawStore.onDiskCount, -1);
  await rawStore.close();
});

// ---- Phase 1: write-ahead log ------------------------------------------------

test('append → records visible on reopen via initialReplay (B === S), without any checkpoint', async () => {
  const fs = new MemFS();
  const seed = await open(fs);
  seed.bind(producer({ count: 1 }));
  await commit(seed, 'insert', 'base'); // seq 1, log reset onto 1
  await seed.close();

  const store = await open(fs);
  store.bind(producer({ count: 1 }), { dims: DIMS });
  await store.append(ins('a', 0.5));
  await store.append({ kind: 'insert', id: 'ü-文', vector: new Float32Array(DIMS).fill(2), text: 'ünïcode 🦀' });
  await store.append({ kind: 'remove', id: 'a' });
  kill(fs); // tab killed: no flush(), no close()

  assert.equal(fs.seq('slot-a.bin'), 1n, 'no checkpoint happened');
  assert.equal(fs.files.get('slot-b.bin')!.length, 0);
  const reopened = await open(fs);
  assert.equal(reopened.initialSnapshot?.sequence, 1n);
  assert.equal(fs.wal().base, 1n, 'B === S');
  assert.deepEqual(
    reopened.initialReplay.map((r) => `${r.kind} ${r.id}`),
    ['insert a', 'insert ü-文', 'remove a'],
  );
  const second = reopened.initialReplay[1]!;
  assert.ok(second.kind === 'insert');
  assert.equal(second.text, 'ünïcode 🦀');
  assert.deepEqual(Array.from(second.vector), new Array(DIMS).fill(2));
  await reopened.close(); // unbound: writes nothing, the log stays
  assert.equal(fs.wal().records.length, 3);
});

test('a fresh store logs on top of "no snapshot" (B = 0) and replays it', async () => {
  const fs = new MemFS();
  const store = await open(fs);
  await store.append(ins('a'));
  await store.append(ins('b'));
  kill(fs);
  assert.equal(fs.wal().base, 0n);
  const reopened = await open(fs);
  assert.equal(reopened.initialSnapshot, null);
  assert.deepEqual(
    reopened.initialReplay.map((r) => r.id),
    ['a', 'b'],
  );
  await reopened.close();
});

test('checkpoint then reopen → initialReplay empty and the snapshot has the data', async () => {
  const fs = new MemFS();
  const store = await open(fs);
  const state = { count: 0 };
  store.bind(producer(state));
  for (const id of ['a', 'b', 'c']) {
    await store.append(ins(id));
    state.count++;
  }
  await store.flush();
  kill(fs);

  const reopened = await open(fs);
  assert.equal(reopened.initialSnapshot?.sequence, 1n);
  assert.equal(reopened.initialSnapshot?.meta?.count, 3);
  assert.deepEqual(reopened.initialReplay, []);
  await reopened.close();
});

test('crash between checkpoint commit and log reset (B < S) → replay empty, log reset, no double-apply', async () => {
  const fs = new MemFS();
  const store = await open(fs);
  const state = { count: 2 };
  store.bind(producer(state));
  await store.append(ins('a'));
  await store.append(ins('b'));
  // The disk as it stands just before the checkpoint's step (b): the slot will
  // be committed, the log not yet reset.
  const staleLog = fs.files.get('wal.bin')!.slice();
  await store.flush();
  kill(fs);
  fs.files.set('wal.bin', staleLog);
  assert.equal(fs.seq('slot-a.bin'), 1n);
  assert.equal(fs.wal().base, 0n);

  const reopened = await open(fs);
  assert.equal(reopened.initialSnapshot?.sequence, 1n, 'S = 1');
  assert.deepEqual(reopened.initialReplay, [], 'B = 0 < S: the records are already in the snapshot');
  assert.equal(fs.files.get('wal.bin')!.length, 0, 'the stale log is reset (header rewritten lazily)');

  // The next append rewrites the header on top of S, so it is replayed next time.
  reopened.bind(producer({ count: 3 }));
  await reopened.append(ins('c'));
  kill(fs);
  assert.equal(fs.wal().base, 1n);
  const third = await open(fs);
  assert.deepEqual(
    third.initialReplay.map((r) => r.id),
    ['c'],
  );
  await third.close();
});

test('crash mid log reset (header torn after truncate) → the log reads as empty, snapshot is current', async () => {
  const fs = new MemFS();
  const store = await open(fs);
  store.bind(producer({ count: 1 }));
  await store.append(ins('a'));
  fs.crashOn = 'wal.bin';
  fs.crashAfterBytes = 10; // the fresh header write after the slot commit
  await assert.rejects(store.flush(), /simulated tab kill/);
  kill(fs);
  assert.equal(fs.seq('slot-a.bin'), 1n, 'step (a) committed');
  assert.equal(fs.files.get('wal.bin')!.length, 10, 'a torn, header-less log');

  const reopened = await open(fs);
  assert.equal(reopened.initialSnapshot?.sequence, 1n);
  assert.deepEqual(reopened.initialReplay, []);
  reopened.bind(producer({ count: 2 }));
  await reopened.append(ins('b'));
  kill(fs);
  assert.deepEqual(fs.wal().base, 1n, 'the next append rewrote a clean header');
  assert.equal(fs.wal().records.length, 1);
});

test('crash after N bytes of a log append → the torn record is cut off, earlier records replay', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const fs = new MemFS();
  const store = await open(fs);
  await store.append(ins('a'));
  await store.append(ins('b'));
  const goodSize = fs.files.get('wal.bin')!.length;
  fs.crashOn = 'wal.bin';
  fs.crashAfterBytes = 37; // part-way through record c
  await assert.rejects(store.append(ins('c')), /simulated tab kill/);
  kill(fs);
  assert.equal(fs.files.get('wal.bin')!.length, goodSize + 37);

  const reopened = await open(fs);
  assert.deepEqual(
    reopened.initialReplay.map((r) => r.id),
    ['a', 'b'],
  );
  assert.equal(fs.files.get('wal.bin')!.length, goodSize, 'the torn tail is truncated on open');
  assert.equal(warn.mock.callCount(), 1);
  assert.match(String(warn.mock.calls[0]!.arguments[0]), /torn tail/);

  await reopened.append(ins('c'));
  kill(fs);
  const again = await open(fs);
  assert.deepEqual(
    again.initialReplay.map((r) => r.id),
    ['a', 'b', 'c'],
  );
  await again.close();
});

test('strict mode flushes the log on every append, before the append resolves', async () => {
  const fs = new MemFS();
  const store = await open(fs, { durability: 'strict' });
  for (let i = 0; i < 5; i++) {
    await store.append(ins(`s${i}`));
    assert.equal(fs.count('flush wal.bin'), i + 1, `append ${i} flushed`);
  }
  await store.close(); // unbound: no checkpoint
  assert.equal(fs.count('flush wal.bin'), 5);
});

test('relaxed mode flushes at most once per 50 ms window, and on close', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fs = new MemFS();
  const store = await open(fs, { durability: 'relaxed' });
  store.bind(producer({ count: 13 }));
  for (let i = 0; i < 10; i++) await store.append(ins(`r${i}`));
  assert.equal(fs.count('flush wal.bin'), 0, 'acknowledged before any flush');
  assert.equal(fs.wal().records.length, 10, 'but written');

  t.mock.timers.tick(49);
  assert.equal(fs.count('flush wal.bin'), 0);
  t.mock.timers.tick(1);
  assert.equal(fs.count('flush wal.bin'), 1, 'one flush for the whole window');
  t.mock.timers.tick(200);
  assert.equal(fs.count('flush wal.bin'), 1, 'no flush without new writes');

  for (let i = 10; i < 13; i++) await store.append(ins(`r${i}`));
  t.mock.timers.tick(50);
  assert.equal(fs.count('flush wal.bin'), 2);

  await store.append(ins('last'));
  const before = fs.log.length;
  await store.close();
  const closeLog = fs.log.slice(before);
  assert.equal(closeLog[0], 'flush wal.bin', 'close flushes the log before checkpointing');
  assert.ok(closeLog.includes('flush slot-a.bin'), 'then checkpoints');
  t.mock.timers.tick(1000); // the cancelled timer never fires on a closed store
});

test('checkpoint thresholds trigger: records (strict), bytes (strict), records (relaxed, on the timer)', async (t) => {
  // Records.
  const fs = new MemFS();
  const store = await open(fs, { checkpointRecords: 4 });
  const state = { count: 0 };
  store.bind(producer(state));
  for (let i = 0; i < 3; i++) {
    await store.append(ins(`k${i}`));
    state.count++;
  }
  assert.equal(fs.files.get('slot-a.bin')!.length, 0, 'below the threshold: no checkpoint');
  await store.append(ins('k3'));
  state.count++;
  await tick(); // the threshold checkpoint runs after the acknowledgement
  assert.equal(fs.seq('slot-a.bin'), 1n, 'the 4th record triggered a checkpoint');
  assert.deepEqual(fs.wal(), { base: 1n, records: [], size: 24 });
  await store.close();

  // Bytes: each insert record is 8 + 1 + 2 + 2 + 128 + 4 + text ≈ 160 bytes.
  const fsB = new MemFS();
  const byBytes = await open(fsB, { checkpointBytes: 400 });
  byBytes.bind(producer({ count: 3 }));
  await byBytes.append(ins('b0'));
  await byBytes.append(ins('b1'));
  assert.equal(fsB.files.get('slot-a.bin')!.length, 0);
  await byBytes.append(ins('b2')); // 24 + 3 × ~160 ≥ 400
  await tick();
  assert.equal(fsB.seq('slot-a.bin'), 1n);
  await byBytes.close();

  // Relaxed: the checkpoint waits for the flush timer.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fsR = new MemFS();
  const relaxed = await open(fsR, { durability: 'relaxed', checkpointRecords: 2 });
  relaxed.bind(producer({ count: 2 }));
  await relaxed.append(ins('x0'));
  await relaxed.append(ins('x1'));
  assert.equal(fsR.files.get('slot-a.bin')!.length, 0, 'not inside append in relaxed mode');
  t.mock.timers.tick(50);
  assert.equal(fsR.seq('slot-a.bin'), 1n, 'checkpointed on the timer');
  const flushLog = fsR.log.filter((l) => l.startsWith('flush'));
  assert.equal(flushLog[0], 'flush wal.bin', 'the log is flushed before the snapshot is written');
  await relaxed.close();
});

test('strict threshold checkpoint runs after the acknowledgement, not inside it; close() does not double it', async () => {
  const fs = new MemFS();
  const store = await open(fs, { checkpointRecords: 3 });
  const state = { count: 0 };
  store.bind(producer(state));
  for (let i = 0; i < 3; i++) {
    await store.append(ins(`d${i}`));
    state.count++;
  }
  assert.equal(fs.files.get('slot-a.bin')!.length, 0, 'the 3rd append resolved before any slot write');
  assert.equal(fs.count('write slot-a.bin') + fs.count('write slot-b.bin'), 0);
  assert.equal(fs.wal().records.length, 3, 'the record that tripped the threshold is already in the log');
  await tick();
  assert.equal(fs.seq('slot-a.bin'), 1n, 'the checkpoint landed after a macrotask');
  assert.deepEqual(fs.wal(), { base: 1n, records: [], size: 24 }, 'and reset the log');
  await store.close(); // nothing logged since: no second checkpoint
  assert.equal(fs.count('write slot-a.bin') + fs.count('write slot-b.bin'), 1);

  // close() before the scheduled checkpoint fires: exactly one checkpoint.
  const fsC = new MemFS();
  const closing = await open(fsC, { checkpointRecords: 3 });
  closing.bind(producer({ count: 3 }));
  for (let i = 0; i < 3; i++) await closing.append(ins(`c${i}`));
  assert.equal(fsC.files.get('slot-a.bin')!.length, 0);
  await closing.close();
  await tick(); // the cancelled timer must not checkpoint again
  assert.equal(fsC.count('write slot-a.bin') + fsC.count('write slot-b.bin'), 1, 'exactly one checkpoint');
  assert.equal(fsC.seq('slot-a.bin'), 1n);
  assert.equal(fsC.files.get('slot-b.bin')!.length, 0);
  assert.deepEqual(fsC.wal(), { base: 1n, records: [], size: 24 });
});

test('close() on an untouched store writes nothing (fresh and existing)', async () => {
  const fresh = new MemFS();
  const a = await open(fresh);
  a.bind(producer({ count: 0 }), { dims: DIMS });
  await a.close();
  assert.ok(
    fresh.log.every((l) => l.startsWith('close ')),
    `only closes: ${fresh.log.join(', ')}`,
  );

  const fs = new MemFS();
  const seed = await open(fs);
  seed.bind(producer({ count: 2 }));
  await commit(seed);
  await seed.close();
  fs.log.length = 0;
  const store = await open(fs);
  store.bind(producer({ count: 2 }), { dims: DIMS });
  await store.flush(); // nothing logged since the checkpoint: no-op too
  await store.close();
  assert.deepEqual(fs.log, ['close slot-a.bin', 'close slot-b.bin', 'close wal.bin']);
});

test('empty-overwrite guard fires on a threshold checkpoint without failing the acknowledged append', async (t) => {
  const error = t.mock.method(console, 'error', () => {});
  const fs = new MemFS();
  const seed = await open(fs);
  seed.bind(producer({ count: 3 }));
  await commit(seed);
  await seed.close();
  const slotA = fs.files.get('slot-a.bin')!.slice();

  const store = await open(fs, { checkpointRecords: 1 });
  store.bind(producer({ count: 0 })); // a failed rehydrate: empty in memory
  await store.append(ins('z')); // durable; the checkpoint it triggers is refused
  await tick();
  assert.equal(error.mock.callCount(), 1);
  assert.ok(error.mock.calls[0]!.arguments.some((a) => a instanceof EmptyOverwriteRefusedError));
  assert.deepEqual(fs.files.get('slot-a.bin'), slotA);
  assert.equal(fs.files.get('slot-b.bin')!.length, 0, 'nothing written');
  assert.equal(fs.wal().records.length, 1, 'the record is in the log');
  await assert.rejects(store.close(), EmptyOverwriteRefusedError);
});

test('replayed removes count as removes since open: a log that empties the index can checkpoint', async () => {
  const fs = new MemFS();
  const seed = await open(fs);
  seed.bind(producer({ count: 1 }));
  await commit(seed, 'insert', 'only');
  await seed.append({ kind: 'remove', id: 'only' });
  kill(fs);

  const store = await open(fs);
  assert.equal(store.onDiskCount, 1);
  assert.equal(store.initialReplay.length, 1);
  store.bind(producer({ count: 0 }));
  await store.close(); // checkpoints the empty index: not refused
  assert.equal(decodeSnapshot(fs.files.get('slot-b.bin')!).meta?.count, 0);
});

test('a remove as the first record of a fresh log uses the dims supplied at bind', async () => {
  const fs = new MemFS();
  const store = await open(fs);
  await assert.rejects(store.append({ kind: 'remove', id: 'ghost' }), /dims are unknown/);
  store.bind(producer({ count: 0 }), { dims: DIMS });
  await store.append({ kind: 'remove', id: 'ghost' });
  await store.append(ins('real'));
  kill(fs);
  const reopened = await open(fs);
  assert.equal(reopened.walDims, DIMS);
  assert.deepEqual(
    reopened.initialReplay.map((r) => `${r.kind} ${r.id}`),
    ['remove ghost', 'insert real'],
  );
  await reopened.close();
});

test('bad log header: discarded (with a warning) over a valid snapshot; StoreCorruptError with none', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const fs = new MemFS();
  const seed = await open(fs);
  seed.bind(producer({ count: 2 }));
  await commit(seed);
  await seed.close();
  fs.files.set('wal.bin', new TextEncoder().encode('definitely not a write-ahead log header'));
  const store = await open(fs);
  assert.equal(store.initialSnapshot?.sequence, 1n);
  assert.deepEqual(store.initialReplay, []);
  assert.equal(warn.mock.callCount(), 1);
  assert.match(String(warn.mock.calls[0]!.arguments[0]), /unreadable header/);
  await store.close();

  const bare = new MemFS();
  bare.files.set('wal.bin', new TextEncoder().encode('definitely not a write-ahead log header'));
  await assert.rejects(open(bare), (err: unknown) => {
    assert.ok(err instanceof StoreCorruptError);
    assert.deepEqual(err.slots, [{ file: 'wal.bin', reason: 'bad-header' }]);
    assert.match(err.message, /write-ahead log/);
    return true;
  });
  assert.equal(bare.open_.size, 0, 'all handles closed after a failed open');
});

test('log ahead of the snapshot (B > S) → StoreCorruptError wal-ahead-of-snapshot', async () => {
  const fs = new MemFS();
  const store = await open(fs);
  const state = { count: 1 };
  store.bind(producer(state));
  await commit(store); // seq 1 → slot-a
  state.count = 2;
  await commit(store); // seq 2 → slot-b, log based on 2
  await store.close();
  // The seq-2 checkpoint is lost after the fact (external damage): S falls back
  // to 1 while the log claims to apply on top of 2.
  fs.files.set('slot-b.bin', fs.files.get('slot-b.bin')!.slice(0, 50));
  await assert.rejects(open(fs), (err: unknown) => {
    assert.ok(err instanceof StoreCorruptError);
    assert.deepEqual(err.slots, [{ file: 'wal.bin', reason: 'wal-ahead-of-snapshot' }]);
    return true;
  });
  assert.equal(fs.open_.size, 0);
});

test('log dims different from the snapshot dims → StoreCorruptError dims-mismatch', async () => {
  const fs = new MemFS();
  const seed = await open(fs);
  seed.bind(producer({ count: 1 }));
  await commit(seed);
  await seed.close();
  const header = encodeWalHeader({ baseSequence: 1n, dims: 16 });
  const record = encodeWalRecord({ kind: 'insert', id: 'n', vector: new Float32Array(16), text: 'n' }, 16);
  const log = new Uint8Array(header.length + record.length);
  log.set(header);
  log.set(record, header.length);
  fs.files.set('wal.bin', log);
  await assert.rejects(open(fs), (err: unknown) => {
    assert.ok(err instanceof StoreCorruptError);
    assert.deepEqual(err.slots, [{ file: 'wal.bin', reason: 'dims-mismatch' }]);
    return true;
  });
});
