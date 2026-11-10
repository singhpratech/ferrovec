import { DEFAULT_BLOCKLIST, parseBlocklist } from './blocklist.ts';
import type { Settings } from './types.ts';

/** Pages with less extracted text than this are not indexed. */
export const MIN_TEXT_CHARS = 400;
/** Extracted text is cut to this many characters (far more than 12 passages need). */
export const MAX_TEXT_CHARS = 60_000;

export function defaultSettings(): Settings {
  return { paused: false, blocklist: [...DEFAULT_BLOCKLIST] };
}

/** Fill gaps in stored settings with defaults (first run, or a partial write). */
export function withDefaults(stored: Partial<Settings> | undefined): Settings {
  const base = defaultSettings();
  return {
    paused: typeof stored?.paused === 'boolean' ? stored.paused : base.paused,
    blocklist: Array.isArray(stored?.blocklist) ? stored.blocklist : base.blocklist,
  };
}

/** The effective patterns of a settings object. */
export function blocklistPatterns(settings: Settings): string[] {
  return parseBlocklist(settings.blocklist);
}
