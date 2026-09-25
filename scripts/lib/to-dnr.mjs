// Convert a parsed network filter (from parse-filter.mjs) into a declarativeNetRequest
// rule object (without an `id` — the compiler assigns ids). Returns:
//   { rule }                     on success
//   { rules: [rule, rule] }      when one filter needs two DNR rules (see splitDocumentContext)
//   { skip: reason }             when the filter can't be represented in DNR
//   { cosmeticException }        generichide/elemhide/specifichide (not a network rule)
//   { badfilter, identity }      a `$badfilter` line (never a rule itself)
// A success result may also carry `partialSkip: reason` when part of the filter was dropped.
//
// The lucky break of MV3: DNR's `urlFilter` grammar mirrors EasyList's own anchors
// (`||` domain anchor, `^` separator, `|` boundary, `*` wildcard), so the pattern
// usually passes through untouched. The work is mapping the *options*.

import { createRequire } from 'node:module';
import { PRIORITY, REDIRECT_PRIORITY_MAX_OFFSET } from './limits.mjs';
import { resolveRedirect } from './redirects.mjs';

const require = createRequire(import.meta.url);
const { RE2 } = require('@adguard/re2-wasm');

const MAX_URL_FILTER_LEN = 2000;

/**
 * Chromium DNR compiles each regexFilter with RE2 `max_mem = 2 << 10` (2048),
 * Latin1 encoding, and case-sensitivity matching `isUrlFilterCaseSensitive`
 * (Chrome 118+ defaults that to false).
 *
 * `@adguard/re2-wasm` is Unicode-only, so we cannot mirror Latin1 exactly. We:
 * 1. Emulate Latin1 case folding for case-insensitive rules (the default): expand every
 *    ASCII letter to both cases (`expandAsciiCase`) and compile with `u`, never `iu`.
 *    Unicode `i` also folds `s`/`k` onto U+017F/U+212A, multi-byte partners Latin1 never
 *    sees, and that inflated [a-z]-heavy rules far past what Chrome builds — 61 rules
 *    Chrome accepts (EasyList's `/\/[0-9a-f]{32}\/invoke\.js/` among them) were dropped.
 *    `$match-case` / `isUrlFilterCaseSensitive: true` compiles the pattern as written.
 * 2. Use a tighter budget than AdGuard's 1990 — Unicode underestimates Latin1
 *    Prog size for dense character classes (e.g. ubo-filters id 4247 needs ~1980
 *    in Unicode/`u` but still trips Chrome's 2KB Latin1 limit). Checked against Chrome's
 *    own `isRegexSupported` over every regex in the lists (2026-09): no false accepts; about
 *    a dozen rules Chrome would take are still refused — `.` and negated classes compile
 *    larger in Unicode than in Latin1, and that direction is the safe one.
 *
 * @see https://source.chromium.org/chromium/chromium/src/+/main:extensions/browser/api/declarative_net_request/utils.cc
 * @see https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest#regex-rules
 */
const CHROME_REGEX_MAX_MEM = 1950;

/** Is the string safe as a DNR urlFilter? DNR requires ASCII; non-ASCII needs punycode. */
function isAscii(s) {
  return /^[\x00-\x7F]*$/.test(s);
}

/** Four octets, each 0-255 with no leading zero: the only IPv4 spelling a URL host keeps. */
const CANONICAL_IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/**
 * Chrome DNR `initiatorDomains`/`requestDomains` (and their excluded* variants) accept
 * only canonical lowercase hostnames or IPv4 literals. Filter lists routinely use forms
 * DNR rejects: entity wildcards (`example.*`), bracketed IPv6 (`[::1]`, `[::]`), ports,
 * or paths. Chrome silently drops such a rule (and older Chromium could reject the whole
 * ruleset), so the filter never fires. The IPv4 and numeric-label rules mirror
 * src/shared/hostname.ts:isValidMatchPatternHost (which also refuses IPv6, by policy).
 */
export function isValidDnrDomain(host) {
  if (!host || typeof host !== 'string') return false;
  if (!isAscii(host)) return false;
  // Entity wildcards / paths / option bleed make Chrome ignore the whole rule.
  if (/[*/=$]/.test(host) || /\s/.test(host)) return false;
  // Bracketed IPv6 is allowed (MDN); bare `:` ports are not.
  if (host.startsWith('[') && host.endsWith(']')) {
    return host.length > 2 && !host.slice(1, -1).includes('[');
  }
  if (host.includes(':')) return false;
  if (CANONICAL_IPV4.test(host)) return true;
  // A numeric (or `0x`) last label makes the URL parser read the host as IPv4: `10.0.0`,
  // `256.1.1.1` and `010.0.0.1` canonicalize to other addresses or fail to parse, so as a
  // request or initiator domain they can never equal a real request's host.
  const last = host.slice(host.lastIndexOf('.') + 1);
  if (/^(\d+|0x[0-9a-f]*)$/i.test(last)) return false;
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i.test(host);
}

/**
 * Normalize / validate a plain (non-regex) pattern for Chrome DNR `urlFilter`.
 *
 * Chrome rejects the entire static ruleset when any rule has an invalid urlFilter
 * ("Could not load manifest"). Documented constraints:
 * - ASCII only
 * - non-empty
 * - must not begin with `||*` (domain anchor + leading wildcard) — use `*` instead
 *
 * @see https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest
 * @returns {{ urlFilter: string } | { skip: string }}
 */
export function normalizeUrlFilter(pattern) {
  if (!pattern) return { skip: 'empty-url-filter' };
  if (!isAscii(pattern)) return { skip: 'non-ascii' };
  if (pattern.length > MAX_URL_FILTER_LEN) return { skip: 'too-long' };

  // `||*foo` is illegal; Chrome docs: use `*foo` instead. Dropping the domain
  // anchor is slightly broader but keeps the rule loadable and still useful.
  let urlFilter = pattern;
  if (urlFilter.startsWith('||*')) {
    urlFilter = urlFilter.slice(2);
  }

  if (!urlFilter) return { skip: 'empty-url-filter' };
  // `*` alone means "match everything" — omit urlFilter upstream instead.
  if (urlFilter === '*') return { skip: 'url-filter-star' };

  // After sanitization, still reject any residual `||*` (shouldn't happen).
  if (urlFilter.startsWith('||*')) return { skip: 'url-filter-domain-wildcard' };

  return { urlFilter };
}

/**
 * Heuristic public-suffix / bare-TLD check (mirrors src/shared/hostname.ts).
 * Used so converter domain scope like `to=com` / `domain=co.uk` cannot count as
 * host narrowing for allow / allowAllRequests (Chrome matches listed domains and
 * all subdomains — `com` would cover essentially the commercial web).
 *
 * Also treats curated multi-tenant platform suffixes (github.io, blogspot.com, …)
 * the same way: `to=github.io` / `||github.io^$document` would AAR every tenant.
 */
