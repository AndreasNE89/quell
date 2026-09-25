// The privacy policy, the permission justifications and the store copy disclose what the
// ExtensionPay library keeps in chrome.storage.sync (REVIEW_2026-09-24 P3 docs 6 and 7).
//
// ExtPay 3.x writes `extensionpay_installed_at` on every start, the API key once checkout or
// restore opens, and the user record with the purchase email after every check with a key — all
// to chrome.storage.sync, which Chrome copies to the user's other signed-in browsers. The docs
// said settings were local-only and told the dashboard "does not collect user data".

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
/** Visible text of an HTML page, whitespace collapsed. */
const htmlText = (rel) =>
  read(rel)
    .replace(/<style[\s\S]*?<\/style>/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ');

const LOCAL_ONLY = /local[- ]only|locally only|allowlist only|settings (?:and|\/) (?:site )?allowlist only/i;

test('the privacy policy and permission notes disclose ExtensionPay\'s synced storage', () => {
  const docs = {
    'docs/privacy-policy.html': htmlText('docs/privacy-policy.html'),
    'docs/privacy-policy.md': read('docs/privacy-policy.md'),
    'store/PERMISSIONS.md': read('store/PERMISSIONS.md'),
  };
  for (const [file, text] of Object.entries(docs)) {
    assert.match(text, /chrome\.storage\.sync/, `${file} does not mention chrome.storage.sync`);
    assert.match(text, /ExtensionPay/, file);
    assert.doesNotMatch(text, LOCAL_ONLY, `${file} still calls storage local-only`);
  }
  // Each policy's storage permission line points at the synced storage too.
  assert.match(docs['docs/privacy-policy.html'], /storage — [^.]*synced storage/);
  assert.match(docs['docs/privacy-policy.md'], /\| `storage` \|[^\n]*synced storage/);
  assert.match(docs['store/PERMISSIONS.md'], /## storage\n\n[^\n]*chrome\.storage\.sync/);
});

test('the html policy and its markdown source say the same thing where it matters', () => {
  // The html is what is hosted and shipped as privacy.html; the md had drifted behind it.
  const html = htmlText('docs/privacy-policy.html');
  const md = read('docs/privacy-policy.md').replace(/\s+/g, ' ');
  const updated = (t) => /Last updated:?\**:? ([A-Z][a-z]+ \d{1,2}, \d{4})/.exec(t)?.[1];
  assert.ok(updated(html));
  assert.equal(updated(md), updated(html), 'the two policies carry different "Last updated" dates');
  for (const phrase of [
    'not synced to your other browsers',
    'normal and Incognito windows',
    'It always records the date the extension was installed',
    'here or in another browser that shares your Chrome sync',
    'It never contains the text of your filters',
  ]) {
    assert.ok(html.includes(phrase), `html lacks "${phrase}"`);
    assert.ok(md.includes(phrase), `md lacks "${phrase}"`);
  }
});

test('the store copy and the dashboard notes disclose it too', () => {
  const listings = {
    'store/LISTING.md': /Chrome's synced storage/,
    'store/LISTING-zh_CN.md': /同步存储/,
    'store/LISTING-zh_TW.md': /同步儲存/,
  };
  for (const [file, pattern] of Object.entries(listings)) assert.match(read(file), pattern, file);
  // The disclosure list the dashboard form is answered from.
  assert.match(read('store/LISTING.md'), /## Privacy \/ payments disclosure[\s\S]*chrome\.storage\.sync/);

  const checklist = read('store/CWS_UPLOAD_CHECKLIST.md');
  assert.match(checklist, /chrome\.storage\.sync/);
  assert.doesNotMatch(checklist, LOCAL_ONLY);

  const cws = read('docs/CHROME_WEB_STORE.md');
  assert.doesNotMatch(cws, /do \*\*not\*\* collect user data/i);
  assert.doesNotMatch(cws, LOCAL_ONLY);
  // The reviewer notes name every service the extension itself contacts.
  const notes = /## Review notes[\s\S]*?```\n([\s\S]*?)```/.exec(cws)?.[1] ?? '';
  for (const host of ['sponsor.ajay.app', 'extensionpay.com', 'chrome.storage.sync']) {
    assert.ok(notes.includes(host), `reviewer notes omit ${host}`);
  }
});
