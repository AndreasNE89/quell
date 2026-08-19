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

export interface SponsorSegment {
  category: string;
  actionType: string;
  /** [startSec, endSec] */
  segment: [number, number];
  UUID?: string;
}
