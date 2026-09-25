// What the popup may offer on the active tab, and why not when it may not.
//
// Kept apart from popup.ts (which touches the DOM at module scope) so the decisions can be unit
// tested. Every "no" here is one the service worker would otherwise give silently: a control
// that is offered and then quietly does nothing, followed by "Reload the page to apply this",
// is how go.dev, lg.com and intranet hosts shipped.

import type { PopupData, SiteFixLevel } from '../shared/types.js';
import { isValidMatchPatternHost, normalizeHostname } from '../shared/hostname.js';
import { isExtensionRestrictedHostname } from '../shared/dark-mode.js';
import { fixDisablesCosmetics } from '../shared/site-fix.js';
import { isYoutubeHost } from '../content/youtube-ui.js';

/** `none`: chrome://, about:, file:, PDF viewer. `restricted`: Chrome bars extensions (Web Store). */
export type PageKind = 'web' | 'none' | 'restricted';

/** Why the element picker is not offered; null when it is. */
export type PickBlock = 'page' | 'host' | 'paused' | 'allowlisted' | 'fix' | null;

export interface SiteState {
  page: PageKind;
  /** Network blocking applies to this tab. */
  filtering: boolean;
  /** The site switch and the repair ladder can change something here. */
  switchable: boolean;
  /** The worker will compose a breakage report naming this host. */
  reportable: boolean;
  pick: PickBlock;
  youtube: boolean;
  /** A YouTube page where the allowlist switches the YouTube features off too. */
  youtubeOffHere: boolean;
}

export function pageKind(hostname: string | null | undefined): PageKind {
  if (!hostname) return 'none';
  // Chrome keeps extensions off the Web Store entirely — no content script, no DNR — so the
  // switch, the ladder and the picker there are controls with nothing behind them.
  if (isExtensionRestrictedHostname(hostname)) return 'restricted';
  return 'web';
}

export function siteState(data: PopupData): SiteState {
  const page = pageKind(data.hostname);
  const host = data.hostname ? normalizeHostname(data.hostname) : '';
  const web = page === 'web';
  const youtube = web && isYoutubeHost(host);
  return {
    page,
    filtering: web && !data.paused && !data.allowlisted,
    // The worker's own test (site-rules.ts), not a copy of it: the popup used to gate on a
    // looser one and offered a switch on lg.com that the worker then ignored.
    switchable: web && data.siteActionable,
    // The worker's gate for report:breakage — looser than the switch, so a user on a host the
    // switch cannot hold can still tell the developer.
    reportable: web && isValidMatchPatternHost(host),
    pick: pickBlock(page, host, data.paused, data.allowlisted, data.siteFix),
    youtube,
    youtubeOffHere: youtube && data.allowlisted,
  };
}

/**
 * The picker saves `host##selector` and element hiding applies it. A pick is therefore only
 * worth offering where both happen: the custom-filter parser needs a host a filter can name
 * (single-label intranet names included, as the worker's picker:start and the picker agree), and
 * pause, the allowlist and either repair rung all switch element hiding off — the element
 * would vanish, the rule would save, and it would be back on the next load.
 */
function pickBlock(
  page: PageKind,
  host: string,
  paused: boolean,
  allowlisted: boolean,
  fix: SiteFixLevel | null,
): PickBlock {
  if (page !== 'web') return 'page';
  if (!isValidMatchPatternHost(host)) return 'host';
  if (paused) return 'paused';
  if (allowlisted) return 'allowlisted';
  if (fixDisablesCosmetics(fix)) return 'fix';
  return null;
}

/** The fix comes from a parent's entry rather than this host's own. */
export function inheritedFixHost(data: PopupData): string | null {
  if (!data.siteFix || !data.hostname || !data.siteFixHost) return null;
  const own = normalizeHostname(data.hostname);
  const from = normalizeHostname(data.siteFixHost);
  return from && from !== own ? from : null;
}

/**
 * Did a switch/ladder answer land where the user asked? The worker answers with the site's
 * state either way, so an unchanged state is the only sign a request was refused.
 */
export function toggleLanded(data: PopupData, wantedBlocking: boolean): boolean {
  return data.allowlisted === !wantedBlocking;
}

export function fixLanded(data: PopupData, wanted: SiteFixLevel | null): boolean {
  // A parent's stronger fix can outrank the one asked for (resolveSiteFix takes the most
  // permissive), so "at least as far down the ladder" is the success test for a step.
  if (wanted == null) return data.siteFix == null;
  if (wanted === 'cosmetics') return data.siteFix === 'cosmetics' || data.siteFix === 'injection';
  return data.siteFix === 'injection';
}
