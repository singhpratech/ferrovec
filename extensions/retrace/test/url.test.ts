import { test } from 'node:test';
import assert from 'node:assert/strict';

import { hostOf, isTrackingParam, normalizeUrl } from '../src/lib/url.ts';

test('strips the fragment', () => {
  assert.equal(normalizeUrl('https://example.com/a/b#section-2'), 'https://example.com/a/b');
  assert.equal(normalizeUrl('https://example.com/a#:~:text=hello'), 'https://example.com/a');
});

test('strips common tracking parameters and keeps the rest, sorted', () => {
  assert.equal(
    normalizeUrl(
      'https://example.com/post?utm_source=x&utm_medium=y&id=42&fbclid=abc&gclid=def&page=2&mc_eid=1&_ga=2.1',
    ),
    'https://example.com/post?id=42&page=2',
  );
  assert.equal(normalizeUrl('https://example.com/?b=2&a=1'), 'https://example.com/?a=1&b=2');
  assert.equal(normalizeUrl('https://example.com/p?UTM_Campaign=z'), 'https://example.com/p', 'case-insensitive names');
});

test('drops a query string that only held tracking parameters', () => {
  assert.equal(normalizeUrl('https://example.com/p?utm_source=news'), 'https://example.com/p');
});

test('lower-cases the host, drops the default port and credentials', () => {
  assert.equal(normalizeUrl('HTTPS://User:pw@Example.COM:443/Path'), 'https://example.com/Path');
  assert.equal(normalizeUrl('http://example.com:80/'), 'http://example.com/');
  assert.equal(normalizeUrl('http://example.com:8080/'), 'http://example.com:8080/');
});

test('the same page reached different ways normalises to one key', () => {
  const a = normalizeUrl('https://example.com/article?id=7&utm_source=twitter#comments');
  const b = normalizeUrl('https://EXAMPLE.com/article?fbclid=xyz&id=7');
  assert.equal(a, b);
});

test('non-http(s) and garbage are rejected', () => {
  assert.equal(normalizeUrl('chrome://settings'), null);
  assert.equal(normalizeUrl('file:///etc/passwd'), null);
  assert.equal(normalizeUrl('chrome-extension://abc/search.html'), null);
  assert.equal(normalizeUrl('not a url'), null);
});

test('meaningful parameters that look similar are kept', () => {
  assert.equal(isTrackingParam('ref'), false);
  assert.equal(isTrackingParam('source'), false);
  assert.equal(isTrackingParam('utm_term'), true);
  assert.equal(normalizeUrl('https://example.com/?ref=main&q=x'), 'https://example.com/?q=x&ref=main');
});

test('hostOf', () => {
  assert.equal(hostOf('https://Sub.Example.com:8443/x'), 'sub.example.com');
  assert.equal(hostOf('nonsense'), '');
});
