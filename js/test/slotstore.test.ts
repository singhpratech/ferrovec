/**
 * A/B slot store under Node, against an in-memory {@link SlotFileSystem} fake
 * whose writes can "crash" after N bytes (throw, leaving a partial file) to
 * simulate a tab killed mid-commit. Backs exit criteria (3) — a valid on-disk
 * index is never overwritten by an empty one — and (4) — a crash mid-write
 * always leaves the previous committed version intact.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { EmptyOverwriteRefusedError, StoreCorruptError } from '../src/errors.ts';
import {
  SlotStore,
  type SlotFile,
  type SlotFileSystem,
  type SnapshotSource,
  type StoreFile,
} from '../src/persistence.ts';
import { decodeSnapshot } from '../src/snapshot.ts';

const DEBOUNCE = 60_000; // never fires during a test; flush()/close() commit explicitly

class MemFS implements SlotFileSystem {
  readonly files = new Map<string, Uint8Array>();
  readonly log: string[] = [];
  readonly open_ = new Set<MemFile>();
  /** When set, the next write stores only this many bytes and then throws. */
  crashAfterBytes: number | null = null;

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
}

class MemFile implements SlotFile {
  readonly fs: MemFS;
  readonly name: string;

  constructor(fs: MemFS, name: string) {
    this.fs = fs;
    this.name = name;
  }

