// Validation for settings backups before they reach storage.
//
// settings.ts's applyImportedSettings keeps what the file leaves out, but a field that is
// present with the wrong shape went through mergeSettings, which answers any wrong type with
// the default: `"allowlist": "example.com"` erased the whole allowlist and the import still
// said ok. Keys were not checked either, so an imported `Example.com` or a pasted URL became
// a row that matched nothing and that the popup could not clear. This file decides field by
// field: a well-formed field is normalized and applied, a malformed one is left as it was on
// this install and named in the answer.

import type { Settings, SiteFixLevel, DarkModeSiteOverride } from '../shared/types.js';
import { siteRuleKey } from '../shared/site-rules.js';
import { normalizeHostname, isValidMatchPatternHost } from '../shared/hostname.js';

/**
 * The most custom-filter text stored. The editor and parsing stay responsive well past it; what
 * it bounds is a pasted or imported file wedging both.
 */
export const CUSTOM_FILTERS_MAX_CHARS = 100_000;

/**
 * `text` cut to at most `max` characters at a line boundary. Cutting mid-line stored the head
 * of a rule as a different, broader rule (`example.com##.ad-slot-left` became `…##.ad-sl`).
 */
export function capFilterText(
  text: string,
  max: number = CUSTOM_FILTERS_MAX_CHARS,
): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  const head = text.slice(0, max);
  const cut = head.lastIndexOf('\n');
  return { text: cut < 0 ? '' : head.slice(0, cut + 1), truncated: true };
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

const BOOLEAN_KEYS = [
  'paused',
  'youtubeBlockSponsored',
  'youtubeBlockShorts',
  'youtubeSponsorBlock',
  'darkModeEnabled',
] as const;

/** A dark-mode override key: the host a tab would report, www-folded like resolveDarkModeForHost. */
function overrideKey(raw: string): string {
  const h = normalizeHostname(raw);
  return isValidMatchPatternHost(h) ? h : '';
}

export interface SanitizedImport {
  /** Only the fields that were present and well formed, normalized. */
  settings: Partial<Settings>;
  /** Fields present in the file with the wrong type; the install keeps its own value. */
  ignored: string[];
  /** Custom filters were longer than CUSTOM_FILTERS_MAX_CHARS and were cut at a line. */
  truncated: boolean;
}

/**
 * Validate the `settings` object of a backup. Entries inside a well-formed field that cannot be
 * used (a site key that is not a host, a level or value that is not one of ours) are dropped
 * rather than failing the field: the rest of the user's allowlist is still worth restoring.
 */
export function sanitizeImportedSettings(raw: unknown): SanitizedImport {
  const out: Partial<Settings> = {};
  const ignored: string[] = [];
  let truncated = false;
  if (!isPlainObject(raw)) return { settings: out, ignored, truncated };
  const has = (k: string): boolean => Object.prototype.hasOwnProperty.call(raw, k);

  for (const key of BOOLEAN_KEYS) {
    if (!has(key)) continue;
    if (typeof raw[key] === 'boolean') out[key] = raw[key] as boolean;
    else ignored.push(key);
  }

  if (has('allowlist')) {
    const v = raw.allowlist;
    if (Array.isArray(v)) {
      const keys = v.map((h) => (typeof h === 'string' ? siteRuleKey(h) : '')).filter(Boolean);
      out.allowlist = [...new Set(keys)];
    } else ignored.push('allowlist');
  }

  if (has('siteFixes')) {
    const v = raw.siteFixes;
    if (isPlainObject(v)) {
      const fixes: Record<string, SiteFixLevel> = {};
      for (const [host, level] of Object.entries(v)) {
        const key = siteRuleKey(host);
        if (!key || (level !== 'cosmetics' && level !== 'injection')) continue;
        // Two spellings of one site (Example.com, www.example.com): the stronger fix wins, as
        // resolveSiteFix would decide between them.
        if (fixes[key] !== 'injection') fixes[key] = level;
      }
      out.siteFixes = fixes;
    } else ignored.push('siteFixes');
  }

  if (has('enabledLists')) {
    const v = raw.enabledLists;
    if (isPlainObject(v)) {
      const lists: Record<string, boolean> = {};
      for (const [id, on] of Object.entries(v)) {
        // `"false"` is truthy: taken as it was, it switched a list the user had off back on.
        if (id && typeof on === 'boolean') lists[id] = on;
      }
      out.enabledLists = lists;
    } else ignored.push('enabledLists');
  }

  if (has('darkModeSiteOverrides')) {
    const v = raw.darkModeSiteOverrides;
    if (isPlainObject(v)) {
      const overrides: Record<string, DarkModeSiteOverride> = {};
      for (const [host, value] of Object.entries(v)) {
        const key = overrideKey(host);
        if (key && (value === 'on' || value === 'off')) overrides[key] = value;
      }
      out.darkModeSiteOverrides = overrides;
    } else ignored.push('darkModeSiteOverrides');
  }

  if (has('sponsorBlockCategories')) {
    const v = raw.sponsorBlockCategories;
    if (isPlainObject(v)) {
      const cats: Record<string, boolean> = {};
      for (const [cat, on] of Object.entries(v)) if (cat && typeof on === 'boolean') cats[cat] = on;
      out.sponsorBlockCategories = cats;
    } else ignored.push('sponsorBlockCategories');
  }

  if (has('customFilters')) {
    const v = raw.customFilters;
    if (typeof v === 'string') {
      const capped = capFilterText(v);
      out.customFilters = capped.text;
      truncated = capped.truncated;
    } else ignored.push('customFilters');
  }

  return { settings: out, ignored, truncated };
}
