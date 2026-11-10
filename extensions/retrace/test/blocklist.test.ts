import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_BLOCKLIST, hostMatches, isBlocked, parseBlocklist } from '../src/lib/blocklist.ts';

test('a plain pattern matches the host and its subdomains, nothing else', () => {
  assert.equal(hostMatches('paypal.com', 'paypal.com'), true);
  assert.equal(hostMatches('www.paypal.com', 'paypal.com'), true);
  assert.equal(hostMatches('notpaypal.com', 'paypal.com'), false);
  assert.equal(hostMatches('paypal.com.evil.test', 'paypal.com'), false);
});

test('* matches any run of characters, dots included', () => {
  assert.equal(hostMatches('mybank.example', '*bank*'), true);
  assert.equal(hostMatches('online.bank.co.uk', '*bank*'), true);
  assert.equal(hostMatches('login.example.com', 'login.*'), true);
  assert.equal(hostMatches('blog.example.com', 'login.*'), false);
  assert.equal(hostMatches('tenant.okta.com', '*.okta.com'), true);
  assert.equal(hostMatches('okta.com', '*.okta.com'), false);
});

test('matching is case-insensitive and ignores a trailing dot', () => {
  assert.equal(hostMatches('Mail.Google.COM.', 'mail.google.com'), true);
  assert.equal(hostMatches('ACCOUNTS.google.com', 'Accounts.Google.com'), true);
});

test('regex metacharacters in patterns are literal', () => {
  assert.equal(hostMatches('exampleXcom', 'example.com'), false);
  assert.equal(hostMatches('a+b.test', 'a+b.test'), true);
});

test('parseBlocklist: comments, blanks, URLs, ports and paths, duplicates', () => {
  assert.deepEqual(
    parseBlocklist(`
      # banks
      *bank*   # inline comment
      https://Mail.Example.com/inbox?x=1
      intranet.local:8443
      wiki.example.org/private
      *bank*
    `),
    ['*bank*', 'mail.example.com', 'intranet.local', 'wiki.example.org'],
  );
});

test('isBlocked: URLs and hosts against the default list', () => {
  const list = [...DEFAULT_BLOCKLIST];
  for (const url of [
    'https://www.chase.com/account',
    'https://onlinebanking.example.com/',
    'https://mail.google.com/mail/u/0/',
    'https://accounts.google.com/signin',
    'https://login.microsoftonline.com/',
    'https://mychart.hospital.example/',
    'https://www.healthline.com/nutrition',
    'http://mybank.test/statement',
  ]) {
    assert.equal(isBlocked(url, list), true, url);
  }
  for (const url of [
    'https://en.wikipedia.org/wiki/HNSW',
    'https://news.ycombinator.com/item?id=1',
    'https://docs.rs/ferrovec',
    'http://bread.test/sourdough-starter',
    'https://www.google.com/search?q=x',
  ]) {
    assert.equal(isBlocked(url, list), false, url);
  }
});

test('isBlocked: an empty list blocks nothing; an unparseable URL is treated as blocked', () => {
  assert.equal(isBlocked('https://mybank.example/', []), false);
  assert.equal(isBlocked('https://', DEFAULT_BLOCKLIST), true);
  assert.equal(isBlocked('example.com', ['example.com']), true, 'bare hosts work too');
});

test('every default pattern is already normalised', () => {
  const patterns = DEFAULT_BLOCKLIST.filter((l) => !l.startsWith('#'));
  assert.deepEqual(parseBlocklist(DEFAULT_BLOCKLIST), patterns);
});
