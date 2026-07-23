// Convert a parsed network filter (from parse-filter.mjs) into a declarativeNetRequest
// rule object (without an `id` — the compiler assigns ids). Returns:
//   { rule }                     on success
//   { skip: reason }             when the filter can't be represented in DNR
//   { cosmeticException }        generichide/elemhide/specifichide (not a network rule)
//
// The lucky break of MV3: DNR's `urlFilter` grammar mirrors EasyList's own anchors
// (`||` domain anchor, `^` separator, `|` boundary, `*` wildcard), so the pattern
// usually passes through untouched. The work is mapping the *options*.

import { createRequire } from 'node:module';
import { PRIORITY } from './limits.mjs';
import { REDIRECT_RESOURCES } from './redirects.mjs';

const require = createRequire(import.meta.url);
const { RE2 } = require('@adguard/re2-wasm');

const MAX_URL_FILTER_LEN = 2000;

/**
 * Chromium DNR compiles each regexFilter with RE2 `max_mem = 2 << 10` (2048),
 * Latin1 encoding, and case-sensitivity matching `isUrlFilterCaseSensitive`
 * (Chrome 118+ defaults that to false).
 *
 * `@adguard/re2-wasm` is Unicode-only, so we cannot mirror Latin1 exactly. We:
 * 1. Validate with `iu` when the emitted rule will be case-insensitive (default),
 *    and `u` when `$match-case` / `isUrlFilterCaseSensitive: true`.
 * 2. Use a tighter budget than AdGuard's 1990 — Unicode underestimates Latin1
 *    Prog size for dense character classes (e.g. ubo-filters id 4247 needs ~1980
 *    in Unicode/`u` but still trips Chrome's 2KB Latin1 limit).
 *
 * @see https://source.chromium.org/chromium/chromium/src/+/main:extensions/browser/api/declarative_net_request/utils.cc
 * @see https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest#regex-rules
 */
const CHROME_REGEX_MAX_MEM = 1950;

/** Is the string safe as a DNR urlFilter? DNR requires ASCII; non-ASCII needs punycode. */
function isAscii(s) {
  return /^[\x00-\x7F]*$/.test(s);
}

