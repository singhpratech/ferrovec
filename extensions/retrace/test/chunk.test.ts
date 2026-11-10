import { test } from 'node:test';
import assert from 'node:assert/strict';

import { chunkText, splitSentences, wordCount } from '../src/lib/chunk.ts';

/** A sentence of exactly `n` words, ending in a period. */
function sentence(n: number, word = 'word'): string {
  return `${Array.from({ length: n }, (_, i) => `${word}${i}`).join(' ')}.`;
}

/** A paragraph of `sentences` sentences of `words` words each. */
function paragraph(sentences: number, words: number, word = 'w'): string {
  return Array.from({ length: sentences }, (_, i) => sentence(words, `${word}${i}x`)).join(' ');
}

test('splitSentences keeps terminators and closing quotes with their sentence', () => {
  assert.deepEqual(splitSentences('One two. Three "four!" Five? Six…  Seven'), [
    'One two.',
    'Three "four!"',
    'Five?',
    'Six…',
    'Seven',
  ]);
});

test('short text: a single chunk with the whole text', () => {
  const chunks = chunkText('Just a short page.\nWith two paragraphs.');
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0]!.text, 'Just a short page.\n\nWith two paragraphs.');
  assert.equal(chunks[0]!.words, 7);
});

test('empty and whitespace-only text yields no chunks', () => {
  assert.deepEqual(chunkText(''), []);
  assert.deepEqual(chunkText('  \n\n \t '), []);
});

test('chunks land in the 180-220 word band and split on paragraph boundaries when possible', () => {
  // Paragraphs of 100 words: two make 200 (in band), a third would overflow.
  const text = Array.from({ length: 10 }, (_, i) => paragraph(5, 20, `p${i}`)).join('\n');
  const chunks = chunkText(text);
  assert.equal(chunks.length, 5);
  for (const c of chunks) {
    assert.equal(c.words, 200);
    assert.equal(c.text.split('\n\n').length, 2, 'two whole paragraphs per chunk');
  }
});

test('a long paragraph is split on sentence boundaries, never mid-sentence', () => {
  const text = paragraph(30, 15); // 450 words, one paragraph
  const chunks = chunkText(text);
  assert.ok(chunks.length >= 2);
  for (const c of chunks) {
    assert.ok(c.words <= 220 + 59, `chunk of ${c.words} words`);
    assert.ok(c.text.endsWith('.'), 'ends on a sentence boundary');
  }
  assert.equal(
    chunks.reduce((n, c) => n + c.words, 0),
    450,
    'no words lost or duplicated',
  );
});

test('a run-on sentence longer than a chunk is cut into word windows', () => {
  const text = sentence(500);
  const chunks = chunkText(text);
  assert.deepEqual(
    chunks.map((c) => c.words),
    [220, 220, 60],
  );
});

test('a short trailing scrap is merged into the previous chunk', () => {
  const text = `${paragraph(2, 100)}\n${sentence(20)}`; // 200 + 20
  const chunks = chunkText(text);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0]!.words, 220);
});

test('only the first 12 chunks are kept', () => {
  const text = Array.from({ length: 40 }, (_, i) => paragraph(5, 20, `P${i}_`)).join('\n'); // 20 chunks' worth
  const chunks = chunkText(text);
  assert.equal(chunks.length, 12);
  assert.ok(chunks[0]!.text.startsWith('P0_'), 'the first chunks, not the last');
  assert.ok(chunks[11]!.text.includes('P23_'));
  assert.ok(!chunks.some((c) => c.text.includes('P24_')));
  assert.deepEqual(
    chunkText(text, { maxChunks: 3 }).map((c) => c.words),
    [200, 200, 200],
  );
});

test('whitespace inside paragraphs is normalised; blank lines between them are collapsed', () => {
  const chunks = chunkText('  alpha \t beta\n\n\n\ngamma   delta  ');
  assert.equal(chunks[0]!.text, 'alpha beta\n\ngamma delta');
  assert.equal(wordCount(chunks[0]!.text), 4);
});
