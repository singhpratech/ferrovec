/** SHA-256 helpers (Web Crypto: available in extension contexts and Node). */

const encoder = new TextEncoder();

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Stable 16-hex-char id prefix for a normalised URL; passage ids are `${urlHash}:${i}`. */
export async function urlHash(normalizedUrl: string): Promise<string> {
  return (await sha256Hex(normalizedUrl)).slice(0, 16);
}

/** Passage id for passage `i` of the page whose URL hashes to `hash`. */
export function chunkId(hash: string, i: number): string {
  return `${hash}:${i}`;
}
