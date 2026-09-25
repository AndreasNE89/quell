// Parser for Adblock Plus / EasyList / uBlock Origin filter syntax.
//
// A filter list is a newline-delimited text file. Each line is one of:
//   - a comment            (starts with `!` or `[Adblock ...]`)
//   - a network rule       (`||ads.example^$script,third-party`)
//   - a network exception  (`@@||good.example^`)
//   - a cosmetic rule      (`example.com##.ad`, `#@#`, `#?#`, `#$#`, `##+js(...)`)
//
// `!#if` / `!#else` / `!#endif` / `!#include` are list-level directives, not lines to parse:
// run the whole list through preprocessFilterText first, then parseLine what it keeps.
//
// We parse into a small tagged union. Conversion to DNR / cosmetic data happens later.
// Anything we can't represent is returned with `unsupported` populated so the compiler
// can count and report coverage instead of silently dropping rules.

import { isProceduralCosmeticBody, normalizeAbpSelector } from './procedural-ops.mjs';

/** Resource-type keywords (EasyList) → DNR resourceType. `null` = recognized but no DNR equivalent. */
const RESOURCE_TYPE_MAP = {
  script: 'script',
  image: 'image',
  stylesheet: 'stylesheet',
  css: 'stylesheet',
  object: 'object',
  'object-subrequest': 'object',
  xmlhttprequest: 'xmlhttprequest',
  xhr: 'xmlhttprequest',
  subdocument: 'sub_frame',
  frame: 'sub_frame',
  document: 'main_frame',
  doc: 'main_frame',
  media: 'media',
  font: 'font',
  websocket: 'websocket',
  ping: 'ping',
  beacon: 'ping',
  other: 'other',
  // Recognized EasyList tokens with no DNR resource-type mapping:
  popup: null,
  webrtc: null,
};

const ALL_RESOURCE_TYPES = [
  'main_frame', 'sub_frame', 'stylesheet', 'script', 'image',
  'font', 'object', 'xmlhttprequest', 'ping', 'media', 'websocket', 'other',
];

/** Detect cosmetic separators. Returns the index and kind, or null for network rules. */
function findCosmeticSeparator(line) {
  // Order matters: check longer/rarer separators before `##`.
  // uBO/ABP cosmetic operators:
  //   ##   element hide            #@#  element unhide (exception)
  //   #?#  procedural cosmetic     #@?# procedural exception
  //   #$#  CSS injection / snippet #$?# procedural style
  //   #%#  scriptlet (AdGuard)
  const seps = [
    { tok: '#@?#', kind: 'unhide', procedural: true },
    { tok: '#@$#', kind: 'unhide', style: true },
    { tok: '#$?#', kind: 'style', procedural: true },
    { tok: '#?#', kind: 'hide', procedural: true },
    { tok: '#$#', kind: 'style' },
    { tok: '#%#', kind: 'adguard-scriptlet' },
    { tok: '#@#', kind: 'unhide' },
    { tok: '##', kind: 'hide' },
  ];
  for (const s of seps) {
    const idx = line.indexOf(s.tok);
    if (idx !== -1) return { idx, ...s };
  }
  return null;
}

/** Parse the domain-restriction prefix of a cosmetic rule, e.g. `a.com,~b.com`. */
function parseCosmeticDomains(prefix) {
  const include = [];
  const exclude = [];
  if (!prefix) return { include, exclude };
  for (const part of prefix.split(',')) {
    const d = part.trim();
    if (!d) continue;
    if (d.startsWith('~')) exclude.push(d.slice(1).toLowerCase());
    else include.push(d.toLowerCase());
  }
  return { include, exclude };
}

/** Parse a uBO scriptlet body: `+js(name, arg1, arg2)` → {name, args}. */
function parseScriptletBody(body) {
  const m = body.match(/^\+js\(([\s\S]*)\)$/);
  if (!m) return null;
  const parts = splitArgs(m[1]);
  const name = parts.shift() || '';
  if (!name) return null;
  return { name, args: parts };
}

const WHITESPACE = /\s/;

/** True when `s[pos]` is preceded by an odd-length run of backslashes, i.e. it is escaped. */
function isEscapedAt(s, pos) {
  let run = 0;
  for (let i = pos - 1; i >= 0 && s[i] === '\\'; i--) run++;
  return (run & 1) === 1;
}

