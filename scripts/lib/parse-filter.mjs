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
          // matches all resource types — leave resourceTypes empty (DNR default = all)
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

/**
 * Extract hostname(s) from a network pattern for @@…$generichide / elemhide / specifichide.
 * Entity-domain patterns (||pahe.*^ or ||www.google.* /path) must stay as label.*
 * so runtime hostMatchesDomain can match real hosts.
 *
 * Trailing-dot hostname prefixes (`||stream4free.` / `||asd.`) are EasyList's
 * "hostname starts with label." form — NOT a bare label. Stripping to `stream4free`
 * / `asd` makes suffix matching miss `stream4free.tv` and wrongly match `evil.asd`.
 * Map them to `label.*` so entity matching covers the intended sites.
 */
export function hostsFromPattern(pattern, isRegex) {
  if (!pattern || isRegex) return [];
  // ||example.* or ||www.google.*/path — capture before `.*` (optional leading www.).
  const entity = /^\|\|(?:www\.)?([a-z0-9-]+)\.\*/i.exec(pattern);
  if (entity) return [`${entity[1].toLowerCase()}.*`];
  // ||stream4free. or ||asd.^ — single-label + trailing dot (hostname prefix).
  const prefix = /^\|\|(?:www\.)?([a-z0-9-]+)\.(?=$|\^|\/|\*)/i.exec(pattern);
  if (prefix) return [`${prefix[1].toLowerCase()}.*`];
  // ||example.com^ or ||example.com/path or |https://example.com^
  const m =
    /^\|\|([^^*/]+)/.exec(pattern) ||
    /^\|https?:\/\/([^^*/]+)/i.exec(pattern) ||
    /^([a-z0-9.-]+\.[a-z]{2,})/i.exec(pattern);
  if (!m) return [];
  return [m[1].toLowerCase().replace(/\.$/, '')];
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
