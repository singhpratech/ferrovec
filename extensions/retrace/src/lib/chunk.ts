/**
 * Split extracted page text into passages of roughly {@link ChunkOptions.minWords}
 * to {@link ChunkOptions.maxWords} words, cutting on paragraph boundaries when
 * possible and on sentence boundaries otherwise. Only the first
 * {@link ChunkOptions.maxChunks} passages are kept.
 *
 * Paragraphs are separated by one or more newlines in the input (the content
 * script emits one paragraph per block element).
 */

export interface ChunkOptions {
  /** A passage that has reached this many words is closed at the next paragraph break. */
  minWords?: number;
  /** A passage never grows past this many words (a single longer sentence is split by words). */
  maxWords?: number;
  /** Keep only the first N passages. */
  maxChunks?: number;
  /** A trailing passage shorter than this is merged into the one before it. */
  minTailWords?: number;
}

export const DEFAULT_CHUNK_OPTIONS: Required<ChunkOptions> = {
  minWords: 180,
  maxWords: 220,
  maxChunks: 12,
  minTailWords: 60,
};

export interface Chunk {
  text: string;
  words: number;
}

interface Unit {
  text: string;
  words: number;
  /** The unit starts a new paragraph. */
  paragraphStart: boolean;
}

export function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/** Split a paragraph into sentences (keeping the terminator with its sentence). */
export function splitSentences(paragraph: string): string[] {
  const parts = paragraph.split(/(?<=[.!?…][)"'”’\]]*)\s+(?=\S)/u);
  return parts.map((s) => s.trim()).filter(Boolean);
}

function toUnits(text: string, maxWords: number): Unit[] {
  const units: Unit[] = [];
  const paragraphs = text
    .split(/\n+/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  for (const paragraph of paragraphs) {
    let first = true;
    for (const sentence of splitSentences(paragraph)) {
      const words = sentence.split(' ').filter(Boolean);
      // A run-on "sentence" longer than a passage is cut into word windows.
      for (let i = 0; i < words.length; i += maxWords) {
        const slice = words.slice(i, i + maxWords);
        units.push({ text: slice.join(' '), words: slice.length, paragraphStart: first });
        first = false;
      }
    }
  }
  return units;
}

export function chunkText(text: string, options: ChunkOptions = {}): Chunk[] {
  const { minWords, maxWords, maxChunks, minTailWords } = { ...DEFAULT_CHUNK_OPTIONS, ...options };
  const units = toUnits(text, maxWords);
  const chunks: Chunk[] = [];
  let parts: string[] = [];
  let words = 0;

  const close = (): void => {
    if (words > 0) chunks.push({ text: parts.join(''), words });
    parts = [];
    words = 0;
  };

  for (let i = 0; i < units.length; i++) {
    const unit = units[i]!;
    if (words > 0 && words + unit.words > maxWords) close();
    if (chunks.length >= maxChunks) break;
    if (words > 0) parts.push(unit.paragraphStart ? '\n\n' : ' ');
    parts.push(unit.text);
    words += unit.words;
    // Prefer to end a passage on a paragraph break once it is long enough.
    const next = units[i + 1];
    if (words >= minWords && (next === undefined || next.paragraphStart)) close();
    if (chunks.length >= maxChunks) break;
  }
  if (chunks.length < maxChunks) close();

  // Fold a short tail into its predecessor rather than index a scrap.
  if (chunks.length >= 2) {
    const tail = chunks[chunks.length - 1]!;
    if (tail.words < minTailWords) {
      chunks.pop();
      const prev = chunks[chunks.length - 1]!;
      prev.text = `${prev.text}\n\n${tail.text}`;
      prev.words += tail.words;
    }
  }
  return chunks.slice(0, maxChunks);
}