/** Index of the next `ch` at or after `from` that is not escaped, or -1. */
function indexOfUnescaped(s, ch, from) {
  for (let pos = s.indexOf(ch, from); pos !== -1; pos = s.indexOf(ch, pos + 1)) {
    if (!isEscapedAt(s, pos)) return pos;
  }
  return -1;
}

/**
 * Drop the escaping backslash in front of `ch`: an odd run loses one backslash, an even run
 * is a run of literal backslashes and is kept whole (uBO `normalizeArg`).
 */
function unescapeChar(s, ch) {
  if (!s.includes('\\')) return s;
  // `ch` is `,` or a quote — none of them is special in a RegExp.
  return s.replace(new RegExp(`(\\\\+)${ch}`, 'g'), (_, run) =>
    ((run.length & 1) === 1 ? run.slice(1) : run) + ch,
  );
}

/**
 * Split scriptlet args the way uBO's ArglistParser does (src/js/arglist-parser.js), so a
 * rule means here what it means in uBO:
 *
 *   - Arguments are separated by `,` and trimmed of surrounding whitespace.
 *   - An argument that opens with `'`, `"` or `` ` `` runs to the next unescaped copy of that
 *     quote. The quotes are removed only when the closing quote is followed by optional
 *     whitespace and then `,` or the end; otherwise the argument is read unquoted, quotes
 *     included. Inside quotes, `,` needs no escaping.
 *   - The only escape consumed is a backslash in front of the active delimiter (`,` or the
 *     quote), and only when an odd number of backslashes precede it. Every other backslash is
 *     kept, so `\\` stays `\\`: `/\\x|_blank/` has to reach RegExp as a literal backslash
 *     followed by x, not as `\x` (which matches every "x").
 */
export function splitArgs(s) {
  const args = [];
  const len = s.length;
  let beg = 0;
  while (beg < len) {
    let start = beg;
    while (start < len && WHITESPACE.test(s[start])) start++;
    const quote = s[start];
    if (quote === '"' || quote === "'" || quote === '`') {
      const close = indexOfUnescaped(s, quote, start + 1);
      if (close !== -1) {
        let after = close + 1;
        while (after < len && WHITESPACE.test(s[after])) after++;
        if (after === len || s[after] === ',') {
          args.push(unescapeChar(s.slice(start + 1, close), quote));
          beg = after + 1;
          continue;
        }
      }
    }
    const sep = indexOfUnescaped(s, ',', start);
    const stop = sep === -1 ? len : sep;
    let end = stop;
    while (end > start && WHITESPACE.test(s[end - 1])) end--;
    args.push(unescapeChar(s.slice(start, end), ','));
    beg = stop + 1;
  }
  return args;
}

function parseCosmetic(line, sep) {
  const domainPrefix = line.slice(0, sep.idx);
  let body = line.slice(sep.idx + sep.tok.length);
  const domains = parseCosmeticDomains(domainPrefix);

  // Scriptlet injection: uBO `##+js(...)` or `#@#+js(...)`, or AdGuard `#%#//scriptlet(...)`.
  if (sep.kind === 'adguard-scriptlet' || body.startsWith('+js(')) {
    let scriptlet = null;
    if (body.startsWith('+js(')) {
      scriptlet = parseScriptletBody(body);
    } else {
      const m = body.match(/^\/\/scriptlet\(([\s\S]*)\)$/);
      if (m) {
        // AdGuard quotes every argument; splitArgs already removes the quotes.
        const parts = splitArgs(m[1]);
        const name = parts.shift();
        if (name) scriptlet = { name, args: parts };
      }
    }
    if (!scriptlet) return { type: 'cosmetic', kind: 'ignored', raw: line };
    return {
      type: 'cosmetic',
      kind: 'scriptlet',
      raw: line,
      domains,
      scriptlet,
      isException: sep.kind === 'unhide',
    };
  }

  // CSS-injection / snippet rules (`#$#`) that aren't procedural styles are uBO scriptlet
  // snippets or ABP snippets — out of scope for the prototype's cosmetic CSS engine.
  if (sep.kind === 'style' && !sep.procedural) {
    return { type: 'cosmetic', kind: 'ignored', raw: line };
  }

  // uBO HTML filters (`##^script:has-text(…)`, `##^responseheader(…)`) edit the response body
  // or headers before parsing — a Firefox-only webRequest capability. As a selector `^script`
  // is invalid CSS, so they would ship as rules that can never match.
  if (body.startsWith('^')) {
    return { type: 'cosmetic', kind: 'ignored', raw: line, unsupported: 'html-filter' };
  }

  const abp = normalizeAbpSelector(body);
  if (abp.unsupported) {
    return { type: 'cosmetic', kind: 'ignored', raw: line, unsupported: abp.unsupported };
  }
  body = abp.selector;

  const isException = sep.kind === 'unhide';
  const procedural = !!sep.procedural || isProceduralCosmeticBody(body);

  return {
    type: 'cosmetic',
    kind: isException ? 'unhide' : procedural ? 'procedural' : 'hide',
    raw: line,
    domains,
    selector: body.trim(),
    isException,
    procedural,
  };
}

