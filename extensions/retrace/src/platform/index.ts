/**
 * The platform seam. Retrace's modules import browser facilities from here,
 * never from `chrome.*` directly; a Firefox build swaps the implementation.
 */
export * from './chrome.ts';
