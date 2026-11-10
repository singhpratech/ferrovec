import { test } from 'node:test';
import assert from 'node:assert/strict';

import { embeddingText, passageText } from '../src/lib/embed.ts';

test('embeddingText: passage alone, or "title. passage"', () => {
  assert.equal(embeddingText('passage', 'Coral bleaching', 'Corals expel algae.'), 'Corals expel algae.');
  assert.equal(embeddingText('title', 'Coral bleaching', 'Corals expel algae.'), 'Coral bleaching. Corals expel algae.');
  assert.equal(embeddingText('title', '  ', 'Corals expel algae.'), 'Corals expel algae.', 'no title, no prefix');
});

test('passageText strips exactly the title prefix it added, and nothing else', () => {
  assert.equal(passageText('Coral bleaching. Corals expel algae.', 'Coral bleaching'), 'Corals expel algae.');
  assert.equal(passageText('Corals expel algae.', 'Coral bleaching'), 'Corals expel algae.');
  assert.equal(passageText('Coral bleaching is common.', 'Coral bleaching'), 'Coral bleaching is common.');
  assert.equal(passageText('Text.', ''), 'Text.');
});
