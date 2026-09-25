// Shared SponsorBlock constants / types (content script + service worker).

/** Categories we can auto-skip (SponsorBlock defaults minus filler / highlight / chapter). */
export const SPONSORBLOCK_SKIP_CATEGORIES = [
  'sponsor',
  'selfpromo',
  'interaction',
  'intro',
  'outro',
  'preview',
  'music_offtopic',
] as const;

export type SponsorBlockCategory = (typeof SPONSORBLOCK_SKIP_CATEGORIES)[number];

/** User-facing name and one-line description for each category, for the Options rows. */
export const SPONSORBLOCK_CATEGORY_INFO: Record<
  SponsorBlockCategory,
  { label: string; hint: string }
> = {
  sponsor: { label: 'Sponsor', hint: 'Paid promotion, paid referrals, direct advertising.' },
  selfpromo: { label: 'Self-promotion', hint: 'Unpaid plugs for the creator’s own merch or fan-funding page.' },
  interaction: { label: 'Interaction reminder', hint: '“Like, comment and subscribe” asides.' },
  intro: { label: 'Intro / intermission', hint: 'Title cards and animated intros with no content.' },
  outro: { label: 'Outro / endcards', hint: 'Credits and endcards after the content ends.' },
  preview: { label: 'Preview / recap', hint: 'Recaps of this video, or of a previous one.' },
  music_offtopic: { label: 'Non-music section', hint: 'Non-music parts of a music video.' },
};

/**
 * Whether a category is skipped when the user has never touched its toggle.
 *
 * Only `sponsor` — matching the official SponsorBlock extension, whose default is to
 * auto-skip sponsors and leave every other category opt-in. Shipping all seven on was the
 * root of "it skips at seemingly random times": interaction reminders, previews and non-music
 * sections are scattered mid-video, so a default-settings user got yanked around constantly
 * with no idea why. Skipping content someone did not ask to lose is the one place this
 * extension should under-reach.
 */
export const SPONSORBLOCK_DEFAULT_ON: Record<SponsorBlockCategory, boolean> = {
  sponsor: true,
  selfpromo: false,
  interaction: false,
  intro: false,
  outro: false,
  preview: false,
  music_offtopic: false,
};

/**
 * Which categories to act on, given the user's settings.
 *
 * An explicit choice always wins; an absent key falls back to the category's own default.
 * This deliberately changes behavior for older installs that never opened the category
 * settings: they drop from all seven to sponsor-only. That is the fix, not a regression —
 * "extremely aggressive, skips at seemingly random times" was reported against the old
 * all-on default. Anyone who explicitly enabled a category keeps it.
 */
export function enabledSponsorCategories(
  prefs: Partial<Record<string, boolean>> | undefined,
): SponsorBlockCategory[] {
  const p = prefs && typeof prefs === 'object' ? prefs : {};
  return SPONSORBLOCK_SKIP_CATEGORIES.filter((c) => p[c] ?? SPONSORBLOCK_DEFAULT_ON[c]);
}

/** Numeric compare of dotted versions ("2.2.0" < "2.2.1" < "2.10.0"). */
function versionBefore(version: string, than: string): boolean {
  const a = version.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const b = than.split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return d < 0;
  }
  return false;
}

/**
 * Category choices saved by 2.2.0 or earlier, rewritten so they keep meaning what they meant.
 *
 * Up to 2.2.0 a category was on unless explicitly false, and Options showed it on: someone who
 * wanted everything but sponsors switched Sponsor off and stored `{sponsor: false}`. Since 2.2.1
 * an absent key follows SPONSORBLOCK_DEFAULT_ON, which reads that blob as "skip nothing" while
 * the popup still says SponsorBlock is on. Here every category the old blob left implicit is
 * written as an explicit `true`.
 *
 * A blob 2.2.1 or later wrote looks exactly the same, so this may only run on the update that
 * leaves 2.2.0 or older (`previousVersion` from chrome.runtime.onInstalled). A blob with no
 * explicit key is left alone: those users never chose, and sponsor-only is the deliberate 2.2.1
 * default for them. Returns the prefs to store, or null when there is nothing to change.
 */
export function migrateLegacySponsorCategories(
  prefs: Partial<Record<string, boolean>> | undefined,
  previousVersion: string | undefined,
): Record<string, boolean> | null {
  if (!previousVersion || !versionBefore(previousVersion, '2.2.1')) return null;
  if (!prefs || typeof prefs !== 'object' || Array.isArray(prefs)) return null;
  const chosen = SPONSORBLOCK_SKIP_CATEGORIES.filter((c) => typeof prefs[c] === 'boolean');
  if (!chosen.length || chosen.length === SPONSORBLOCK_SKIP_CATEGORIES.length) return null;
  const next: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(prefs)) if (typeof v === 'boolean') next[k] = v;
  for (const c of SPONSORBLOCK_SKIP_CATEGORIES) if (typeof prefs[c] !== 'boolean') next[c] = true;
  return next;
}

/**
 * Longest segment worth acting on, as a share of the video. One covering most of a video is
 * bad data or vandalism, and skipping it jumps the viewer to the end. SponsorBlock marks
 * whole-video sponsorships with its own `full` action type, which is never requested.
 */
export const MAX_SEGMENT_SHARE = 0.8;

export interface SponsorSegment {
  category: string;
  actionType: string;
  /** [startSec, endSec] */
  segment: [number, number];
  UUID?: string;
}
