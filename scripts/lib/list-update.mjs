// What `npm run update-lists` checks before a download may replace a committed list.
//
// A refresh is unattended (the package script and the scheduled workflow both run it), and
// whatever it writes is stamped into the lock and compiled into the store package. The only
// check it used to make was "at least 100 characters", so a 175-byte "Service Unavailable"
// page was written as easyprivacy.txt, stamped, and shipped a package without EasyPrivacy
// (REVIEW_2026-09-24 B74). Each check here is cheap and would have caught one real way that
// happens: a maintenance or captive-portal page, a truncated transfer, an upstream that briefly
// serves a stub, or a redirect to plain HTTP that anyone on the path can rewrite.

import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** A refresh may not cut a list to less than this share of the bytes in the lock. */
export const SHRINK_LIMIT = 0.5;

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * Throw unless `url` may be fetched: HTTPS only. Plain HTTP is allowed for loopback hosts, which
 * nobody else can answer for (the tests serve lists that way).
 */
export function assertFetchable(url) {
  const u = new URL(url);
  if (u.protocol === 'https:') return u;
  if (u.protocol === 'http:' && LOOPBACK.has(u.hostname)) return u;
  throw new Error(`refusing ${u.protocol}//${u.host}: filter lists are fetched over HTTPS only`);
}

/**
 * The URL a redirect leads to, or a throw when following it would weaken the transport.
 * Filter lists become DNR rules and MAIN-world scriptlets, so an HTTPS list that lets any hop
 * move it to plain HTTP lets anyone on the network write code into the package.
 */
export function redirectTarget(from, location) {
  const next = new URL(location, from);
  if (new URL(from).protocol === 'https:' && next.protocol !== 'https:') {
    throw new Error(`redirect from HTTPS to ${next.protocol}//${next.host} refused`);
  }
  assertFetchable(next.href);
  return next.href;
}

/**
 * Why a downloaded body is not a filter list, or null when it is one.
 *
 * Every list starts with an `[Adblock Plus …]` line or a `!` comment header, and none is HTML.
 * @param {{ text: string, contentType?: string }} response
 */
export function notAFilterList({ text, contentType = '' }) {
  if (/^\s*(?:text\/html|application\/xhtml\+xml)\b/i.test(contentType)) {
    return `served as ${contentType.split(';')[0].trim()}, not a filter list`;
  }
  const body = text.replace(/^\uFEFF/, '');
  if (/^\s*</.test(body) || /<(?:!doctype|html|head|body|title)\b/i.test(body.slice(0, 4096))) {
    return 'looks like an HTML page, not a filter list';
  }
  if (body.length < 100) return `suspiciously small response (${body.length} bytes)`;
  const first = (body.split(/\r?\n/).find((l) => l.trim() !== '') ?? '').trim();
  if (!/^\[(?:adblock|ublock|adguard)\b[^\]]*\]$/i.test(first) && !first.startsWith('!')) {
    return `does not start with a filter-list header (first line: ${JSON.stringify(first.slice(0, 60))})`;
  }
  return null;
}

/**
 * Why `bytes` is too small a replacement for the locked copy, or null.
 * Lists move by a few percent between releases; half of a list vanishing is a broken upstream
 * or a truncated transfer far more often than a real edit. `allowShrink` is the override for
 * the day it is real.
 */
export function shrunkTooFar(bytes, locked, { allowShrink = false } = {}) {
  if (allowShrink || !locked?.bytes) return null;
  if (bytes >= locked.bytes * SHRINK_LIMIT) return null;
  const kb = (n) => `${Math.round(n / 1024)} KB`;
  return (
    `shrank from ${kb(locked.bytes)} to ${kb(bytes)} (more than ${Math.round((1 - SHRINK_LIMIT) * 100)}% smaller). ` +
    'Pass --allow-shrink if upstream really cut it.'
  );
}

/**
 * Write every staged list, or none.
 *
 * Each list goes to a temporary file beside its target and is renamed over it only once all of
 * them are on disk, and a failed rename puts back what was there. A refresh that fails part way
 * therefore leaves filters/ exactly as the lock describes it, never half old and half new.
 * @param {string} filtersDir
 * @param {{ file: string, bytes: Buffer }[]} staged
 */
export function commitLists(filtersDir, staged) {
  const work = staged.map((s) => ({
    target: join(filtersDir, s.file),
    temp: join(filtersDir, `.${s.file}.download`),
    bytes: s.bytes,
  }));
  const committed = [];
  try {
    for (const w of work) writeFileSync(w.temp, w.bytes);
    for (const w of work) {
      const previous = existsSync(w.target) ? readFileSync(w.target) : null;
      renameSync(w.temp, w.target);
      committed.push({ ...w, previous });
    }
  } catch (e) {
    for (const c of committed.reverse()) {
      try {
        if (c.previous) writeFileSync(c.target, c.previous);
        else rmSync(c.target, { force: true });
      } catch {
        // Reported below; the lock check will flag anything left behind.
      }
    }
    throw e;
  } finally {
    for (const w of work) rmSync(w.temp, { force: true });
  }
}

/**
 * Split `update-lists` arguments into list ids and flags, and check the ids exist.
 * @returns {{ ids: string[], allowShrink: boolean, unknown: string[], badFlags: string[] }}
 */
export function parseUpdateArgs(argv, registry) {
  const known = new Set(registry.lists.map((l) => l.id));
  const ids = [];
  const unknown = [];
  const badFlags = [];
  let allowShrink = false;
  for (const a of argv) {
    if (a === '--allow-shrink') allowShrink = true;
    else if (a.startsWith('-')) badFlags.push(a);
    else if (known.has(a)) ids.push(a);
    else unknown.push(a);
  }
  return { ids, allowShrink, unknown, badFlags };
}