function parseNetwork(line) {
  const raw = line;
  let isException = false;
  let text = line;
  if (text.startsWith('@@')) {
    isException = true;
    text = text.slice(2);
  }

  // Split pattern from options at the last unescaped `$` that introduces options.
  // (A `$` can legitimately appear inside a regex pattern `/.../`, so only split when
  // the pattern is not a full regex, or the `$` is clearly followed by option tokens.)
  let pattern = text;
  let optionStr = '';
  const dollar = findOptionsDollar(text);
  if (dollar !== -1) {
    pattern = text.slice(0, dollar);
    optionStr = text.slice(dollar + 1);
  }

  const isRegex = pattern.length > 1 && pattern.startsWith('/') && pattern.endsWith('/');

  const options = {
    resourceTypes: [],
    excludedResourceTypes: [],
    initiatorDomains: [],
    excludedInitiatorDomains: [],
    requestDomains: [],
    excludedRequestDomains: [],
    removeParams: [], // $removeparam=<name> — exact query-param names to strip
    thirdParty: null, // true | false | null
    matchCase: false,
    important: false,
    badfilter: false,
  };
  const unsupported = [];
  let cosmeticException = null; // generichide / elemhide / specifichide
  let redirect = null; // $redirect=<resource>
  let redirectRule = false; // $redirect-rule=… (not expressible in DNR)

  if (optionStr) {
    for (const tokenRaw of splitOptionTokens(optionStr)) {
      const token = tokenRaw.trim();
      if (!token) continue;
      const neg = token.startsWith('~');
      const key = neg ? token.slice(1) : token;
      const eq = key.indexOf('=');
      const name = eq === -1 ? key : key.slice(0, eq);
      const value = eq === -1 ? '' : key.slice(eq + 1);

      if (name in RESOURCE_TYPE_MAP) {
        const mapped = RESOURCE_TYPE_MAP[name];
        if (mapped === null) {
          unsupported.push(token);
        } else if (neg) {
          options.excludedResourceTypes.push(mapped);
        } else {
          options.resourceTypes.push(mapped);
        }
        continue;
      }

      switch (name) {
        case 'third-party':
        case '3p':
          options.thirdParty = !neg;
          break;
        case 'first-party':
        case '1p':
          options.thirdParty = neg; // ~first-party == third-party
          break;
        case 'domain':
        case 'from':
          for (const d of value.split('|')) {
            const dd = d.trim().toLowerCase();
            if (!dd) continue;
            if (dd.startsWith('~')) options.excludedInitiatorDomains.push(dd.slice(1));
            else options.initiatorDomains.push(dd);
          }
          break;
        case 'to':
          // Destination host(s) of the request (DNR requestDomains).
          for (const d of value.split('|')) {
            const dd = d.trim().toLowerCase();
            if (!dd) continue;
            if (dd.startsWith('~')) options.excludedRequestDomains.push(dd.slice(1));
            else options.requestDomains.push(dd);
          }
          break;
        case 'denyallow':
          // Allowlisted destination exceptions within a broader block.
          for (const d of value.split('|')) {
            const dd = d.trim().toLowerCase();
            if (!dd || dd.startsWith('~')) continue;
            options.excludedRequestDomains.push(dd);
          }
          break;
        case 'match-case':
          options.matchCase = true;
          break;
        case 'important':
          options.important = true;
          break;
        case 'badfilter':
          // Cancels a matching filter (same pattern+options minus this token) at compile time.
          options.badfilter = true;
          break;
        case 'all':
          // uBO's `$all` means every type INCLUDING the top-level document. DNR's default when
          // resourceTypes is omitted is every type EXCEPT main_frame, so the types must be
          // listed explicitly or `$all` never blocks a navigation. ubo-badware ships 1368 of
          // these (phishing/malware hosts) and is enabled by default.
          for (const t of ALL_RESOURCE_TYPES) {
            if (!options.resourceTypes.includes(t)) options.resourceTypes.push(t);
          }
          break;
        case 'reason':
          // uBO strict-block page metadata only — ignore so the network rule still emits.
          // ubo-badware ships `$all,reason=malicious` / `$doc,reason="…"`; treating reason
          // as unsupported dropped those phishing/malware host blocks entirely.
          break;
        case 'redirect':
          // $redirect=noopjs → serve a neutered bundled resource instead of the request.
          redirect = value.trim();
          break;
        case 'redirect-rule':
          // Only redirect if the request would otherwise be blocked — not expressible in DNR.
          redirectRule = true;
          redirect = value.trim();
          break;
        case 'generichide':
        case 'ghide': // uBO alias
          cosmeticException = 'generichide';
          break;
        case 'elemhide':
        case 'ehide': // uBO alias
          cosmeticException = 'elemhide';
          break;
        case 'specifichide':
        case 'shide': // uBO alias
          cosmeticException = 'specifichide';
          break;
        case 'removeparam':
        case 'queryprune':
          // DNR queryTransform.removeParams accepts exact param NAMES only. Skip regex
          // (/.../), negation (~keep), and the bare form (strip-all) — not expressible here.
          if (value && !value.startsWith('/') && !value.startsWith('~') && !value.endsWith('/')) {
            options.removeParams.push(value);
          } else {
            unsupported.push(token);
          }
          break;
        default:
          unsupported.push(token);
      }
    }
  }

  // A typeless `$removeparam` must strip the param from the top-level URL too. Same DNR
  // default-excludes-main_frame trap as `$all` above — without this every $removeparam rule
  // is inert for the one request type users actually see in the address bar.
  if (options.removeParams.length && !options.resourceTypes.length) {
    options.resourceTypes.push(...ALL_RESOURCE_TYPES);
  }

  return {
    type: 'network',
    raw,
    isException,
    pattern: pattern.trim(),
    isRegex,
    options,
    unsupported,
    cosmeticException,
    redirect,
    redirectRule,
  };
}

