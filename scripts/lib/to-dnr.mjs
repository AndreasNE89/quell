// Convert a parsed network filter (from parse-filter.mjs) into a declarativeNetRequest
// rule object (without an `id` — the compiler assigns ids). Returns:
//   { rule }                     on success
//   { skip: reason }             when the filter can't be represented in DNR
//   { cosmeticException }        generichide/elemhide/specifichide (not a network rule)
//
// The lucky break of MV3: DNR's `urlFilter` grammar mirrors EasyList's own anchors
// (`||` domain anchor, `^` separator, `|` boundary, `*` wildcard), so the pattern
// usually passes through untouched. The work is mapping the *options*.

import { PRIORITY } from './limits.mjs';
import { REDIRECT_RESOURCES } from './redirects.mjs';

const MAX_URL_FILTER_LEN = 2000;

/** Is the string safe as a DNR urlFilter? DNR requires ASCII; non-ASCII needs punycode. */
function isAscii(s) {
  return /^[\x00-\x7F]*$/.test(s);
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

export function toDnrRule(f) {
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

  // Remaining unsupported options must not silently become block/allow.
  if (f.unsupported?.length) {
    return { skip: unsupportedReason(f.unsupported) };
  }

  const condition = {};

  if (f.isRegex) {
    const regex = f.pattern.slice(1, -1);
    if (!regex) return { skip: 'empty-regex' };
    if (!isAscii(regex)) return { skip: 'non-ascii-regex' };
    condition.regexFilter = regex;
  } else if (f.pattern && f.pattern !== '*') {
    if (!isAscii(f.pattern)) return { skip: 'non-ascii' };
    if (f.pattern.length > MAX_URL_FILTER_LEN) return { skip: 'too-long' };
    condition.urlFilter = f.pattern;
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
  const initDomains = dedup(f.options.initiatorDomains);
  const exInitDomains = dedup(f.options.excludedInitiatorDomains);
  if (initDomains.length) condition.initiatorDomains = initDomains;
  if (exInitDomains.length) condition.excludedInitiatorDomains = exInitDomains;

  // Destination host constraints ($to / $denyallow).
  const reqDomains = dedup(f.options.requestDomains);
  const exReqDomains = dedup(f.options.excludedRequestDomains);
  if (reqDomains.length) condition.requestDomains = reqDomains;
  if (exReqDomains.length) condition.excludedRequestDomains = exReqDomains;

  if (f.options.matchCase) condition.isUrlFilterCaseSensitive = true;

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
    // Only *document-level* exceptions ($document/$subdocument) map to
    // allowAllRequests — that action matches the FRAME's URL and exempts the whole
    // frame tree. A bare `@@||domain^` (no resource type) must stay a plain `allow`,
    // which matches the request's own URL and can unblock a subresource; funneling it
    // into allowAllRequests would silently fail to unblock third-party subrequests.
    const isDocLevel = rt.includes('main_frame') || rt.includes('sub_frame');
    if (isDocLevel) {
      // allowAllRequests forbids any other condition fields for resource typing.
      delete condition.excludedResourceTypes;
      condition.resourceTypes = ['main_frame', 'sub_frame'];
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

/** Stable dedup key — priority must be included so $important variants are kept. */
export function ruleKey(rule) {
  return JSON.stringify([rule.priority, rule.action, rule.condition]);
}