  #data(): Uint8Array {
    return this.fs.files.get(this.name)!;
  }

  read(buffer: Uint8Array, { at }: { at: number }): number {
    const data = this.#data();
    const n = Math.max(0, Math.min(buffer.length, data.length - at));
    buffer.set(data.subarray(at, at + n));
    return n;
  }

  write(buffer: Uint8Array, { at }: { at: number }): number {
    const crash = this.fs.crashAfterBytes;
    const len = crash === null ? buffer.length : Math.min(buffer.length, crash);
    const data = this.#data();
    const next = new Uint8Array(Math.max(data.length, at + len));
    next.set(data);
    next.set(buffer.subarray(0, len), at);
    this.fs.files.set(this.name, next);
    this.fs.log.push(`write ${this.name}`);
    if (crash !== null) {
      this.fs.crashAfterBytes = null;
      throw new Error('simulated tab kill mid-write');
    }
    return len;
  }

  truncate(newSize: number): void {
    this.fs.files.set(this.name, this.#data().slice(0, newSize));
  }

  getSize(): number {
    return this.#data().length;
  }

  flush(): void {
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
      embeddingSpace: { model: 'fake-fnv1a-32', dims: 32, metric: 'cosine' },
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

async function commit(store: SlotStore, kind: 'insert' | 'remove' = 'insert'): Promise<void> {
  store.markDirty(kind);
  await store.flush();
}

/** Abandon a store as a killed tab would: its handles simply go away. */
function kill(fs: MemFS): void {
  fs.open_.clear();
}

test('fresh open alternates slot-a / slot-b with increasing sequence', async () => {
  const fs = new MemFS();
  const store = await SlotStore.open(fs, { debounceMs: DEBOUNCE });
  assert.equal(store.initialSnapshot, null);
  assert.equal(store.nextSequence, 1n);
  assert.equal(fs.files.has('index.bin'), false, 'the legacy probe must not create index.bin');

  const state = { count: 1 };
  store.bind(producer(state));

  await commit(store);
  assert.equal(fs.seq('slot-a.bin'), 1n);
  assert.equal(fs.files.get('slot-b.bin')!.length, 0);

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

  const reopened = await SlotStore.open(fs, { debounceMs: DEBOUNCE });
  assert.equal(reopened.initialSnapshot?.sequence, 3n);
  assert.equal(reopened.initialSnapshot?.texts.size, 3);
  assert.equal(reopened.nextSequence, 4n);
  await reopened.close();
});

test('crash mid-write of sequence 3 recovers sequence 2, then repairs the torn slot', async () => {
  const fs = new MemFS();
  const store = await SlotStore.open(fs, { debounceMs: DEBOUNCE });
  const state = { count: 1 };
  store.bind(producer(state));
  await commit(store); // seq 1 → slot-a
  state.count = 2;
  await commit(store); // seq 2 → slot-b
  const slotB = fs.files.get('slot-b.bin')!.slice();

  state.count = 5; // a larger snapshot, torn halfway
  fs.crashAfterBytes = 100;
  store.markDirty('insert');
  await assert.rejects(store.flush(), /simulated tab kill/);
  kill(fs);

  assert.throws(() => fs.seq('slot-a.bin'), 'slot-a must now be torn');
  assert.deepEqual(fs.files.get('slot-b.bin'), slotB, 'the other slot is untouched');

  const reopened = await SlotStore.open(fs, { debounceMs: DEBOUNCE });
  assert.equal(reopened.initialSnapshot?.sequence, 2n, 'recovers the previous commit');
  assert.equal(reopened.initialSnapshot?.meta?.count, 2);
  assert.equal(reopened.nextSequence, 3n);

  reopened.bind(producer({ count: 3 }));
  await commit(reopened);
  assert.equal(fs.seq('slot-a.bin'), 3n, 'the next commit overwrites the torn slot');
  assert.equal(fs.seq('slot-b.bin'), 2n);
  await reopened.close();
});

test('both slots corrupt → StoreCorruptError listing both slots', async () => {
  const fs = new MemFS();
  fs.files.set('slot-a.bin', new TextEncoder().encode('not a snapshot at all'));
  fs.files.set('slot-b.bin', new Uint8Array([0x46, 0x56, 0x53, 0x32, 0, 2]));
  await assert.rejects(SlotStore.open(fs, { debounceMs: DEBOUNCE }), (err: unknown) => {
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
  await assert.rejects(SlotStore.open(fs, { debounceMs: DEBOUNCE }), (err: unknown) => {
    assert.ok(err instanceof StoreCorruptError);
    assert.deepEqual(err.slots, [{ file: 'index.bin', reason: 'bad-magic' }]);
    return true;
  });
  assert.equal(fs.open_.size, 0);
});

test('legacy migration: FVS1 index.bin → slot-a seq 1, index.bin removed', async () => {
  const fs = new MemFS();
  fs.files.set('index.bin', fvs1(fakeCore(2), [['cat', 'the cat sat on the mat']]));

  const store = await SlotStore.open(fs, { debounceMs: DEBOUNCE });
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
  const seed = await SlotStore.open(fs, { debounceMs: DEBOUNCE });
  seed.bind(producer({ count: 3 }));
  await commit(seed);
  await seed.close();

  const store = await SlotStore.open(fs, { debounceMs: DEBOUNCE });
  assert.equal(store.onDiskCount, 3);
  const before = { a: fs.files.get('slot-a.bin')!.slice(), b: fs.files.get('slot-b.bin')!.slice() };
  store.bind(producer({ count: 0 }));

  store.markDirty('insert');
  await assert.rejects(store.flush(), (err: unknown) => {
    assert.ok(err instanceof EmptyOverwriteRefusedError);
    assert.equal(err.onDiskCount, 3);
    return true;
  });
  assert.deepEqual(fs.files.get('slot-a.bin'), before.a, 'slot-a unchanged');
  assert.deepEqual(fs.files.get('slot-b.bin'), before.b, 'slot-b unchanged');

  store.markDirty('remove');
  await store.flush();
  const committed = decodeSnapshot(fs.files.get('slot-b.bin')!);
  assert.equal(committed.sequence, 2n);
  assert.equal(committed.meta?.count, 0, 'after a remove the empty snapshot IS committed');
  assert.equal(store.onDiskCount, 0);
  await store.close();
});

test('close() commits pending dirty data before closing both handles', async () => {
  const fs = new MemFS();
  const store = await SlotStore.open(fs, { debounceMs: DEBOUNCE });
  store.bind(producer({ count: 2 }));
  store.markDirty('insert');
  await store.close();

  assert.equal(fs.seq('slot-a.bin'), 1n);
  const flushAt = fs.log.indexOf('flush slot-a.bin');
  assert.ok(flushAt >= 0);
  assert.ok(flushAt < fs.log.indexOf('close slot-a.bin'), 'commit precedes handle close');
  assert.ok(flushAt < fs.log.indexOf('close slot-b.bin'));
  assert.equal(fs.open_.size, 0);
  await store.close(); // idempotent
});

test('close() still closes both handles and rethrows when the final commit throws', async () => {
  const fs = new MemFS();
  const store = await SlotStore.open(fs, { debounceMs: DEBOUNCE });
  store.bind(() => {
    throw new Error('producer exploded');
  });
  store.markDirty('insert');
  await assert.rejects(store.close(), /producer exploded/);
  assert.equal(fs.open_.size, 0, 'both handles closed despite the failed commit');
  assert.equal(fs.files.get('slot-a.bin')!.length, 0, 'nothing written');
});

test('close() before bind() never writes (the coordinator closes an unbound store on mismatch)', async () => {
  const fs = new MemFS();
  const seed = await SlotStore.open(fs, { debounceMs: DEBOUNCE });
  seed.bind(producer({ count: 2 }));
  await commit(seed);
  await seed.close();
  const snapshotBefore = fs.files.get('slot-a.bin')!.slice();
  fs.log.length = 0;

  const store = await SlotStore.open(fs, { debounceMs: DEBOUNCE });
  store.markDirty('insert'); // even if something marked it dirty, there is no producer
  await store.close();
  assert.deepEqual(fs.log, ['close slot-a.bin', 'close slot-b.bin'], 'no write/flush happened');
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
  const first = await SlotStore.open(fs, { debounceMs: DEBOUNCE });
  first.bind(producer({ count: 2 }));
  fs.crashAfterBytes = 40;
  first.markDirty('insert');
  await assert.rejects(first.flush(), /simulated tab kill/);
  kill(fs);
  assert.ok(fs.files.get('slot-a.bin')!.length > 0, 'slot-a is torn, not empty');
  assert.throws(() => fs.seq('slot-a.bin'));
  assert.equal(fs.files.get('slot-b.bin')!.length, 0);
  assert.equal(fs.files.has('index.bin'), true, 'legacy file survives a failed commit');

  const store = await SlotStore.open(fs, { debounceMs: DEBOUNCE });
  assert.equal(store.initialSnapshot?.formatVersion, 1, 'opens from the legacy file');
  assert.equal(store.initialSnapshot?.texts.get('dog'), 'a dog chased the ball');
  assert.equal(store.nextSequence, 1n);
  assert.equal(store.onDiskCount, 2);
  assert.equal(warn.mock.callCount(), 1, 'warns once about the torn slot');
  assert.match(String(warn.mock.calls[0]!.arguments[0]), /torn slot-a\.bin/);

  store.bind(producer({ count: 2 }));
  await commit(store);
  await store.close();
  assert.equal(fs.seq('slot-a.bin'), 1n, 'the next commit overwrites the torn slot');
  assert.equal(fs.files.has('index.bin'), false, 'legacy file removed after the successful commit');
  assert.equal(fs.open_.size, 0);
});

test('torn slot-b + empty slot-a + no index.bin → StoreCorruptError (a torn fresh store stays an error)', async () => {
  const fs = new MemFS();
  fs.files.set('slot-b.bin', new Uint8Array([0x46, 0x56, 0x53, 0x32, 0, 2, 0, 0, 0, 0]));
  await assert.rejects(SlotStore.open(fs, { debounceMs: DEBOUNCE }), (err: unknown) => {
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
  const store = await SlotStore.open(fs, { debounceMs: DEBOUNCE });
  assert.equal(store.initialSnapshot?.formatVersion, 1);
  assert.equal(store.onDiskCount, 3);

  store.bind(producer({ count: 0 }));
  store.markDirty('insert');
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
  const rawStore = await SlotStore.open(raw, { debounceMs: DEBOUNCE });
  assert.equal(rawStore.initialSnapshot?.texts.size, 0);
  assert.equal(rawStore.onDiskCount, -1);
  await rawStore.close();
});