const MULTI_TLD_SECONDS = new Set([
  'co',
  'com',
  'net',
  'org',
  'gov',
  'ac',
  'edu',
  'or',
  'ne',
  'go',
  'lg',
]);

/** Keep in sync with src/shared/hostname.ts MULTI_TENANT_SUFFIXES. */
const MULTI_TENANT_SUFFIXES = new Set([
  'github.io',
  'gitlab.io',
  'blogspot.com',
  'appspot.com',
  'herokuapp.com',
  'pages.dev',
  'vercel.app',
  'netlify.app',
  'workers.dev',
  'web.app',
  'firebaseapp.com',
  'azurewebsites.net',
  'azurestaticapps.net',
  'wordpress.com',
  'tumblr.com',
  'webflow.io',
  'ghost.io',
  'notion.site',
  'gitbook.io',
  'readthedocs.io',
  'sourceforge.io',
  'fly.dev',
  'deno.dev',
  'repl.co',
  'glitch.me',
  'codesandbox.io',
]);

export function isPublicSuffixDomain(host) {
  if (!host || typeof host !== 'string') return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return false;
  if (host.startsWith('[') && host.endsWith(']')) return false;
  const lower = host.toLowerCase();
  if (MULTI_TENANT_SUFFIXES.has(lower)) return true;
  const parts = lower.split('.').filter(Boolean);
  if (parts.length <= 1) return true;
  // `co.uk`, `com.au`, `go.jp`, `ne.kr` — these seconds are only registry labels under a
  // ccTLD. Requiring a 2-letter TLD keeps ordinary domains that happen to start with one
  // of them (`go.com`, `ne.com`) out: those are real sites, and treating them as suffixes
  // silently deletes the domain scope of any exception written against them.
  if (parts.length === 2 && MULTI_TLD_SECONDS.has(parts[0]) && /^[a-z]{2}$/.test(parts[1])) {
    return true;
  }
  return false;
}

/**
 * Host from a domain-anchored urlFilter (`||host^`, `||host/path`), or null.
 * Entity wildcards (`||kwik.*`) return null — those are not bare-suffix scope.
 */
export function domainAnchorHostFromUrlFilter(urlFilter) {
  if (!urlFilter || typeof urlFilter !== 'string') return null;
  const m = /^\|\|([a-z0-9.-]+)/i.exec(urlFilter);
  if (!m) return null;
  let host = m[1].toLowerCase();
  if (host.includes('*')) return null;
  host = host.replace(/\.$/, '');
  return host || null;
}

/** True when at least one include-domain is a real host (not a bare public suffix). */
export function hasMeaningfulDomainScope(initiatorDomains, requestDomains) {
  for (const d of initiatorDomains || []) {
    if (!isPublicSuffixDomain(d)) return true;
  }
  for (const d of requestDomains || []) {
    if (!isPublicSuffixDomain(d)) return true;
  }
  return false;
}

/**
 * Drop bare public-suffix entries from an include-domain list.
 * Chrome matches listed domains *and subdomains*, so keeping `com` beside
 * `example.com` would still allow (or allowAllRequests) essentially *.com.
 * Narrowing by stripping suffixes is the safe direction for exceptions.
 */
export function stripPublicSuffixDomains(domains) {
  return (domains || []).filter((d) => !isPublicSuffixDomain(d));
}

/**
 * uBO's pseudo-hostnames for pages of another scheme (`domain=chrome-extension-scheme`).
 * DNR never sees requests other extensions make, and no initiator is ever named
 * `chrome-extension-scheme`, so such a scope can never match. As an include entry it is
 * dropped; a list with nothing else in it means the whole filter is dead (see toDnrRule).
 */
function isSchemePseudoHost(d) {
  return /-scheme$/.test(d);
}

/**
 * True when a DNR `urlFilter` matches essentially every http(s) URL — anchors,
 * separators, wildcards, scheme-only prefixes, or a lone `/` with no host/path meat.
 * Used to keep allow / allowAllRequests from becoming a global unblock.
 */
export function isUniversallyMatchingUrlFilter(urlFilter) {
  if (!urlFilter) return true;
  let core = urlFilter;
  if (core.startsWith('||')) core = core.slice(2);
  else if (core.startsWith('|')) core = core.slice(1);
  if (core.endsWith('|')) core = core.slice(0, -1);
  // Empty / anchor-only / separator-only / slash-only cores do not scope a frame.
  if (!core || /^[\^*$\/.]+$/.test(core)) return true;
  // Scheme-only cores (`http*`, `https://*`, `http:`, bare `http`) match every
  // http(s) navigation — same global unblock as `/` or `.*` for web traffic.
  // Colon after https? must be optional (`http*` has no `:`); use `(?::…)?`
  // so `https?:` is not parsed as `http` + optional `s` + required `:`.
  if (/^https?(?::[/]*)?\**$/.test(core)) return true;
  // Wildcard-wrapped scheme / authority that still match every http(s) URL:
  // `*http*`, `*://*`, `http*://*`, `*http*://*` (and `|https*://*` after | strip).
  // `normalizeUrlFilter` also turns `||*.com^` into `*.com^` — handled below.
  if (/^\**https?\**(?::[/]*\**)?$/.test(core)) return true;
  if (/^\**:[/]*\**$/.test(core)) return true;
  // Leading-wildcard public-suffix hosts (`*.com^`, `*.co.uk/`, `*.github.io^`) are
  // TLD/tenant-wide — same over-unblock class as `||com^` / `to=github.io`.
  const suffixHost = /^\*+\.?([a-z0-9.-]+?)(?:[\^\/].*)?$/i.exec(core);
  if (suffixHost && isPublicSuffixDomain(suffixHost[1])) return true;
  return false;
}

/**
 * True when a DNR `regexFilter` matches every URL (or every http(s) URL).
 * Residual of the unscoped-$document guard: a match-all regex (dot-star)
 * plus $document still has a regexFilter, so presence-alone is not enough scope.
 */