/**
 * Split EasyList/uBO options on commas that start a new option.
 * Values may contain commas (`$replace=/a,b/`, `$header=vary:/^x\,y/`); only split
 * when the text after `,` looks like `~?name` followed by `=`, `,`, or end.
 */
function splitOptionTokens(optionStr) {
  const tokens = [];
  let start = 0;
  for (let i = 0; i < optionStr.length; i++) {
    if (optionStr[i] !== ',') continue;
    const rest = optionStr.slice(i + 1).trimStart();
    if (!rest || /^(~?[a-z0-9-]+)(=|,|$)/i.test(rest)) {
      tokens.push(optionStr.slice(start, i));
      start = i + 1;
    }
  }
  tokens.push(optionStr.slice(start));
  return tokens;
}

/**
 * True when `optionStr` looks like a comma-separated EasyList/uBO options list.
 * Option *names* are [a-z0-9-]+ (optionally negated, optionally =value). Path
 * fragments like `web/*index.html$doc` or `.min.js|$script` fail this check.
 */
function looksLikeOptionString(optionStr) {
  if (!optionStr) return false;
  const tokens = splitOptionTokens(optionStr);
  if (!tokens.length) return false;
  for (const tokenRaw of tokens) {
    const token = tokenRaw.trim();
    if (!token) return false;
    const key = token.startsWith('~') ? token.slice(1) : token;
    if (!key) return false;
    const eq = key.indexOf('=');
    const name = eq === -1 ? key : key.slice(0, eq);
    if (!/^[a-z0-9-]+$/i.test(name)) return false;
  }
  return true;
}