/**
 * Chrome DNR `initiatorDomains`/`requestDomains` (and their excluded* variants) accept
 * only canonical lowercase hostnames or IPv4 literals. Filter lists routinely use forms
 * DNR rejects: entity wildcards (`example.*`), bracketed IPv6 (`[::1]`, `[::]`), ports,
 * or paths. Chrome silently drops such a rule (and older Chromium could reject the whole
 * ruleset), so the filter never fires. Mirror src/shared/hostname.ts:isValidMatchPatternHost.
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
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true; // IPv4
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
 * Chrome DNR `regexFilter` is compiled with RE2 (plus a ~2KB compiled-size budget).
 * Emitting a pattern RE2 rejects makes the entire static ruleset fail to load
 * ("Could not load manifest"). Patterns that only exceed the memory budget are
 * skipped per-rule at load time (noisy console warnings) — better not to emit them.
 * Filter lists routinely use JS-only features (lookarounds, backrefs) that must
 * be dropped at compile time.
 *
 * Memory check uses AdGuard's RE2 WASM. Flags must match Chrome's case-sensitivity
 * for the emitted rule: default DNR matching is case-insensitive (`iu`); `$match-case`
 * uses `u`. Validating only with `u` underestimates Prog size and ships rules Chrome
 * then skips (e.g. ubo-badware hex.sbs patterns).
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
  // re2-wasm requires Unicode (`u` / `iu`); Chromium uses Latin1 — prefer dropping a
  // borderline rule over load-time "exceeded the 2KB memory limit" warnings.
  const flags = caseSensitive ? 'u' : 'iu';
  try {
    // RE2 constructor throws when the pattern cannot be compiled within maxMem.
    new RE2(pattern, flags, CHROME_REGEX_MAX_MEM);
  } catch (err) {
    const msg = String(err?.message ?? err);
    if (/too large|memory|compile failed/i.test(msg)) return 'regex-memory';
    return 'regex-syntax';
  }

  return null;
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
  'method',
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

/**
 * Identity for `$badfilter` matching: pattern + options minus the badfilter token.
 * Two filters cancel when their identities are equal.
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
    redirect: f.redirect || null,
  });
}

export function toDnrRule(f) {
  // Cosmetic-only exceptions are never network actions — even when they carry a URL
  // pattern (`@@||example.com^$generichide`). Emitting `allow` would unblock traffic.
  if (f.cosmeticException) {
    return { cosmeticException: f.cosmeticException, pattern: f.pattern, isException: f.isException };
  }

  // $badfilter cancels another filter; never emit it as a DNR rule.
  if (f.options?.badfilter) {
    return { badfilter: true, identity: networkFilterIdentity(f) };
  }

  // $redirect-rule means "redirect only if the request would otherwise be blocked".
  // DNR cannot express that; treating it as $redirect over-neuters allowed resources.
  if (f.redirectRule) {
    return { skip: 'redirect-rule' };
  }

  // Remaining unsupported options must not silently become block/allow.
  if (f.unsupported?.length) {
    return { skip: unsupportedReason(f.unsupported) };
  }

  // @@…$removeparam can't be narrowly exempted in DNR (it would need to allow only the param
  // transform); a broad allow would over-unblock the request. Drop the exception instead.
  if (f.isException && f.options?.removeParams?.length) {
    return { skip: 'exception-removeparam' };
  }

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

  // Resource types.
  const rt = dedup(f.options.resourceTypes);
  const ert = dedup(f.options.excludedResourceTypes);
  if (rt.length) condition.resourceTypes = rt;
  else if (ert.length) condition.excludedResourceTypes = ert;

  // Party (first/third).
  if (f.options.thirdParty === true) condition.domainType = 'thirdParty';
  else if (f.options.thirdParty === false) condition.domainType = 'firstParty';

  // Initiator (document) domain constraints ($domain / $from).
  const initSan = sanitizeDnrDomainLists(
    dedup(f.options.initiatorDomains),
    dedup(f.options.excludedInitiatorDomains),
  );
  if (initSan.skip) return { skip: initSan.skip };
  const initDomains = initSan.include;
  const exInitDomains = initSan.exclude;
  if (initDomains.length) condition.initiatorDomains = initDomains;
  if (exInitDomains.length) condition.excludedInitiatorDomains = exInitDomains;

  // Destination host constraints ($to / $denyallow).
  const reqSan = sanitizeDnrDomainLists(
    dedup(f.options.requestDomains),
    dedup(f.options.excludedRequestDomains),
  );
  if (reqSan.skip) return { skip: reqSan.skip };
  const reqDomains = reqSan.include;
  const exReqDomains = reqSan.exclude;
  if (reqDomains.length) condition.requestDomains = reqDomains;
  if (exReqDomains.length) condition.excludedRequestDomains = exReqDomains;

  if (f.options.matchCase) condition.isUrlFilterCaseSensitive = true;

  // $removeparam=<name> → strip query params via DNR redirect + queryTransform. A global
  // param strip (no url/domain) is legitimate — unlike a global block — so emit it before
  // the too-broad guard. removeParams no-ops when the param is absent (no redirect loop).
  if (f.options.removeParams && f.options.removeParams.length) {
    return {
      rule: {
        priority: f.options.important ? PRIORITY.IMPORTANT_REDIRECT : PRIORITY.REDIRECT,
        action: {
          type: 'redirect',
          redirect: { transform: { queryTransform: { removeParams: dedup(f.options.removeParams) } } },
        },
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
    if (rt.includes('main_frame')) {
      // Resource types alone are not enough scope here: `@@$document` / `@@*$document`
      // would otherwise emit allowAllRequests with only main_frame and disable network
      // blocking for every top-level navigation (Chrome exempts that frame tree).
      // Require a positive URL or include-domain constraint; exclude-only / type-only
      // document exceptions stay skipped. (Plain allow/block may still use type-only
      // scope — e.g. EasyPrivacy `$ping,third-party`.)
      if (
        !condition.urlFilter &&
        !condition.regexFilter &&
        !initDomains.length &&
        !reqDomains.length
      ) {
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
    const resource = REDIRECT_RESOURCES[f.redirect];
    if (!resource) return { skip: `redirect:${f.redirect}` };
    return {
      rule: {
        priority: important ? PRIORITY.IMPORTANT_REDIRECT : PRIORITY.REDIRECT,
        action: {
          type: 'redirect',
          redirect: { extensionPath: `/redirects/${resource.file}` },
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
