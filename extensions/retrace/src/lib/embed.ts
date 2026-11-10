/**
 * What text is embedded (and stored) for a passage.
 *
 * - `'passage'`: the passage alone.
 * - `'title'`: `"<page title>. <passage>"`, so every passage carries what the
 *   page is about. The stored text then starts with the title; results show
 *   it without (see {@link passageText}).
 *
 * The format is part of the store's schema: vectors made one way cannot be
 * compared with queries expecting the other, so a change needs a re-embed.
 */

export type EmbedFormat = 'passage' | 'title';

export function embeddingText(format: EmbedFormat, title: string, passage: string): string {
  const t = title.trim();
  return format === 'title' && t ? `${t}. ${passage}` : passage;
}

/** The passage part of stored text (strips a leading `"<title>. "` if present). */
export function passageText(stored: string, title: string): string {
  const prefix = `${title.trim()}. `;
  return title.trim() && stored.startsWith(prefix) ? stored.slice(prefix.length) : stored;
}