export function isUniversallyMatchingRegexFilter(regexFilter) {
  if (!regexFilter) return true;
  const p = regexFilter;
  // Optional ^ / $ around match-all wildcards or empty (incl. .{0,} / .*?).
  if (/^\^?\.(?:\*|\+|\{\d*,\d*\})\??\$?$/.test(p)) return true;
  if (/^\^?\.\$?$/.test(p)) return true;
  if (p === '^' || p === '$' || p === '^$') return true;
  // Any-char classes used as `.*` equivalents: [\s\S]* / [\s\S]+ / [\d\D]{1,} / …
  // Quantifier must include + / {1,} — otherwise @@/[\s\S]+/$document slips past
  // the too-broad skip and emits a global allowAllRequests.
  if (
    /^\^?\[(?:\\s\\S|\\S\\s|\\d\\D|\\D\\d|\\w\\W|\\W\\w)\](?:\+|\*|\{0,\}|\{1,\})\??\$?$/.test(
      p,
    )
  ) {
    return true;
  }
  // Scheme-only https?:\/\/ with optional .* / .+ / .*? matches all web navigations.
  // Filter source literally contains `?` after `s` (`https?:\/\/`), so escape it.
  if (/^\^?https\?:\\\/\\\/(?:\.\*|\.\+|\.\*\?)?\$?$/.test(p)) return true;
  // Any-host origin (`^https?:\/\/[^\/]+` ± trailing .*) — every http(s) site.
  // Include {1,} (same class as +); previously only + / * / {0,} were caught.
  if (/^\^?https\?:\\\/\\\/\[\^\\\/\](?:\+|\*|\{0,\}|\{1,\})(?:\.\*)?\$?$/.test(p)) {
    return true;
  }
  // Bare / wildcarded scheme prefix in filter source: ^http, ^https.*, ^http$
  if (/^\^?https?\.\*[\$]?$/.test(p) || /^\^?https?\$?$/.test(p)) return true;
  // Alternation with a match-all branch (`.*|a`, `a|.*`) still matches everything.
  const body = p.replace(/^\^/, '').replace(/\$$/, '');
  if (body.includes('|')) {
    const alts = body.split('|');
    if (alts.some((a) => /^(?:\.\*|\.\+|\.\*\?|\.\{\d*,\d*\}\??)$/.test(a))) return true;
  }
  return false;
}

/**
 * Strip regex syntax from a `regexFilter`, leaving only the literal characters.
 * Character classes, quantifiers, groups, anchors and class escapes (`\w`, `\d`, …)
 * become spaces; escaped literals (`\.`, `\/`) keep their character.
 */
export function regexFilterLiteralCore(pattern) {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '\\') {
      const n = pattern[i + 1];
      i++;
      if (!n) break;
      // Class shorthands, anchors, backrefs and numeric escapes match text we cannot see.
      out += /[dDwWsSbBnrtvfkpPux0-9]/.test(n) ? ' ' : n;
      continue;
    }
    if (c === '[') {
      i++;
      for (; i < pattern.length; i++) {
        if (pattern[i] === '\\') {
          i++;
          continue;
        }
        if (pattern[i] === ']') break;
      }
      out += ' ';
      continue;
    }
    if (c === '{') {
      while (i < pattern.length && pattern[i] !== '}') i++;
      out += ' ';
      continue;
    }
    out += '()|^$*+?.'.includes(c) ? ' ' : c;
    }
  return out;
}

/**
 * Structural postcondition for exception (`@@`) rules that carry a `regexFilter`.
 *
 * `isUniversallyMatchingRegexFilter` enumerates known match-all *shapes*, and has had to be
 * extended seven times (PRs #17→#28) as new encodings of "match everything" showed up in
 * upstream lists. This is the shape-independent invariant behind all of them: a regex that
 * contains no literal text beyond scheme boilerplate cannot possibly be scoped to anything,
 * so it must never become an `allow` / `allowAllRequests`. `^(.*)$`, `(?:.*)`, `^[^ ]+` and
 * `^https?:\/\/\w` all fail this check without needing to be listed anywhere.
 */
export function regexFilterHasLiteralScope(pattern) {
  if (!pattern) return false;
  const tokens = regexFilterLiteralCore(pattern)
    .split(/[^a-z0-9.-]+/i)
    .map((t) => t.replace(/^[.-]+|[.-]+$/g, '').toLowerCase())
    .filter((t) => t && t !== 'http' && t !== 'https' && t !== 'www');
  for (const t of tokens) {
    // A bare public suffix (`*.com`) is TLD-wide, not scope.
    if (t.includes('.') && isPublicSuffixDomain(t)) continue;
    if (t.length >= 3) return true;
  }
  return false;
}

/**
 * Chrome DNR `regexFilter` is compiled with RE2 (plus a ~2KB compiled-size budget).
 * Emitting a pattern RE2 rejects makes the entire static ruleset fail to load
 * ("Could not load manifest"). Patterns that only exceed the memory budget are
 * skipped per-rule at load time (noisy console warnings) — better not to emit them.
 * Filter lists routinely use JS-only features (lookarounds, backrefs) that must
 * be dropped at compile time.
 *
 * Memory check uses AdGuard's RE2 WASM. Case handling must match Chrome for the emitted
 * rule: default DNR matching is case-insensitive, which Chrome's Latin1 RE2 builds by
 * folding ASCII letters only — emulated with `expandAsciiCase` + `u`. `$match-case` uses
 * `u` on the pattern as written. Validating the case-insensitive rule as written
 * underestimates Prog size and ships rules Chrome then skips (e.g. ubo-badware hex.sbs).
 *
 * @param {string} pattern
 * @param {{ caseSensitive?: boolean }} [options]
 * @see https://github.com/google/re2/wiki/Syntax
 * @returns {string|null} skip reason, or null if the pattern looks RE2-safe
 */