function findOptionsDollar(text) {
  // Full regex filters are `/pattern/` optionally followed by `$options`. When the
  // last `/` is immediately followed by `$` + option-shaped suffix, that `$` is the
  // options delimiter (preserves `$` end-anchors inside `/ads$/`).
  //
  // Do NOT treat "ends with `/`" as "regex, no options": `$replace=/…/` and similar
  // option values also end with `/`, and path filters like
  // `/file.js|$script,replace=/x/` must fall through to the options-looking `$` scan.
  const isFullRegexCandidate = text.length > 1 && text.startsWith('/') && text.lastIndexOf('/') > 0;
  if (isFullRegexCandidate) {
    const close = text.lastIndexOf('/');
    if (
      close + 1 < text.length &&
      text[close + 1] === '$' &&
      looksLikeOptionString(text.slice(close + 2))
    ) {
      return close + 1; // `/pattern/$options`
    }
    // else: `/pattern/`, or path-like `/foo|$opts` — fall through
  }
  // Non-regex (or path-anchored): URLs may contain a literal `$` (Azure `$web`,
  // `$.min.js`). Use the LAST `$` whose suffix looks like options — never the first
  // `$` blindly, or path `$` steals the split and the rule is skipped as unsupported.
  let found = -1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\') {
      i++;
      continue;
    }
    if (text[i] === '$' && looksLikeOptionString(text.slice(i + 1))) {
      found = i;
    }
  }
  return found;
}

/** What may follow the host in a pattern that still covers the whole host (any path, any port). */
const HOST_ONLY_TAIL = /^(?:\^?\*?|\/\*?|:)$/;

/**
 * A path (and query) both a Chrome match pattern and the runtime check can test: literal
 * characters and `*`, optionally closed by a `|` end anchor. A `^` separator has no equivalent.
 */
