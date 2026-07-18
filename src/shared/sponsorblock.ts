// Shared SponsorBlock constants / types (content script + service worker).

/** Categories we auto-skip (SponsorBlock defaults minus filler / highlight / chapter). */
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

export interface SponsorSegment {
  category: string;
  actionType: string;
  /** [startSec, endSec] */
  segment: [number, number];
  UUID?: string;
}
