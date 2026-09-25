// How old the compiled filter lists are, and whether that is worth saying out loud.
//
// The lists are compiled into the package at build time, so they only move when a new version
// ships. That makes staleness invisible from the inside: nothing degrades loudly, blocking
// just quietly stops covering what upstream added. The extension already refuses to overstate
// its rule count when Chrome drops a ruleset; this is the same honesty applied to time.

/** Past this many days the lists are behind the project's own biweekly cadence. */
export const AGING_DAYS = 14;
/** Past this, a release has been missed and coverage is measurably behind upstream. */
export const STALE_DAYS = 30;

const DAY_MS = 86_400_000;

export type ListFreshness = 'unknown' | 'fresh' | 'aging' | 'stale';

export interface ListAge {
  level: ListFreshness;
  /** Whole days since the lists were fetched; null when there is no date to work from. */
  days: number | null;
  /** e.g. "24 Jul 2026" — empty when unknown. */
  date: string;
  /** A complete sentence, ready to render. */
  text: string;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Fixed format rather than toLocaleDateString, so it does not vary with the host's ICU data. */
function formatDate(d: Date): string {
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/**
 * The fetch date for the translated Options page, in the page's language (`uiLanguage()`).
 *
 * `ListAge.date` stays in the fixed English format because it also goes into the breakage
 * email, which the developer reads; dropped into a Chinese sentence it read "（7 Sep 2026）".
 * UTC like `date`, so both name the same day. Empty when there is no date.
 */
export function localizedListDate(generatedAt: string | null | undefined, locale: string): string {
  const ms = generatedAt ? Date.parse(generatedAt) : NaN;
  if (!Number.isFinite(ms)) return '';
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' }).format(ms);
  } catch {
    // A tag Intl rejects must not blank the line; the English form is still a date.
    return formatDate(new Date(ms));
  }
}

export function listAge(generatedAt: string | null | undefined, now: number): ListAge {
  const ms = generatedAt ? Date.parse(generatedAt) : NaN;
  if (!Number.isFinite(ms)) {
    return {
      level: 'unknown',
      days: null,
      date: '',
      text: 'Filter list date unavailable for this build.',
    };
  }

  // A clock behind the build machine's would otherwise report a negative age.
  const days = Math.max(0, Math.floor((now - ms) / DAY_MS));
  const date = formatDate(new Date(ms));
  const when = days === 0 ? 'today' : `${plural(days, 'day')} ago`;
  const level: ListFreshness = days >= STALE_DAYS ? 'stale' : days >= AGING_DAYS ? 'aging' : 'fresh';

  // Nothing here is user-fixable — Chrome updates extensions on its own — so the wording
  // reports the fact and says what will resolve it, rather than implying an action.
  const tail =
    level === 'stale'
      ? ' — behind upstream. A new StampStack version will refresh them.'
      : level === 'aging'
        ? ' — a StampStack update will refresh them soon.'
        : '';

  // "Refreshed" is the lock stamp (when upstream bytes last moved), not the compile clock.
  return { level, days, date, text: `Filter lists refreshed ${when} (${date})${tail}` };
}