const PATH_TAIL = /^\/[A-Za-z0-9._~!$&'()+,;=:@%/?*-]*\|?$/;

/**
 * Page scope of a network cosmetic exception (`@@…$generichide` / `$elemhide` /
 * `$specifichide`), read from its URL pattern: the host, and the path it is limited to.
 *
 * The runtime keys these exceptions by host: an exact hostname (subdomains included) or an
 * entity `name.*`. Accepted hosts:
 *   - `||host^`, `||host/`, `|https://host^`, bare `host.tld^`
 *   - `://host/` or `://host:` (EasyList's `://localhost/` and `://127.0.0.1` exceptions)
 *   - `||name.*^` and the trailing-dot hostname prefix `||name.` → entity `name.*`. A bare
 *     `stream4free` would miss stream4free.tv under suffix matching and hit evil.stream4free.
 *
 * `path` is null for a whole-host pattern. A host-anchored pattern with a literal path keeps it
 * as a match-pattern path glob: EasyList's `@@||bing.com/search?$generichide` gives `bing.com`
 * + `/search?*`, which must switch generic hiding off on the results page and nowhere else on
 * the site. Chrome tests a match pattern's path against the URL's path and query.
 *
 * Everything else returns `skip` and no host:
 *   - `path-scoped`: a regex, a bare substring, or a path with a `^` separator. Keying it by
 *     host would switch cosmetics off on every page of the site.
 *   - `partial-host`: a wildcard inside the host (`||192.168.*.1/`, `||animedao*.*^`) or a
 *     truncated IP (`://192.168.`). Emitting the truncated `192.168` gave Chrome an invalid
 *     `excludeMatches` host and it rejected the whole generic-cosmetic registration.
 *
 * @returns {{ hosts: string[], path: string | null, skip: 'path-scoped' | 'partial-host' | null }}
 */
export function cosmeticExceptionScope(pattern, isRegex) {
  const none = (skip) => ({ hosts: [], path: null, skip });
  if (isRegex) return none('path-scoped');
  const raw = String(pattern || '').trim();
  // `@@*$generichide,domain=…` — scoped by its options only.
  if (!raw || raw === '*') return none(null);

  let rest;
  let anchored = true;
  const scheme = /^\|?(?:[a-z][a-z0-9+.-]*)?:\/\//i.exec(raw);
  if (raw.startsWith('||')) rest = raw.slice(2);
  else if (scheme) rest = raw.slice(scheme[0].length);
  else {
    rest = raw;
    anchored = false;
  }
  const [, hostPart, tail] = /^([^/^:?|]*)(.*)$/.exec(rest);
  const rawHost = hostPart.toLowerCase();
  let path = null;
  if (!HOST_ONLY_TAIL.test(tail)) {
    // Case is kept: Chrome compares a match pattern's path case-sensitively.
    if (!anchored || !PATH_TAIL.test(tail)) return none('path-scoped');
    path = tail.replace(/\*+/g, '*');
    if (path.endsWith('|')) path = path.slice(0, -1);
    else if (!path.endsWith('*')) path += '*';
  }
  // An unanchored pattern is a substring match; only treat it as a host when it looks like one.
  if (!anchored && !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(rawHost)) return none('path-scoped');

  let host = rawHost;
  let entity = false;
  if (host.endsWith('.*')) {
    host = host.slice(0, -2);
    entity = true;
  } else if (host.endsWith('.')) {
    host = host.slice(0, -1);
    entity = true;
  }
  if (entity && host.startsWith('www.')) host = host.slice(4);

  const labels = host.split('.');
  if (!host || labels.some((l) => !/^[a-z0-9_-]+$/.test(l))) return none('partial-host');
  if (/^\d+$/.test(labels[labels.length - 1])) {
    // A numeric last label is an IP. Only a complete dotted quad is a host; `192.168.` or
    // `10.0.0` would need prefix matching the runtime doesn't have. `||519.*^` (a one-label
    // entity) is a name, not an address.
    const fullIPv4 = labels.length === 4 && labels.every((l) => l.length <= 3 && Number(l) <= 255);
    if (entity ? labels.length > 1 : !fullIPv4) return none('partial-host');
  }
  return { hosts: [entity ? `${host}.*` : host], path, skip: null };
}

/**
 * The whole-host part of {@link cosmeticExceptionScope}: a path-scoped pattern has no host that
 * covers it, so it reports `path-scoped` here.
 *
 * @returns {{ hosts: string[], skip: 'path-scoped' | 'partial-host' | null }}
 */
export function cosmeticExceptionHosts(pattern, isRegex) {
  const scope = cosmeticExceptionScope(pattern, isRegex);
  if (scope.path !== null) return { hosts: [], skip: 'path-scoped' };
  return { hosts: scope.hosts, skip: scope.skip };
}

/** Hosts from {@link cosmeticExceptionHosts}; empty when the pattern can't be keyed by host. */
export function hostsFromPattern(pattern, isRegex) {
  return cosmeticExceptionHosts(pattern, isRegex).hosts;
}

// --- `!#if` / `!#else` / `!#endif` / `!#include` preprocessor -----------------------------

/**
 * `!#if` tokens → the environment flag each one tests, as in uBO's static-filtering-parser.js
 * (`preparserTokens`). uBO maps `ext_abp` and the AdGuard app/Safari tokens to a flag that is
 * never set, so a list can fence off syntax only those blockers understand.
 */
const PREPROCESSOR_TOKENS = new Map([
  ['ext_ublock', 'ublock'],
  ['ext_ubol', 'ubol'],
  ['ext_devbuild', 'devbuild'],
  ['env_chromium', 'chromium'],
  ['env_edge', 'edge'],
  ['env_firefox', 'firefox'],
  ['env_legacy', 'legacy'],
  ['env_mobile', 'mobile'],
  ['env_mv3', 'mv3'],
  ['env_safari', 'safari'],
  ['cap_html_filtering', 'html_filtering'],
  ['cap_user_stylesheet', 'user_stylesheet'],
  ['cap_ipaddress', 'ipaddress'],
  ['false', 'false'],
  ['ext_abp', 'false'],
  ['adguard', 'adguard'],
  ['adguard_app_android', 'false'],
  ['adguard_app_ios', 'false'],
  ['adguard_app_mac', 'false'],
  ['adguard_app_windows', 'false'],
  ['adguard_ext_android_cb', 'false'],
  ['adguard_ext_chromium', 'chromium'],
  ['adguard_ext_edge', 'edge'],
  ['adguard_ext_firefox', 'firefox'],
  ['adguard_ext_opera', 'chromium'],
  ['adguard_ext_safari', 'false'],
]);

/**
 * The environment StampStack's compiled rules run in: one MV3 build for desktop Chromium.
 *
 * - `chromium`, `mv3`: true by construction.
 * - `ublock`: true. The parser implements uBO's syntax (scriptlets, procedural operators), so
 *   branches written for "a uBO-syntax blocker" are the ones it can read.
 * - `ubol`: true for network filters only. uBO maintainers use `!#if ext_ubol` for uBO Lite, the
 *   MV3 build that — like StampStack — compiles lists offline into static declarativeNetRequest
 *   rulesets. Those branches replace rules that need webRequest (`$removeparam` exceptions,
 *   `header=`, `$csp`, `from=` on `$doc`) with DNR-expressible ones, and the `!ext_ubol`
 *   branches are the webRequest originals. uBO's own MV2 build is the wrong model for a DNR
 *   ruleset. Cosmetic and scriptlet filters are the other way round: StampStack injects them at
 *   runtime with uBO MV2's scriptlets, and the uBO Lite branches swap in scriptlets it does not
 *   have (`trusted-replace-argument` for bild.de's json-prune pair, `trusted-prevent-fetch` for
 *   welt.de's no-fetch-if). See {@link COSMETIC_PREPROCESSOR_ENV}.
 * - `html_filtering`, `ipaddress`: false. Both need Firefox-only webRequest APIs.
 * - `user_stylesheet`: false. The cosmetic CSS is injected as author-origin CSS.
 * - `firefox`, `safari`, `mobile`, `edge`, `legacy`, `devbuild`, `adguard`: false.
 */
export const PREPROCESSOR_ENV = Object.freeze(['chromium', 'mv3', 'ublock', 'ubol']);

/** {@link PREPROCESSOR_ENV} for cosmetic and scriptlet lines: uBO MV2's branches, not uBO Lite's. */
export const COSMETIC_PREPROCESSOR_ENV = Object.freeze(
  PREPROCESSOR_ENV.filter((flag) => flag !== 'ubol'),
);

/**
 * Evaluate a `!#if` expression in uBO's grammar: an optional outer `( … )`, then tokens joined
 * by `&&` or `||` (whitespace-separated), each optionally negated with `!`.
 *
 * Returns `undefined` — the caller drops both branches and counts it — for an unknown token, a
 * malformed expression, or one mixing `&&` and `||`. uBO's handling of unknown tokens has
 * changed across versions, and a mix depends on precedence rules the lists never rely on, so
 * guessing could ship the wrong branch.
 *
 * @param {string} expr
 * @param {readonly string[]} [env]
 * @returns {boolean | undefined}
 */
export function evaluatePreprocessorExpression(expr, env = PREPROCESSOR_ENV) {
  let e = expr.trim();
  if (e.startsWith('(') && e.endsWith(')')) e = e.slice(1, -1).trim();
  const tokens = e.split(/\s+/).filter(Boolean);
  if (!tokens.length || tokens.length % 2 === 0) return undefined;
  if (tokens.includes('&&') && tokens.includes('||')) return undefined;
  const evalToken = (token) => {
    const not = token.startsWith('!');
    const flag = PREPROCESSOR_TOKENS.get(not ? token.slice(1) : token);
    if (flag === undefined) return undefined;
    return env.includes(flag) !== not;
  };
  let result = evalToken(tokens[0]);
  if (result === undefined) return undefined;
  for (let i = 1; i < tokens.length; i += 2) {
    const op = tokens[i];
    const value = evalToken(tokens[i + 1]);
    if (value === undefined) return undefined;
    if (op === '&&') result = result && value;
    else if (op === '||') result = result || value;
    else return undefined;
  }
  return result;
}

const DIRECTIVE = /^!#(if|else|endif)\b(.*)$/;
const INCLUDE = /^!#include\s+(\S+)/;

/** A line that would compile to something — not blank, not a comment, not a header. */
function isRuleLine(line) {
  const t = line.trim();
  return t !== '' && !t.startsWith('!') && !(t.startsWith('[') && /\[Adblock/i.test(t));
}

/**
 * Apply uBO's list preprocessor: keep only the lines in active `!#if` branches and expand
 * `!#include`.
 *
 * Without this every branch compiled: Firefox-only allow rules
 * (`@@||amazon-adsystem.com/$script` on 14 sites) shipped to Chrome, and both halves of every
 * `!#if … !#else` ran together.
 *
 * - Directives count only at the start of a line, as in uBO.
 * - An `!#if` whose expression can't be evaluated drops both of its branches and is counted.
 * - `!#include file` in an active branch is expanded in place (with its own `!#if` stack) only
 *   when `resolveInclude(file)` returns text. The compiler never downloads — an include that is
 *   not on disk is skipped and counted.
 * - An unmatched `!#else` / `!#endif` is ignored; an unclosed `!#if` runs to end of file.
 * - Network lines are judged against `env`, cosmetic and scriptlet lines against `cosmeticEnv`
 *   (`env` without `ubol` unless given). An `!#include` is expanded when either would keep it,
 *   and its lines are then judged by their own kind against the enclosing branches too.
 *
 * @param {string} text
 * @param {{ env?: readonly string[], cosmeticEnv?: readonly string[],
 *   resolveInclude?: (name: string) => string | null }} [opts]
 * @returns {{ lines: string[], stats: {
 *   droppedRules: number,
 *   droppedByCondition: Record<string, number>,
 *   unknownConditions: number,
 *   includesResolved: string[],
 *   includesUnresolved: string[],
 * } }}
 */
export function preprocessFilterText(
  text,
  { env = PREPROCESSOR_ENV, cosmeticEnv = null, resolveInclude = null } = {},
) {
  const cosEnv = cosmeticEnv ?? env.filter((flag) => flag !== 'ubol');
  const stats = {
    droppedRules: 0,
    droppedByCondition: {},
    unknownConditions: 0,
    includesResolved: [],
    includesUnresolved: [],
  };
  const lines = [];

  /**
   * @typedef {{ cond: string, known: boolean, net: boolean, cos: boolean, inElse: boolean }} Frame
   * @param {string} src
   * @param {Set<string>} seen
   * @param {Frame[]} outer  the including file's open branches
   */
  const expand = (src, seen, outer) => {
    /** @type {Frame[]} */
    const stack = [];
    for (const raw of src.split('\n')) {
      const line = raw.trimEnd();
      const d = DIRECTIVE.exec(line);
      if (d) {
        const top = stack[stack.length - 1];
        if (d[1] === 'if') {
          const cond = d[2].trim();
          const net = evaluatePreprocessorExpression(cond, env);
          const cos = evaluatePreprocessorExpression(cond, cosEnv);
          const known = net !== undefined && cos !== undefined;
          if (!known) stats.unknownConditions++;
          stack.push({ cond, known, net: known && net, cos: known && cos, inElse: false });
        } else if (d[1] === 'else') {
          if (top) {
            top.inElse = !top.inElse;
            if (top.known) {
              top.net = !top.net;
              top.cos = !top.cos;
            }
          }
        } else {
          stack.pop();
        }
        continue;
      }
      const frames = outer.length ? [...outer, ...stack] : stack;
      const inc = INCLUDE.exec(line);
      const t = line.trim();
      const kind = inc ? null : findCosmeticSeparator(t) ? 'cos' : 'net';
      const blocker = frames.find((f) => (kind ? !f[kind] : !f.net && !f.cos));
      if (blocker) {
        if (isRuleLine(line)) {
          stats.droppedRules++;
          const key = blocker.known
            ? blocker.inElse
              ? `!#else of ${blocker.cond}`
              : blocker.cond
            : `unknown: ${blocker.cond}`;
          stats.droppedByCondition[key] = (stats.droppedByCondition[key] || 0) + 1;
        }
        continue;
      }
      if (inc) {
        const name = inc[1];
        const included = !seen.has(name) && resolveInclude ? resolveInclude(name) : null;
        if (typeof included === 'string') {
          stats.includesResolved.push(name);
          expand(included, new Set([...seen, name]), [...frames]);
        } else {
          stats.includesUnresolved.push(name);
        }
        continue;
      }
      lines.push(raw);
    }
  };

  expand(String(text ?? ''), new Set(), []);
  return { lines, stats };
}

/**
 * Parse one filter list line.
 * @returns {object|null} tagged object, or null for comments / blank / ignorable lines.
 */
export function parseLine(rawLine) {
  const line = rawLine.trim();
  if (!line) return null;
  if (line.startsWith('!')) return null; // comment
  if (line.startsWith('[') && /\[Adblock/i.test(line)) return null; // header
  if (line.startsWith('#') && !line.startsWith('##') && !line.startsWith('#@') && !line.startsWith('#?') && !line.startsWith('#$') && !line.startsWith('#%')) {
    return null; // hosts-file style comment or stray
  }

  const sep = findCosmeticSeparator(line);
  if (sep) return parseCosmetic(line, sep);
  return parseNetwork(line);
}

export { ALL_RESOURCE_TYPES, RESOURCE_TYPE_MAP };
