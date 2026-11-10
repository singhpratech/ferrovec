/**
 * Host blocklist. One pattern per line; `#` starts a comment.
 *
 * - A pattern without `*` matches that host and every subdomain of it
 *   (`paypal.com` matches `www.paypal.com`).
 * - `*` matches any run of characters, dots included (`*bank*` matches
 *   `mybank.example` and `bank.co.uk`; `login.*` matches `login.example.com`).
 * - A full URL is accepted and reduced to its host.
 *
 * Matching is case-insensitive and ignores the port.
 */

import { hostOf } from './url.ts';

/**
 * The default list: deliberately broad. It is better to miss indexing a
 * harmless page on a matching host than to index a bank statement; every entry
 * can be removed in the privacy settings.
 */
export const DEFAULT_BLOCKLIST: readonly string[] = [
  '# Banking, payments, investing',
  '*bank*',
  'paypal.com',
  'venmo.com',
  'wise.com',
  'revolut.com',
  'chase.com',
  'wellsfargo.com',
  'capitalone.com',
  'americanexpress.com',
  'schwab.com',
  'fidelity.com',
  'vanguard.com',
  'coinbase.com',
  '# Webmail and messaging',
  'mail.google.com',
  'outlook.live.com',
  'outlook.office.com',
  'outlook.office365.com',
  'mail.yahoo.com',
  'mail.proton.me',
  'app.fastmail.com',
  'web.whatsapp.com',
  'messages.google.com',
  'web.telegram.org',
  '# Health',
  '*health*',
  '*patient*',
  '*pharmacy*',
  'mychart.*',
  '# Sign-in and identity',
  'accounts.google.com',
  'login.*',
  'signin.*',
  'auth.*',
  'sso.*',
  '*.okta.com',
  '# Password managers',
  '*.1password.com',
  'vault.bitwarden.com',
];

/** Patterns from a list or a newline-separated text, comments and blanks dropped, normalised. */
export function parseBlocklist(input: string | readonly string[]): string[] {
  const lines = typeof input === 'string' ? input.split(/\r?\n/) : input;
  const out: string[] = [];
  for (const line of lines) {
    const raw = line.replace(/#.*/, '').trim().toLowerCase();
    if (!raw) continue;
    const pattern = /^[a-z][a-z0-9+.-]*:\/\//.test(raw) ? hostOf(raw) : raw.replace(/:\d+$/, '').replace(/\/.*$/, '');
    if (pattern && !out.includes(pattern)) out.push(pattern);
  }
  return out;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}

/** Does host `host` match one pattern (see the module docs for the syntax)? */
export function hostMatches(host: string, pattern: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  const p = pattern.toLowerCase();
  if (!p) return false;
  if (!p.includes('*')) return h === p || h.endsWith(`.${p}`);
  const re = new RegExp(`^${escapeRegExp(p).replace(/\*/g, '.*')}$`);
  return re.test(h);
}

/** Is `url` (or a bare host) on the blocklist? Unparseable input is treated as blocked. */
export function isBlocked(urlOrHost: string, patterns: readonly string[]): boolean {
  const host = urlOrHost.includes('://') ? hostOf(urlOrHost) : urlOrHost.toLowerCase();
  if (!host) return true;
  return parseBlocklist(patterns).some((p) => hostMatches(host, p));
}
