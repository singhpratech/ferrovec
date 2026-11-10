/**
 * The `transformers` option: transformers.js `env` settings and the pipeline
 * `dtype`, carried from `Ferrovec.open` through the worker protocol and
 * `Engine.create` to the default embedder, and applied before the model loads.
 *
 * Fully offline: the real-transformers cases disable remote models and point
 * `localModelPath` at a directory that does not exist, so the only way they can
 * finish is transformers.js refusing with its local-only error — which proves
 * the settings reached it before any download was attempted.
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';

import { applyTransformersEnv, createTransformersEmbedder } from '../src/embedder.ts';
import { Engine } from '../src/engine.ts';
import { Ferrovec } from '../src/ferrovec.ts';
import type { TransformersEnvTarget } from '../src/embedder.ts';

const MISSING = '/nonexistent-ferrovec-models/';
const LOCAL_ONLY = /allowRemoteModels=false.*not found locally/s;

test('applyTransformersEnv copies the listed keys and leaves the rest alone', () => {
  const env: TransformersEnvTarget = {
    allowRemoteModels: true,
    localModelPath: '/models/',
    remoteHost: 'https://huggingface.co/',
    somethingElse: 'kept',
    backends: { onnx: { wasm: { wasmPaths: 'https://cdn.example/', proxy: false } } },
  };
  applyTransformersEnv(env, {
    allowRemoteModels: false,
    allowLocalModels: true,
    localModelPath: 'chrome-extension://abc/models/',
    useBrowserCache: false,
    useWasmCache: false,
    remoteHost: undefined,
    wasmPaths: { mjs: '/ort/a.mjs', wasm: '/ort/a.wasm' },
    numThreads: 1,
  });
  assert.equal(env.allowRemoteModels, false);
  assert.equal(env.allowLocalModels, true);
  assert.equal(env.localModelPath, 'chrome-extension://abc/models/');
  assert.equal(env.useBrowserCache, false);
  assert.equal(env.useWasmCache, false);
  assert.equal(env.remoteHost, 'https://huggingface.co/', 'undefined keys are not applied');
  assert.equal(env.somethingElse, 'kept');
  assert.deepEqual(env.backends?.onnx?.wasm, {
    wasmPaths: { mjs: '/ort/a.mjs', wasm: '/ort/a.wasm' },
    proxy: false,
    numThreads: 1,
  });
});

test('applyTransformersEnv: string wasmPaths, a missing wasm object, no onnx backend, no options', () => {
  const env: TransformersEnvTarget = { backends: { onnx: {} } };
  applyTransformersEnv(env, { wasmPaths: '/ort/' });
  assert.deepEqual(env.backends?.onnx?.wasm, { wasmPaths: '/ort/' });

  const bare: TransformersEnvTarget = {};
  applyTransformersEnv(bare, { wasmPaths: '/ort/', allowRemoteModels: false });
  assert.deepEqual(bare, { allowRemoteModels: false }, 'no onnx backend → wasm settings skipped');

  const untouched: TransformersEnvTarget = { allowRemoteModels: true };
  applyTransformersEnv(untouched, undefined);
  applyTransformersEnv(untouched, {});
  assert.deepEqual(untouched, { allowRemoteModels: true });
});

test('applyTransformersEnv ignores keys outside TransformersEnvOptions', () => {
  const env: TransformersEnvTarget = {};
  applyTransformersEnv(env, { cacheDir: '/x', allowRemoteModels: false } as never);
  assert.deepEqual(env, { allowRemoteModels: false });
});

// The real transformers.js `env` is a module singleton: snapshot and restore it.
const restoreEnv: Array<() => void> = [];
after(() => {
  for (const restore of restoreEnv.reverse()) restore();
});
async function snapshotRealEnv(): Promise<void> {
  const { env } = await import('@huggingface/transformers');
  const saved = { allowRemoteModels: env.allowRemoteModels, localModelPath: env.localModelPath };
  restoreEnv.push(() => Object.assign(env, saved));
}

test('createTransformersEmbedder applies env before loading: remote models off → local-only error', async () => {
  await snapshotRealEnv();
  await assert.rejects(
    createTransformersEmbedder({
      transformers: { env: { allowRemoteModels: false, localModelPath: MISSING }, dtype: 'q8' },
    }),
    (err: Error) => {
      assert.match(err.message, LOCAL_ONLY);
      assert.ok(err.message.includes(MISSING), 'looked in the configured localModelPath');
      return true;
    },
  );
  const { env } = await import('@huggingface/transformers');
  assert.equal(env.allowRemoteModels, false);
  assert.equal(env.localModelPath, MISSING);
});

test('Engine.create forwards `transformers` to the default embedder', async () => {
  await snapshotRealEnv();
  const elsewhere = '/another-missing-ferrovec-dir/';
  await assert.rejects(
    Engine.create({ transformers: { env: { allowRemoteModels: false, localModelPath: elsewhere } } }),
    (err: Error) => {
      assert.match(err.message, LOCAL_ONLY);
      assert.ok(err.message.includes(elsewhere));
      return true;
    },
  );
});

/** A stand-in for the browser `Worker` that records what `Ferrovec` posts. */
class RecordingWorker {
  static posted: Array<Record<string, unknown>> = [];
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  postMessage(message: Record<string, unknown>): void {
    RecordingWorker.posted.push(message);
    queueMicrotask(() =>
      this.onmessage?.({
        data: { id: message.id, ok: true, result: { ready: true, persistent: false, role: 'solo' } },
      }),
    );
  }
  terminate(): void {}
}

test('Ferrovec.open sends `transformers` to the worker, and omits it when not given', async () => {
  const g = globalThis as unknown as { Worker?: unknown };
  const original = g.Worker;
  g.Worker = RecordingWorker;
  try {
    const transformers = {
      dtype: 'q8',
      env: { allowRemoteModels: false, wasmPaths: { mjs: '/ort/x.mjs', wasm: '/ort/x.wasm' } },
    };
    await Ferrovec.open('a', { requestPersistentStorage: false, transformers });
    await Ferrovec.open('b', { requestPersistentStorage: false });
    const [withOption, without] = RecordingWorker.posted;
    assert.equal(withOption?.type, 'open');
    assert.deepEqual(withOption?.transformers, transformers);
    assert.equal(without?.type, 'open');
    assert.ok(!('transformers' in (without ?? {})), 'no key when the option is omitted');
  } finally {
    g.Worker = original;
  }
});
