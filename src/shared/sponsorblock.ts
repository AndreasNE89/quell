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
  selfpromo: { label: 'Self-promotion', hint: 'Unpaid plugs for the creator’s own merch or Patreon.' },
  interaction: { label: 'Interaction reminder', hint: '“Like, comment and subscribe” asides.' },
  intro: { label: 'Intro / intermission', hint: 'Title cards and animated intros with no content.' },
  outro: { label: 'Outro / endcards', hint: 'Credits and endcards after the content ends.' },
  preview: { label: 'Preview / recap', hint: 'Recaps of this video, or of a previous one.' },
  music_offtopic: { label: 'Non-music section', hint: 'Non-music parts of a music video.' },
};

/**
 * Which categories to act on, given the user's settings.
 *
 * Absent or malformed settings fall back to every category, which is what shipped before this
 * was configurable — a stored blob from an older version must not silently reduce coverage.
 */
export function enabledSponsorCategories(
  prefs: Partial<Record<string, boolean>> | undefined,
): SponsorBlockCategory[] {
  if (!prefs || typeof prefs !== 'object') return [...SPONSORBLOCK_SKIP_CATEGORIES];
  const on = SPONSORBLOCK_SKIP_CATEGORIES.filter((c) => prefs[c] !== false);
  // Every category off means "skip nothing"; the caller shortcuts the request entirely rather
  // than asking the API for an empty category list (which would 400).
  return on;
}

export interface SponsorSegment {
  category: string;
  actionType: string;
  /** [startSec, endSec] */
  segment: [number, number];
  UUID?: string;
}