export function re2UnsupportedReason(pattern, options = {}) {
  const caseSensitive = options.caseSensitive === true;

  // Lookahead / lookbehind — the usual EasyList/uBO offenders.
  if (/\(\?(?:[=!]|<=|<!)/.test(pattern)) return 'regex-lookaround';

  // Named / numbered backreferences and recursion (RE2: not supported).
  if (/\(\?P=|\(\?&|\\k</.test(pattern)) return 'regex-backref';
  if (/(?:^|[^\\])(?:\\\\)*\\[1-9]/.test(pattern)) return 'regex-backref';

  // Atomic groups, possessive quantifiers, conditionals, verbs, comments, branch reset.
  if (/\(\?>/.test(pattern)) return 'regex-atomic';
  if (/(?:[*+?]|\{\d+(?:,\d*)?\})\+/.test(pattern)) return 'regex-possessive';
  if (/\(\?\(/.test(pattern)) return 'regex-conditional';
  if (/\(\?(?:[+\-]?\d|R|0)\)/.test(pattern)) return 'regex-recursion';
  if (/\(\*[\w]+/.test(pattern)) return 'regex-verb';
  if (/\(\?#/.test(pattern)) return 'regex-comment';
  if (/\(\?\|/.test(pattern)) return 'regex-branch-reset';

  // RE2 rejects counting forms with min/max above 1000.
  for (const m of pattern.matchAll(/\{(\d+)(?:,(\d*))?\}/g)) {
    const min = Number(m[1]);
    if (min > 1000) return 'regex-repeat-limit';
    if (m[2] !== undefined && m[2] !== '' && Number(m[2]) > 1000) return 'regex-repeat-limit';
  }

  // Catch obvious syntax errors early (unclosed classes, bad escapes, …).
  // Note: JS RegExp accepts lookarounds — those are filtered above.
  try {
    new RegExp(pattern);
  } catch {
    return 'regex-syntax';
  }

  // Enforce Chrome's ~2KB compiled-size budget so oversized rules are never shipped.
  // re2-wasm requires Unicode (`u`); Chromium uses Latin1 — prefer dropping a
  // borderline rule over load-time "exceeded the 2KB memory limit" warnings.
  const compile = (source, flags) => {
    try {
      // RE2 constructor throws when the pattern cannot be compiled within maxMem.
      new RE2(source, flags, CHROME_REGEX_MAX_MEM);
      return null;
    } catch (err) {
      const msg = String(err?.message ?? err);
      if (/too large|memory|compile failed/i.test(msg)) return 'regex-memory';
      return 'regex-syntax';
    }
  };
  if (caseSensitive) return compile(pattern, 'u');
  const folded = compile(expandAsciiCase(pattern), 'u');
  // An expansion RE2 cannot parse is our bug, not the rule's: fall back to Unicode folding,
  // which overestimates the size and so can only reject, never wrongly accept.
  return folded === 'regex-syntax' ? compile(pattern, 'iu') : folded;
}

/**
 * Rewrite a regex so that a case-sensitive compile has the program a Latin1 case-insensitive
 * compile would: each ASCII letter becomes both cases (`a` → `[aA]`, `[a-f]` → `[a-fA-F]`).
 * Escapes (`\d`, `\x41`, `\p{L}`), group headers (`(?:`, `(?P<name>`) and counted
 * repetitions pass through unchanged. Only used to size the program; the rule ships as written.
 * @param {string} pattern
 * @returns {string}
 */
export function expandAsciiCase(pattern) {
  const n = pattern.length;
  const partner = (c) => (c >= 'a' && c <= 'z' ? c.toUpperCase() : c.toLowerCase());
  const isAsciiLetter = (c) => /^[A-Za-z]$/.test(c);

  /** Length of the escape sequence starting at `pattern[i] === '\\'`. */
  const escapeLength = (i) => {
    const c = pattern[i + 1];
    if (c === undefined) return 1;
    if ((c === 'x' || c === 'p' || c === 'P') && pattern[i + 2] === '{') {
      const end = pattern.indexOf('}', i + 2);
      return end === -1 ? n - i : end + 1 - i;
    }
    if (c === 'x') return 4;
    if (c === 'p' || c === 'P') return 3;
    if (c === 'Q') {
      const end = pattern.indexOf('\\E', i + 2);
      return end === -1 ? n - i : end + 2 - i;
    }
    return 2;
  };

  /** Code point of a single-character class atom (`a`, `\.`, `\x41`), or null for `\d` etc. */
  const atomCodePoint = (text) => {
    if (text.length === 1) return text.charCodeAt(0);
    if (/^\\x[0-9a-f]{2}$/i.test(text)) return parseInt(text.slice(2), 16);
    if (/^\\x\{[0-9a-f]+\}$/i.test(text)) return parseInt(text.slice(3, -1), 16);
    if (/^\\[^A-Za-z0-9]$/.test(text)) return text.charCodeAt(1);
    return null;
  };

  /** Case partners of the ASCII letters in [lo, hi], as class text. */
  const partnerRanges = (lo, hi) => {
    let extra = '';
    for (const [from, to, shift] of [
      [65, 90, 32],
      [97, 122, -32],
    ]) {
      const a = Math.max(lo, from);
      const b = Math.min(hi, to);
      if (a > b) continue;
      const x = String.fromCharCode(a + shift);
      const y = String.fromCharCode(b + shift);
      extra += a === b ? x : `${x}-${y}`;
    }
    return extra;
  };

  /** Copy a character class starting at `pattern[i] === '['`; returns [text, nextIndex]. */
  const copyClass = (i) => {
    let out = '[';
    let j = i + 1;
    if (pattern[j] === '^') out += pattern[j++];
    // RE2: a `]` first in the class is a literal.
    let first = true;
    while (j < n && (pattern[j] !== ']' || first)) {
      first = false;
      // POSIX class `[:lower:]`.
      if (pattern[j] === '[' && pattern[j + 1] === ':') {
        const end = pattern.indexOf(':]', j + 2);
        if (end !== -1) {
          const name = pattern.slice(j + 2, end);
          out += pattern.slice(j, end + 2);
          if (name === 'lower') out += 'A-Z';
          else if (name === 'upper') out += 'a-z';
          j = end + 2;
          continue;
        }
      }
      const len = pattern[j] === '\\' ? escapeLength(j) : 1;
      const atom = pattern.slice(j, j + len);
      j += len;
      const lo = atomCodePoint(atom);
      // Range `lo-hi` (a `-` right before `]` is a literal).
      if (lo !== null && pattern[j] === '-' && j + 1 < n && pattern[j + 1] !== ']') {
        const hiLen = pattern[j + 1] === '\\' ? escapeLength(j + 1) : 1;
        const hiAtom = pattern.slice(j + 1, j + 1 + hiLen);
        const hi = atomCodePoint(hiAtom);
        if (hi !== null) {
          out += `${atom}-${hiAtom}${partnerRanges(lo, hi)}`;
          j += 1 + hiLen;
          continue;
        }
      }
      out += atom;
      if (atom.length === 1 && isAsciiLetter(atom)) out += partner(atom);
    }
    if (j < n) out += ']';
    return [out, j + 1];
  };

  let out = '';
  let i = 0;
  while (i < n) {
    const c = pattern[i];
    if (c === '\\') {
      const len = escapeLength(i);
      out += pattern.slice(i, i + len);
      i += len;
      continue;
    }
    if (c === '[') {
      const [text, next] = copyClass(i);
      out += text;
      i = next;
      continue;
    }
    if (c === '(' && pattern[i + 1] === '?') {
      // Group header: `(?:`, `(?i)`, `(?i:`, `(?P<name>`, `(?<name>`.
      const named = /^\(\?P?<[A-Za-z_][A-Za-z0-9_]*>/.exec(pattern.slice(i));
      const flags = /^\(\?[A-Za-z-]*[:)]/.exec(pattern.slice(i));
      const header = named?.[0] ?? flags?.[0] ?? '(?';
      out += header;
      i += header.length;
      continue;
    }
    if (c === '{') {
      const rep = /^\{\d+(?:,\d*)?\}/.exec(pattern.slice(i));
      if (rep) {
        out += rep[0];
        i += rep[0].length;
        continue;
      }
    }
    out += isAsciiLetter(c) ? `[${c}${partner(c)}]` : c;
    i++;
  }
  return out;
}

/**
 * Options we cannot (yet) express correctly as DNR. Emitting a plain block/allow for
 * these would be wrong (e.g. $csp must not become block). Cosmetic exceptions are
 * handled separately and must not fall through to network conversion.
 */
const HARD_UNSUPPORTED = new Set([
  'csp',
  'removeparam',
  'removeparam-rule',
  'header',
  'permissions',
  'cookie',
  'replace',
  'jsonprune',
  'hls',
  'empty',
  'mp4',
  'inline-script',
  'inline-font',
  'ping',
  'popup',
  'popunder',
  'webrtc',
  'strict3p',
  'strict1p',
]);

function unsupportedReason(tokens) {
  const names = tokens.map((t) => t.replace(/^~/, '').split('=')[0].toLowerCase());
  const hard = names.filter((n) => HARD_UNSUPPORTED.has(n) || n.startsWith('removeparam'));
  if (hard.length) return `unsupported:${hard[0]}`;
  return `unsupported:${names[0] || 'option'}`;
}

/** Option token as written, normalized for identity: name lowercased, value kept. */
function normalizeOptionToken(token) {
  const t = String(token).trim();
  const eq = t.indexOf('=');
  return eq === -1 ? t.toLowerCase() : `${t.slice(0, eq).toLowerCase()}=${t.slice(eq + 1)}`;
}

/**
 * Identity for `$badfilter` matching: pattern + options minus the badfilter token.
 * Two filters cancel when their identities are equal.
 *
 * Every option that changes what a filter does is part of the identity — the cosmetic kind
 * (`$ehide`), `$redirect-rule`, and the options the parser leaves unconverted (`$csp=…`,
 * `$popup`, `$method=…`). Without them `||x^$csp=…,badfilter` would cancel a plain `||x^`.
 */
export function networkFilterIdentity(f) {
  const o = f.options || {};
  return JSON.stringify({
    isException: !!f.isException,
    pattern: f.pattern,
    isRegex: !!f.isRegex,
    resourceTypes: [...(o.resourceTypes || [])].sort(),
    excludedResourceTypes: [...(o.excludedResourceTypes || [])].sort(),
    initiatorDomains: [...(o.initiatorDomains || [])].sort(),
    excludedInitiatorDomains: [...(o.excludedInitiatorDomains || [])].sort(),
    requestDomains: [...(o.requestDomains || [])].sort(),
    excludedRequestDomains: [...(o.excludedRequestDomains || [])].sort(),
    removeParams: [...(o.removeParams || [])].sort(),
    thirdParty: o.thirdParty ?? null,
    matchCase: !!o.matchCase,
    important: !!o.important,
    redirect: f.redirect ?? null,
    redirectRule: !!f.redirectRule,
    cosmeticException: f.cosmeticException || null,
    other: [...(f.unsupported || [])].map(normalizeOptionToken).sort(),
  });
}

/** DNR `requestMethods` values that uBO's `$method` can name (DNR wants lowercase). */
const DNR_METHODS = new Set(['connect', 'delete', 'get', 'head', 'options', 'patch', 'post', 'put']);

/** DNR's resource types; mirrors parse-filter.mjs, which applies this to `$all`/`$removeparam`. */
const ALL_RESOURCE_TYPES = [
  'main_frame', 'sub_frame', 'stylesheet', 'script', 'image',
  'font', 'object', 'xmlhttprequest', 'ping', 'media', 'websocket', 'other',
];

/**
 * Options the parser leaves in `unsupported` that DNR can express after all:
 * - `$method=get|~post`            → requestMethods / excludedRequestMethods
 * - `$rewrite=abp-resource:<name>` → ABP's spelling of `$redirect=<name>`
 * - bare `$removeparam`            → strip the whole query (`transform.query: ''`)
 * @returns {{ rest: string[], methods: {include: string[], exclude: string[]} | null,
 *   rewrite: string | null, clearQuery: boolean } | { skip: string }}
 */
function extractConvertibleOptions(tokens) {
  const rest = [];
  let methods = null;
  let rewrite = null;
  let clearQuery = false;
  for (const raw of tokens || []) {
    const token = String(raw).trim();
    const neg = token.startsWith('~');
    const key = neg ? token.slice(1) : token;
    const eq = key.indexOf('=');
    const name = (eq === -1 ? key : key.slice(0, eq)).toLowerCase();
    const value = eq === -1 ? '' : key.slice(eq + 1).trim();
    if (name === 'method' && !neg && value) {
      methods ||= { include: [], exclude: [] };
      for (const part of value.split('|')) {
        const m = part.trim().toLowerCase();
        const off = m.startsWith('~');
        const verb = off ? m.slice(1) : m;
        if (!DNR_METHODS.has(verb)) return { skip: 'unsupported:method' };
        (off ? methods.exclude : methods.include).push(verb);
      }
      continue;
    }
    if (name === 'rewrite' && !neg && value.startsWith('abp-resource:')) {
      rewrite = value;
      continue;
    }
    if ((name === 'removeparam' || name === 'queryprune') && !neg && eq === -1) {
      clearQuery = true;
      continue;
    }
    rest.push(raw);
  }
  return { rest, methods, rewrite, clearQuery };
}

/**
 * Include lists from `domain=` and `to=` both constrain the request host of a top-level
 * document, so it must fall under an entry of each. Chrome matches a listed domain and its
 * subdomains; the intersection is the deeper entry of every overlapping pair.
 * @returns {string[] | null} null when no host can satisfy both
 */
function intersectDomainIncludes(a, b) {
  if (!a.length) return b;
  if (!b.length) return a;
  const under = (host, parent) => host === parent || host.endsWith(`.${parent}`);
  const out = new Set();
  for (const x of a) {
    for (const y of b) {
      if (under(x, y)) out.add(x);
      else if (under(y, x)) out.add(y);
    }
  }
  return out.size ? [...out] : null;
}

/**
 * uBO filters a top-level document request in the context of the document being opened: its
 * filtering context takes the document origin from the request URL. So for `main_frame`,
 * `domain=` names the page being navigated to, `$1p` always holds and `$3p` never does. DNR's
 * `initiatorDomains` / `domainType` instead look at the page the navigation came from — none
 * at all for a typed URL or a bookmark — so the plain mapping blocks outbound links from a
 * listed site and misses the site itself.
 *
 * A filter whose context options would differ therefore splits into a `main_frame` part
 * (context mapped onto the request host) and a part for its other types (unchanged; a
 * subresource's context is the page that loads it, which is what DNR's initiator is).
 * @returns {{ parts: object[], skip: string | null } | null} null when no split is needed
 */
function splitDocumentContext(f) {
  const o = f.options;
  if (!o.resourceTypes.includes('main_frame')) return null;
  const hasContext =
    o.initiatorDomains.length > 0 || o.excludedInitiatorDomains.length > 0 || o.thirdParty !== null;
  if (!hasContext) return null;

  const parts = [];
  let skip = null;
  if (o.thirdParty === true) {
    // A document is always first-party to itself: this part can never match.
    skip = 'document-third-party';
  } else {
    const include = intersectDomainIncludes(o.initiatorDomains, o.requestDomains);
    if (include === null) {
      skip = 'document-domain-disjoint';
    } else {
      parts.push({
        ...f,
        options: {
          ...o,
          resourceTypes: ['main_frame'],
          thirdParty: null,
          initiatorDomains: [],
          excludedInitiatorDomains: [],
          requestDomains: include,
          excludedRequestDomains: dedup([...o.excludedInitiatorDomains, ...o.excludedRequestDomains]),
        },
      });
    }
  }
  const rest = o.resourceTypes.filter((t) => t !== 'main_frame');
  if (rest.length) parts.push({ ...f, options: { ...o, resourceTypes: rest } });
  return { parts, skip };
}

export function toDnrRule(f) {
  // $badfilter cancels another filter; never emit it as a DNR rule — and check it first:
  // `@@||x^$ehide,badfilter` exists to REMOVE an element-hiding exception, so reading it
  // as a cosmetic exception would switch off every cosmetic filter on that site.
  if (f.options?.badfilter) {
    return { badfilter: true, identity: networkFilterIdentity(f) };
  }

  // Cosmetic-only exceptions are never network actions — even when they carry a URL
  // pattern (`@@||example.com^$generichide`). Emitting `allow` would unblock traffic.
  if (f.cosmeticException) {
    return { cosmeticException: f.cosmeticException, pattern: f.pattern, isException: f.isException };
  }

  // $redirect-rule means "redirect only if the request would otherwise be blocked".
  // DNR cannot express that; treating it as $redirect over-neuters allowed resources.
  if (f.redirectRule) {
    return { skip: 'redirect-rule' };
  }

  // `@@…$redirect[=X]` only cancels the redirect in uBO; the block still applies. A plain
  // allow would unblock the request, so drop the exception instead.
  if (f.isException && f.redirect != null) {
    return { skip: 'exception-redirect' };
  }

  const extracted = extractConvertibleOptions(f.unsupported);
  if (extracted.skip) return { skip: extracted.skip };
  // Remaining unsupported options must not silently become block/allow.
  if (extracted.rest.length) {
    return { skip: unsupportedReason(extracted.rest) };
  }
  if (extracted.rewrite && f.isException) return { skip: 'exception-redirect' };
  if (extracted.rewrite && f.redirect != null) return { skip: 'redirect-conflict' };

  // Negated types subtract from listed ones (`$all,~doc`): DNR takes one list or the other.
  let listed = dedup(f.options.resourceTypes || []);
  const negated = dedup(f.options.excludedResourceTypes || []);
  // A typeless bare `$removeparam` must reach the address bar too, like the named form
  // (parse-filter.mjs adds every type for that one).
  if (extracted.clearQuery && !listed.length) listed = [...ALL_RESOURCE_TYPES];
  const resourceTypes = listed.filter((t) => !negated.includes(t));
  if (listed.length && !resourceTypes.length) return { skip: 'no-resource-types' };
  // uBO fills a negated-only list (`$~script`, `$~image,3p`) from its network types, and the
  // top-level document is not one of them. DNR leaves main_frame out by default only when
  // neither type list is given: `-banner-ads-$~script` blocked any page with that slug in its
  // address, and `$~image,3p,domain=…` every link leaving those sites.
  const excludedResourceTypes =
    resourceTypes.length || !negated.length ? [] : dedup([...negated, 'main_frame']);

  const g = {
    ...f,
    redirect: extracted.rewrite ?? f.redirect,
    methods: extracted.methods,
    clearQuery: extracted.clearQuery,
    options: {
      ...f.options,
      resourceTypes,
      excludedResourceTypes,
      initiatorDomains: f.options.initiatorDomains || [],
      excludedInitiatorDomains: f.options.excludedInitiatorDomains || [],
      requestDomains: f.options.requestDomains || [],
      excludedRequestDomains: f.options.excludedRequestDomains || [],
    },
  };

  const split = splitDocumentContext(g);
  if (!split) return convertFilter(g);

  const results = split.parts.map(convertFilter);
  const rules = results.filter((r) => r.rule).map((r) => r.rule);
  // split.skip names a part that can never match, so nothing is lost when others convert.
  const lost = results.map((r) => r.skip).filter(Boolean);
  if (!rules.length) return { skip: lost[0] || split.skip || 'document-context' };
  const out = rules.length === 1 ? { rule: rules[0] } : { rules };
  if (lost.length) out.partialSkip = lost[0];
  return out;
}

/** Convert a filter whose options are already normalized by toDnrRule into one DNR rule. */
function convertFilter(f) {
  const condition = {};

  if (f.isRegex) {
    const regex = f.pattern.slice(1, -1);
    if (!regex) return { skip: 'empty-regex' };
    if (!isAscii(regex)) return { skip: 'non-ascii-regex' };
    // Match Chrome's compile flags: default case-insensitive, `$match-case` → sensitive.
    const re2Skip = re2UnsupportedReason(regex, { caseSensitive: !!f.options.matchCase });
    if (re2Skip) return { skip: re2Skip };
    condition.regexFilter = regex;
  } else if (f.pattern && f.pattern !== '*') {
    const normalized = normalizeUrlFilter(f.pattern);
    if (normalized.skip) {
      // Bare `*` after sanitizing `||*` → treat like an empty pattern (match-all).
      if (normalized.skip !== 'url-filter-star') return { skip: normalized.skip };
    } else {
      condition.urlFilter = normalized.urlFilter;
    }
  }
  // An empty/`*` pattern is a valid "match every URL" condition (omit urlFilter).

  // Resource types (toDnrRule already subtracted negated types from listed ones).
  const rt = dedup(f.options.resourceTypes);
  const ert = dedup(f.options.excludedResourceTypes);
  if (rt.length) condition.resourceTypes = rt;
  else if (ert.length) condition.excludedResourceTypes = ert;

  // Party (first/third).
  if (f.options.thirdParty === true) condition.domainType = 'thirdParty';
  else if (f.options.thirdParty === false) condition.domainType = 'firstParty';

  // `domain=chrome-extension-scheme` can never match in DNR (see isSchemePseudoHost). Dropping
  // it from a list with real hosts changes nothing; a list of nothing else is a dead filter.
  const liveIncludes = (list) => {
    const all = dedup(list);
    const live = all.filter((d) => !isSchemePseudoHost(d));
    return all.length && !live.length ? null : live;
  };
  const initIncludes = liveIncludes(f.options.initiatorDomains);
  const reqIncludes = liveIncludes(f.options.requestDomains);
  if (!initIncludes || !reqIncludes) return { skip: 'scheme-domain' };

  // Initiator (document) domain constraints ($domain / $from).
  const initSan = sanitizeDnrDomainLists(initIncludes, dedup(f.options.excludedInitiatorDomains));
  if (initSan.skip) return { skip: initSan.skip };
  const initDomains = initSan.include;
  const exInitDomains = initSan.exclude;
  if (initDomains.length) condition.initiatorDomains = initDomains;
  if (exInitDomains.length) condition.excludedInitiatorDomains = exInitDomains;

  // Destination host constraints ($to / $denyallow).
  const reqSan = sanitizeDnrDomainLists(reqIncludes, dedup(f.options.excludedRequestDomains));
  if (reqSan.skip) return { skip: reqSan.skip };
  const reqDomains = reqSan.include;
  const exReqDomains = reqSan.exclude;
  if (reqDomains.length) condition.requestDomains = reqDomains;
  if (exReqDomains.length) condition.excludedRequestDomains = exReqDomains;

  // $method. uBO `method=get|~post`: the request's method must be listed and not negated.
  if (f.methods) {
    const include = dedup(f.methods.include).filter((m) => !f.methods.exclude.includes(m));
    if (f.methods.include.length) {
      if (!include.length) return { skip: 'no-request-methods' };
      condition.requestMethods = include;
    } else if (f.methods.exclude.length) {
      condition.excludedRequestMethods = dedup(f.methods.exclude);
    }
  }

  if (f.options.matchCase) condition.isUrlFilterCaseSensitive = true;

  const removeParams = dedup(f.options.removeParams || []);
  const isRemoveparam = removeParams.length > 0 || !!f.clearQuery;

  // $removeparam=<name> → strip query params via DNR redirect + queryTransform; a bare
  // $removeparam clears the whole query (`transform.query: ''`). A global param strip
  // (no url/domain) is legitimate — unlike a global block — so emit it before the
  // too-broad guard. Neither form redirects when there is nothing to strip (no loop).
  if (isRemoveparam && !f.isException) {
    const transform = f.clearQuery ? { query: '' } : { queryTransform: { removeParams } };
    return {
      rule: {
        priority: f.options.important ? PRIORITY.IMPORTANT_REDIRECT : PRIORITY.REMOVEPARAM,
        action: { type: 'redirect', redirect: { transform } },
        condition,
      },
    };
  }

  // Guard: a rule with no meaningful condition at all is dangerously broad; drop it.
  if (
    !condition.urlFilter &&
    !condition.regexFilter &&
    !initDomains.length &&
    !reqDomains.length &&
    !rt.length
  ) {
    return { skip: 'too-broad' };
  }

  // --- Action + priority ---------------------------------------------------
  const important = f.options.important;

  if (f.isException) {
    // Only $document (main_frame) exceptions map to allowAllRequests — that action
    // matches the FRAME's URL and exempts the whole frame tree. ABP/uBO $subdocument
    // / $frame alone only unblock the iframe *request* (plain `allow` on sub_frame);
    // treating them as allowAllRequests over-unblocks nested pixels/XHR and wrongly
    // expands match to main_frame when both types are forced.
    // A bare `@@||domain^` (no resource type) must also stay plain `allow`.
    //
    // Mixed include lists (`to=example.com|com`) still pass hasMeaningfulDomainScope
    // because example.com is real — but Chrome OR-matches every entry, so leaving
    // `com` in the emitted rule TLD-unblocks *.com. Strip suffixes before the guard
    // and rewrite the condition (under-match is safe).
    const scopedInit = stripPublicSuffixDomains(initDomains);
    const scopedReq = stripPublicSuffixDomains(reqDomains);
    // A list made only of suffixes is never stripped: deleting it widens the exception to
    // every site. `@@||stats.wp.com/w.js$script,domain=wordpress.com` became a global allow
    // for the Jetpack tracker that way. Such a list stays verbatim — exactly what the filter
    // says — when something else scopes the rule, and the emit guards below skip the rule
    // when nothing does (`@@$script,domain=com` must not become a global script allow).
    const suffixOnlyScope =
      (initDomains.length > 0 && scopedInit.length === 0) ||
      (reqDomains.length > 0 && scopedReq.length === 0);
    if (scopedInit.length) condition.initiatorDomains = scopedInit;
    if (scopedReq.length) condition.requestDomains = scopedReq;
    const hasDomainScope = hasMeaningfulDomainScope(scopedInit, scopedReq);
    // `||com^` / `||github.io^` look like hostname scope but Chrome matches every
    // subdomain of that public / multi-tenant suffix — same over-unblock as to=com.
    const urlAnchorHost = condition.urlFilter
      ? domainAnchorHostFromUrlFilter(condition.urlFilter)
      : null;
    const urlAnchorIsSuffix = !!(urlAnchorHost && isPublicSuffixDomain(urlAnchorHost));
    const hasScopedUrl =
      (condition.urlFilter &&
        !isUniversallyMatchingUrlFilter(condition.urlFilter) &&
        !urlAnchorIsSuffix) ||
      (condition.regexFilter &&
        !isUniversallyMatchingRegexFilter(condition.regexFilter) &&
        // Shape enumeration above catches known match-all encodings; this catches the rest
        // by requiring the regex to contain some literal text it is actually scoped to.
        regexFilterHasLiteralScope(condition.regexFilter));
    const hasAnyUrlConstraint = !!(condition.urlFilter || condition.regexFilter);

    if (isRemoveparam) {
      // `@@…$removeparam[=name]` cancels query stripping only. It sits in its own band just
      // above the strips and below BLOCK, so it can never unblock anything. DNR cannot cancel
      // one parameter's strip alone: a named exception stops every strip on that request.
      if (!hasDomainScope && !hasScopedUrl) return { skip: 'too-broad-allow' };
      return {
        rule: {
          priority: PRIORITY.REMOVEPARAM_ALLOW,
          action: { type: 'allow' },
          condition,
        },
      };
    }

    if (rt.includes('main_frame')) {
      // Resource types alone are not enough scope here: `@@$document` / `@@*$document`
      // would otherwise emit allowAllRequests with only main_frame and disable network
      // blocking for every top-level navigation (Chrome exempts that frame tree).
      // Require a *non-universal* URL or a *meaningful* include-domain constraint —
      // match-all urlFilter/regexFilter (`/`, `|`, `.*`, `http*`, `^http`, …) and
      // bare public-suffix domains (`to=com`) are the same global / TLD-wide unblock.
      // Exclude-only / type-only document exceptions stay skipped.
      // (Plain allow/block may still use type-only scope — e.g. EasyPrivacy `$ping`.)
      if (!hasDomainScope && !hasScopedUrl) {
        return { skip: 'too-broad-allow-all' };
      }
      // allowAllRequests only permits main_frame / sub_frame in resourceTypes.
      delete condition.excludedResourceTypes;
      condition.resourceTypes = rt.filter((t) => t === 'main_frame' || t === 'sub_frame');
      return {
        rule: {
          priority: important ? PRIORITY.IMPORTANT_ALLOW : PRIORITY.ALLOW,
          action: { type: 'allowAllRequests' },
          condition,
        },
      };
    }
    // Plain allow at ALLOW priority overrides BLOCK. A present but universal
    // urlFilter/regexFilter with no real host scope (`@@|http*`, `@@/.*/`, …)
    // disables network blocking globally — skip those. Type-only allows (no URL
    // constraint) still emit.
    // `suffixOnlyScope` closes the type-only hole: with no URL constraint at all this guard
    // used to fall through, so `@@$script,domain=com` emitted a global allow for every script.
    if ((hasAnyUrlConstraint || suffixOnlyScope) && !hasScopedUrl && !hasDomainScope) {
      return { skip: 'too-broad-allow' };
    }
    return {
      rule: {
        priority: important ? PRIORITY.IMPORTANT_ALLOW : PRIORITY.ALLOW,
        action: { type: 'allow' },
        condition,
      },
    };
  }

  // Redirect rules ($redirect=noopjs etc.) — supported for our bundled resource set only.
  if (f.redirect) {
    const resolved = resolveRedirect(f.redirect);
    if (!resolved) return { skip: `redirect:${f.redirect}` };
    // uBO's `:N` suffix ranks redirects matching the same request; it moves the rule within
    // its band only, so it still beats the block it replaces and loses to any allow.
    const offset = Math.max(
      -REDIRECT_PRIORITY_MAX_OFFSET,
      Math.min(REDIRECT_PRIORITY_MAX_OFFSET, resolved.priority),
    );
    return {
      rule: {
        priority: (important ? PRIORITY.IMPORTANT_REDIRECT : PRIORITY.REDIRECT) + offset,
        action: {
          type: 'redirect',
          redirect: { extensionPath: `/redirects/${resolved.resource.file}` },
        },
        condition,
      },
    };
  }

  return {
    rule: {
      priority: important ? PRIORITY.IMPORTANT_BLOCK : PRIORITY.BLOCK,
      action: { type: 'block' },
      condition,
    },
  };
}

function dedup(arr) {
  return [...new Set(arr)];
}

/**
 * Sanitize include/exclude domain lists for DNR.
 * - Dropping an *exclude* widens the rule → skip.
 * - Dropping all *includes* would make the rule global → skip.
 * - Dropping some includes but keeping others narrows safely (under-match).
 * @returns {{ include: string[], exclude: string[] } | { skip: string }}
 */
export function sanitizeDnrDomainLists(include, exclude) {
  const rawInclude = include || [];
  const rawExclude = exclude || [];
  const cleanInclude = rawInclude.filter(isValidDnrDomain);
  const cleanExclude = rawExclude.filter(isValidDnrDomain);
  if (cleanExclude.length !== rawExclude.length) return { skip: 'invalid-domain' };
  if (rawInclude.length && cleanInclude.length === 0) return { skip: 'invalid-domain' };
  return { include: cleanInclude, exclude: cleanExclude };
}

/** Stable dedup key — priority must be included so $important variants are kept. */
export function ruleKey(rule) {
  return JSON.stringify([rule.priority, rule.action, rule.condition]);
}

/**
 * Whether a DNR condition can match a top-level navigation. Chrome leaves `main_frame` out by
 * default only when NEITHER type list is given; a condition with just `excludedResourceTypes`
 * matches documents unless that list names `main_frame`.
 */
export function conditionMatchesMainFrame(condition = {}) {
  if (condition.resourceTypes) return condition.resourceTypes.includes('main_frame');
  if (condition.excludedResourceTypes) {
    return !condition.excludedResourceTypes.includes('main_frame');
  }
  return false;
}

/**
 * Whether the parsed filter asks to act on top-level documents: it names them (`$doc`,
 * `$document`, `$all` — the only tokens parse-filter.mjs maps to `main_frame`) and does not
 * negate them, or it is a `$removeparam`, which has to reach the address bar to strip anything.
 */
function filterTargetsDocuments(filter) {
  const o = filter?.options ?? {};
  if (o.removeParams?.length) return true;
  // A bare `$removeparam` stays in `unsupported` until toDnrRule turns it into a query clear.
  const bare = /^(?:removeparam|queryprune)$/i;
  if ((filter?.unsupported ?? []).some((t) => bare.test(String(t).trim()))) return true;
  const named = (o.resourceTypes ?? []).includes('main_frame');
  return named && !(o.excludedResourceTypes ?? []).includes('main_frame');
}

/**
 * A block or redirect rule that can stop a whole page from loading although its source filter
 * never asked for that. uBO applies a filter to the top-level document only when the filter
 * names it; every other filter is a subresource filter, whatever types it leaves out.
 *
 * 2.2.2 shipped 141 such rules (`-banner-ads-$~script`, `/reklame/*$~xmlhttprequest`,
 * `://ads.$~image,…`): a negated-only type list reached DNR as `excludedResourceTypes` alone,
 * which Chrome reads as "and main_frame too", so matching pages showed "blocked by an
 * extension". compile-filters.mjs refuses to write a ruleset containing one.
 */
export function isAccidentalDocumentRule(rule, filter) {
  const type = rule?.action?.type;
  if (type !== 'block' && type !== 'redirect') return false;
  if (!conditionMatchesMainFrame(rule.condition)) return false;
  return !filterTargetsDocuments(filter);
}
