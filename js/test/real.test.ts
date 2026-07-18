/**
 * Real end-to-end semantic test: transformers.js MiniLM embeddings + the wasm
 * core, all default-loaded through Engine. Gated behind FERROVEC_REAL=1 because
 * the first run downloads ~23MB of model weights from the HF CDN.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Engine } from '../src/engine.ts';

const enabled = process.env.FERROVEC_REAL === '1';

test(
  'semantic ranking: cat/feline outrank physics for a kitten query',
  { skip: enabled ? false : 'set FERROVEC_REAL=1 to run (downloads MiniLM)' },
  async () => {
    // Default embedder (transformers.js, default wasm device) + default wasm core.
    const engine = await Engine.create();

    await engine.insert('the cat sat on the mat', 'cat');
    await engine.insert('a feline napped on a rug', 'feline');
    await engine.insert('quantum chromodynamics describes quarks', 'physics');
    assert.equal(engine.size(), 3);

    const results = await engine.query('a kitten resting on a carpet', 2);
    const ids = results.map((r) => r.id);

    // The two semantically-related texts must be the top 2, excluding physics.
    assert.equal(results.length, 2);
    assert.ok(!ids.includes('physics'), `physics leaked into top-2: [${ids.join(', ')}]`);
    assert.deepEqual(new Set(ids), new Set(['cat', 'feline']));

    // Scores should be sane cosine similarities (higher = closer), sorted.
    assert.ok((results[0]?.score ?? 0) >= (results[1]?.score ?? 0));
    assert.ok((results[0]?.text ?? '').length > 0);
  },
);
