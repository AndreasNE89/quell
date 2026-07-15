// Parser for Adblock Plus / EasyList / uBlock Origin filter syntax.
//
// A filter list is a newline-delimited text file. Each line is one of:
//   - a comment            (starts with `!` or `[Adblock ...]`)
//   - a network rule       (`||ads.example^$script,third-party`)
//   - a network exception  (`@@||good.example^`)
//   - a cosmetic rule      (`example.com##.ad`, `#@#`, `#?#`, `#$#`, `##+js(...)`)
//
// We parse into a small tagged union. Conversion to DNR / cosmetic data happens later.
// Anything we can't represent is returned with `unsupported` populated so the compiler
// can count and report coverage instead of silently dropping rules.

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
  const name = (parts.shift() || '').trim();
  if (!name) return null;
  return { name, args: parts.map((p) => p.trim()) };
}

/** Split scriptlet args on commas, honoring backslash-escaped commas. */
function splitArgs(s) {
  const out = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\' && i + 1 < s.length) {
      cur += s[i + 1];
      i++;
      continue;
    }
    if (ch === ',') {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
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
        const parts = splitArgs(m[1]).map((p) => p.trim().replace(/^['"]|['"]$/g, ''));
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

  const isException = sep.kind === 'unhide';
  const procedural = !!sep.procedural || /:-abp-|:has\(|:has-text\(|:matches-css|:xpath\(|:upward\(|:not\(:has|:min-text-length/.test(body);

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
    for (const tokenRaw of optionStr.split(',')) {
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
          // matches all resource types — leave resourceTypes empty (DNR default = all)
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
        case 'ghide':
          cosmeticException = 'generichide';
          break;
        case 'elemhide':
        case 'ehide':
          cosmeticException = 'elemhide';
          break;
        case 'specifichide':
        case 'shide':
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

function findOptionsDollar(text) {
  // Full regex filters are `/pattern/` optionally followed by `$options`. Filter
  // options never contain `/`, so for a full regex the closing delimiter is simply
  // the LAST `/` in the string — options (if any) begin with the `$` right after it.
  // This preserves a `$` end-anchor *inside* the regex (e.g. `/ads$/`, `/ad/x$/`).
  //
  // Path-anchored patterns also start with `/` and often contain a second `/`
  // (e.g. `/ad/image/*$image`). Those are NOT full regexes: only treat as regex when
  // the last `/` is the final character, or is immediately followed by `$options`.
  // Otherwise fall through to the first-unescaped-`$` scan.
  const isFullRegexCandidate = text.length > 1 && text.startsWith('/') && text.lastIndexOf('/') > 0;
  if (isFullRegexCandidate) {
    const close = text.lastIndexOf('/');
    if (close + 1 === text.length) return -1; // `/pattern/` with no options
    if (text[close + 1] === '$') return close + 1; // `/pattern/$options`
    // else: path-like `/foo/bar*$opts` — fall through
  }
  // Non-regex (or path-anchored): the first unescaped `$` introduces options.
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\') {
      i++;
      continue;
    }
    if (text[i] === '$') return i;
  }
  return -1;
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
