// Popup controller: shows the active tab's status and wires the per-site + master toggles.

import type {
  DarkModeData,
  Message,
  PageReport,
  PopupData,
  SiteFixLevel,
} from '../shared/types.js';
import { nextSiteFix } from '../shared/site-fix.js';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const el = {
  statusDot: $('statusDot'),
  host: $('host'),
  siteSub: $('siteSub'),
  siteToggle: $<HTMLInputElement>('siteToggle'),
  siteToggleLabel: $('siteToggleLabel'),
  pauseToggle: $<HTMLInputElement>('pauseToggle'),
  ytSponsoredToggle: $<HTMLInputElement>('ytSponsoredToggle'),
  ytShortsToggle: $<HTMLInputElement>('ytShortsToggle'),
  ytSponsorBlockToggle: $<HTMLInputElement>('ytSponsorBlockToggle'),
  tabBlocked: $('tabBlocked'),
  totalBlocked: $('totalBlocked'),
  stats: $('stats'),
  ruleCount: $('ruleCount'),
  reloadNote: $('reloadNote'),
  reloadBtn: $<HTMLButtonElement>('reloadBtn'),
  report: $('report'),
  reportTitle: $('reportTitle'),
  reportToggle: $<HTMLButtonElement>('reportToggle'),
  reportSummary: $('reportSummary'),
  reportList: $('reportList'),
  reportFoot: $('reportFoot'),
  pickBtn: $<HTMLButtonElement>('pickBtn'),
  ytSummary: $('ytSummary'),
  darkSummary: $('darkSummary'),
  pickHint: $('pickHint'),
  repair: $('repair'),
  repairOpen: $<HTMLButtonElement>('repairOpen'),
  repairPanel: $('repairPanel'),
  repairState: $('repairState'),
  repairNext: $<HTMLButtonElement>('repairNext'),
  repairReset: $<HTMLButtonElement>('repairReset'),
  repairHint: $('repairHint'),
  optionsBtn: $('optionsBtn'),
  openOptions: $('openOptions'),
  darkModeRow: $('darkModeRow'),
  darkModeToggle: $<HTMLInputElement>('darkModeToggle'),
  darkModeLabel: $('darkModeLabel'),
  darkSiteRow: $('darkSiteRow'),
  darkSiteToggle: $<HTMLInputElement>('darkSiteToggle'),
  darkSiteLabel: $('darkSiteLabel'),
  darkSiteHost: $('darkSiteHost'),
  darkResetBtn: $<HTMLButtonElement>('darkResetBtn'),
  darkUpsell: $('darkUpsell'),
  darkPrice: $('darkPrice'),
  darkBuyBtn: $<HTMLButtonElement>('darkBuyBtn'),
  darkRestoreBtn: $<HTMLButtonElement>('darkRestoreBtn'),
  darkDevUnlockBtn: $<HTMLButtonElement>('darkDevUnlockBtn'),
  darkHint: $('darkHint'),
};

function send(msg: Message): Promise<unknown> {
  return chrome.runtime.sendMessage(msg);
}

function render(data: PopupData): void {
  const blockingHere = !data.paused && !data.allowlisted && !!data.hostname;
  el.host.textContent = data.hostname ?? 'This page';
  // No hostname means chrome://, about:, file:, the PDF viewer, … — nothing is being blocked
  // there and the toggle does nothing, so say that rather than claiming blocking is on.
  el.siteSub.textContent = !data.hostname
    ? 'StampStack does not run on this page'
    : data.paused
      ? 'StampStack is paused'
      : data.allowlisted
        ? 'Blocking is off here'
        : 'Blocking on this site';

  el.siteToggle.checked = blockingHere;
  el.siteToggle.disabled = data.paused || !data.hostname;
  if (!data.hostname) el.siteToggleLabel.textContent = 'Not available on this page';
  else if (data.coveredBy)
    el.siteToggleLabel.textContent = `Blocking off (via ${data.coveredBy})`;
  else if (data.allowlisted) el.siteToggleLabel.textContent = 'Blocking off (allowlisted)';
  else if (data.paused) el.siteToggleLabel.textContent = 'Paused globally';
  else el.siteToggleLabel.textContent = 'Block on this site';

  el.pauseToggle.checked = data.paused;
  el.ytSponsoredToggle.checked = data.youtubeBlockSponsored;
  el.ytShortsToggle.checked = data.youtubeBlockShorts;
  el.ytSponsorBlockToggle.checked = data.youtubeSponsorBlock;
  el.ytSponsoredToggle.disabled = data.paused;
  el.ytShortsToggle.disabled = data.paused;
  el.ytSponsorBlockToggle.disabled = data.paused;

  // Chrome only exposes per-request match events to unpacked/dev builds, so in a store build
  // both counters can only ever read "—" and "n/a". Show what we do know instead: how many
  // rules are actually live.
  el.stats.hidden = !data.statsReliable;
  el.ruleCount.hidden = data.statsReliable;
  if (data.statsReliable) {
    el.tabBlocked.textContent = String(data.tabBlocked);
    el.totalBlocked.textContent = data.blockedTotal.toLocaleString();
  } else {
    el.ruleCount.textContent = data.paused
      ? 'Paused — no rules active'
      : data.degraded
        ? `${data.activeRuleCount.toLocaleString()} rules active — a list could not load, see Settings`
        : `${data.activeRuleCount.toLocaleString()} blocking rules active`;
    el.ruleCount.classList.toggle('warn', !data.paused && data.degraded);
  }

  // Collapsed groups must not hide state: the summary carries it.
  const ytOn = [data.youtubeBlockSponsored, data.youtubeBlockShorts, data.youtubeSponsorBlock].filter(
    Boolean,
  ).length;
  el.ytSummary.textContent = data.paused ? 'paused' : `${ytOn} of 3 on`;

  el.pickBtn.disabled = !data.hostname;
  renderRepair(data);

  el.statusDot.classList.toggle('off', !blockingHere);
  document.body.classList.toggle('paused', data.paused);
  document.body.classList.toggle('allowlisted', data.allowlisted);
}

/**
 * The repair ladder. Each press turns off one more layer instead of jumping straight to a
 * full allowlist, so a user fixing a collapsed menu keeps their ad blocking.
 */
function renderRepair(data: PopupData): void {
  // Nothing to repair on a page we do not run on, or when already fully off. The trigger lives
  // in the actions row now, so disable it rather than leaving a button that does nothing.
  const unavailable = !data.hostname || data.paused || data.allowlisted;
  el.repairOpen.disabled = unavailable;
  el.repair.hidden = unavailable;
  if (unavailable) {
    el.repairPanel.hidden = true;
    el.repairOpen.setAttribute('aria-expanded', 'false');
    return;
  }

  const level = data.siteFix;
  const next = nextSiteFix(level);

  el.repairState.textContent =
    level === 'injection'
      ? 'Element hiding and scriptlets are off here. Ads are still blocked.'
      : level === 'cosmetics'
        ? 'Element hiding is off here. Ads and scriptlets are still active.'
        : 'Everything is on for this site.';

  if (next === 'cosmetics') {
    el.repairNext.textContent = 'Stop hiding elements here';
    el.repairHint.textContent = 'Fixes collapsed layouts, blank gaps and stuck menus.';
  } else if (next === 'injection') {
    el.repairNext.textContent = 'Also stop running scriptlets here';
    el.repairHint.textContent = 'Fixes players and logins that break on anti-adblock patches.';
  } else {
    el.repairNext.textContent = 'Turn blocking off for this site';
    el.repairHint.textContent = 'Last resort — this site gets its ads and trackers back.';
  }
  el.repairNext.dataset['level'] = next ?? 'allowlist';
  el.repairReset.hidden = level == null;
}

function renderDarkMode(data: DarkModeData): void {
  darkCurrent = data;
  el.darkPrice.textContent = data.license.priceLabel;
  const host = data.hostname;

  // Summary for the collapsed group. Unpaid shows the price so the group is still a hook.
  el.darkSummary.textContent = !data.paid
    ? data.license.priceLabel
    : data.restricted
      ? 'not available here'
      : data.apply
        ? 'on here'
        : data.enabled
          ? 'off here'
          : 'off';

  if (!data.paid) {
    // Locked: only the upsell + config hint. Hide the toggles.
    el.darkSiteRow.hidden = true;
    el.darkResetBtn.hidden = true;
    el.darkModeRow.hidden = true;
    el.darkUpsell.hidden = false;
    el.darkBuyBtn.disabled = !data.license.configured && !data.license.unpacked;
    el.darkRestoreBtn.hidden = false;
    el.darkRestoreBtn.disabled = !data.license.configured;
    el.darkDevUnlockBtn.hidden = !data.license.unpacked;
    if (data.license.unpacked) {
      el.darkHint.hidden = false;
      el.darkHint.textContent = data.license.configured
        ? 'Unpacked dev: use Dev unlock to test dark mode without paying.'
        : 'ExtensionPay not configured — use Dev unlock here, or Options.';
    } else if (!data.license.configured) {
      el.darkHint.hidden = false;
      el.darkHint.textContent = 'Purchases unavailable in this build — update StampStack from the store.';
    } else {
      // Production unpaid: nudge restore so reinstalls convert without support tickets.
      el.darkHint.hidden = false;
      el.darkHint.textContent =
        'Already paid? Restore purchase with the email from your receipt. Ad blocking stays free.';
    }
    return;
  }

  // Paid: global (all-sites) default toggle is always shown.
  el.darkUpsell.hidden = true;
  el.darkRestoreBtn.hidden = true;
  el.darkDevUnlockBtn.hidden = true;
  el.darkModeRow.hidden = false;
  el.darkModeToggle.checked = data.enabled;
  el.darkModeToggle.disabled = false;

  if (data.restricted) {
    el.darkSiteRow.hidden = true;
    el.darkResetBtn.hidden = true;
    el.darkHint.hidden = false;
    el.darkHint.textContent =
      'Not available on Chrome Web Store pages — Chrome blocks extensions from modifying these.';
    return;
  }
  el.darkHint.hidden = true;

  // Primary quick toggle for the current page.
  const hasHost = !!host;
  el.darkSiteRow.hidden = !hasHost;
  if (hasHost) {
    el.darkSiteToggle.checked = data.apply;
    el.darkSiteToggle.disabled = false;
    el.darkSiteLabel.textContent = data.apply ? 'Dark mode is on here' : 'Dark mode is off here';
    el.darkSiteHost.textContent = host!;
  }
  // Show the reset link only when this page overrides the global default.
  el.darkResetBtn.hidden = !(hasHost && data.override != null);
}

/**
 * Page report.
 *
 * Every number here is something we watched happen, not something we inferred. The wording
 * matters: "reached out to" is what the page did; "StampStack has rules for N" is what we can
 * prove from the shipped rulesets. Neither claims a specific request was blocked, because a
 * store build genuinely cannot know that.
 */
function renderReport(report: PageReport): void {
  if (!report.available) {
    // Pause / allowlist already say so elsewhere; only explain the non-obvious cases.
    if (report.reason === 'no-content-script') {
      el.report.hidden = false;
      el.reportTitle.textContent = 'On this page';
      el.reportSummary.textContent = 'Reload the page to see what it connects to.';
      el.reportToggle.hidden = true;
      el.reportList.hidden = true;
      el.reportFoot.hidden = true;
      return;
    }
    el.report.hidden = true;
    return;
  }

  el.report.hidden = false;
  el.reportToggle.hidden = report.trackers.length === 0;

  const named = report.trackers.length;
  const withRules = report.trackers.filter((t) => t.blocked).length;
  const parts: string[] = [];

  if (named) {
    parts.push(
      `Reached out to ${named} known ${named === 1 ? 'tracker' : 'trackers'}` +
        (withRules ? ` — StampStack has rules for ${withRules}.` : '.'),
    );
  } else if (report.unnamedThirdParty) {
    parts.push('No known trackers recognized here.');
  } else {
    parts.push('No third-party connections seen.');
  }
  if (report.hiddenElements) {
    parts.push(`${report.hiddenElements} ad ${report.hiddenElements === 1 ? 'slot' : 'slots'} hidden.`);
  }
  el.reportSummary.textContent = parts.join(' ');

  el.reportList.textContent = '';
  for (const t of report.trackers) {
    const li = document.createElement('li');
    li.className = t.blocked ? 'report-item blocked' : 'report-item seen';
    const name = document.createElement('span');
    name.className = 'report-name';
    name.textContent = t.label;
    const state = document.createElement('span');
    state.className = 'report-state';
    // "not in our lists" is the honest phrasing: we know we have no rule, we do not know
    // whether the request itself succeeded.
    state.textContent = t.blocked ? 'blocked' : 'not in our lists';
    li.append(name, state);
    el.reportList.append(li);
  }

  const foot: string[] = [];
  if (report.unnamedThirdParty) {
    foot.push(
      `${report.unnamedThirdParty} other third-party ${report.unnamedThirdParty === 1 ? 'host' : 'hosts'} not recognized by name`,
    );
  }
  if (report.truncated) foot.push('list truncated');
  el.reportFoot.textContent = foot.join(' · ');
  el.reportFoot.hidden = foot.length === 0 || el.reportList.hidden;
}

el.reportToggle.addEventListener('click', () => {
  const show = el.reportList.hidden;
  el.reportList.hidden = !show;
  el.reportFoot.hidden = !show || !el.reportFoot.textContent;
  el.reportToggle.textContent = show ? 'Hide' : 'Details';
});

let current: PopupData | null = null;
let darkCurrent: DarkModeData | null = null;

async function refresh(): Promise<void> {
  try {
    const data = (await send({ type: 'popup:get' })) as PopupData | null;
    if (!data) return;
    current = data;
    render(data);
    const dark = (await send({
      type: 'darkmode:get',
      hostname: data.hostname,
    })) as DarkModeData | null;
    if (dark) renderDarkMode(dark);

    // Last: it round-trips to the content script, so never let it delay the main UI.
    const report = (await send({ type: 'report:get' })) as PageReport | null;
    if (report) renderReport(report);
  } catch (e) {
    console.warn('[StampStack] popup refresh failed', e);
  }
}

// Allowlist and pause changes only affect requests made from now on: the page in front of the
// user keeps whatever was already blocked (or already loaded). Prompt rather than reloading
// automatically — a silent reload would discard half-written form input.
function promptReload(): void {
  el.reloadNote.hidden = false;
}

el.reloadBtn.addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id != null) await chrome.tabs.reload(tab.id);
  window.close();
});

// The picker needs the page in front of the user, so the popup must close for it to be usable.
el.pickBtn.addEventListener('click', async () => {
  const r = (await send({ type: 'picker:start' })) as { ok: boolean; error?: string } | null;
  if (!r?.ok) {
    el.pickHint.hidden = false;
    el.pickHint.textContent = r?.error ?? 'The picker could not start here.';
    return;
  }
  window.close();
});

el.repairOpen.addEventListener('click', () => {
  const open = el.repairPanel.hidden;
  el.repairPanel.hidden = !open;
  el.repairOpen.setAttribute('aria-expanded', String(open));
  el.repairOpen.classList.toggle('active', open);
});

async function setSiteFix(level: SiteFixLevel | null): Promise<void> {
  if (!current?.hostname) return;
  const data = (await send({
    type: 'sitefix:set',
    hostname: current.hostname,
    level,
  })) as PopupData;
  current = data;
  render(data);
  el.repairPanel.hidden = false;
  el.repairOpen.setAttribute('aria-expanded', 'true');
  el.repairOpen.classList.add('active');
  promptReload();
}

el.repairNext.addEventListener('click', async () => {
  const step = el.repairNext.dataset['level'];
  // The bottom rung is the existing allowlist, not another fix level.
  if (step === 'allowlist') {
    if (!current?.hostname) return;
    const data = (await send({
      type: 'popup:toggleSite',
      hostname: current.hostname,
      enabled: false,
    })) as PopupData;
    current = data;
    render(data);
    promptReload();
    return;
  }
  await setSiteFix(step === 'injection' ? 'injection' : 'cosmetics');
});

el.repairReset.addEventListener('click', () => {
  void setSiteFix(null);
});

el.siteToggle.addEventListener('change', async () => {
  if (!current?.hostname) return;
  const data = (await send({
    type: 'popup:toggleSite',
    hostname: current.hostname,
    enabled: el.siteToggle.checked,
  })) as PopupData;
  current = data;
  render(data);
  promptReload();
});

el.pauseToggle.addEventListener('change', async () => {
  const data = (await send({ type: 'popup:setPaused', paused: el.pauseToggle.checked })) as PopupData;
  current = data;
  render(data);
  promptReload();
});

async function saveYoutubeOptions(): Promise<void> {
  const data = (await send({
    type: 'popup:setYoutubeOptions',
    youtubeBlockSponsored: el.ytSponsoredToggle.checked,
    youtubeBlockShorts: el.ytShortsToggle.checked,
    youtubeSponsorBlock: el.ytSponsorBlockToggle.checked,
  })) as PopupData;
  current = data;
  render(data);
}

el.ytSponsoredToggle.addEventListener('change', () => {
  void saveYoutubeOptions();
});
el.ytShortsToggle.addEventListener('change', () => {
  void saveYoutubeOptions();
});
el.ytSponsorBlockToggle.addEventListener('change', () => {
  void saveYoutubeOptions();
});

el.darkModeToggle.addEventListener('change', async () => {
  if (!darkCurrent?.paid) {
    el.darkModeToggle.checked = false;
    el.darkUpsell.hidden = false;
    return;
  }
  const data = (await send({
    type: 'darkmode:setEnabled',
    enabled: el.darkModeToggle.checked,
  })) as DarkModeData;
  renderDarkMode(data);
});

el.darkBuyBtn.addEventListener('click', async () => {
  el.darkBuyBtn.disabled = true;
  const r = (await send({ type: 'license:openCheckout' })) as { ok: boolean; error?: string };
  if (!r?.ok) {
    el.darkHint.hidden = false;
    el.darkHint.textContent =
      r?.error ??
      (darkCurrent?.license.unpacked
        ? 'Checkout unavailable — use Dev unlock or set ExtensionPay id in Options.'
        : 'Checkout unavailable. Try Restore purchase, or open Options.');
  }
  el.darkBuyBtn.disabled = false;
  void refresh();
});

el.darkRestoreBtn.addEventListener('click', async () => {
  el.darkRestoreBtn.disabled = true;
  const r = (await send({ type: 'license:openRestore' })) as { ok: boolean; error?: string };
  if (!r?.ok) {
    el.darkHint.hidden = false;
    el.darkHint.textContent =
      r?.error ?? 'Restore unavailable. Open Options → Restore purchase.';
  }
  el.darkRestoreBtn.disabled = !darkCurrent?.license.configured;
  void refresh();
});

el.darkDevUnlockBtn.addEventListener('click', async () => {
  el.darkDevUnlockBtn.disabled = true;
  const r = (await send({ type: 'license:devUnlock' })) as {
    ok: boolean;
    error?: string;
    darkMode?: DarkModeData;
  };
  el.darkDevUnlockBtn.disabled = false;
  if (!r?.ok) {
    el.darkHint.hidden = false;
    el.darkHint.textContent = r?.error ?? 'Dev unlock failed';
    return;
  }
  if (r.darkMode) renderDarkMode(r.darkMode);
  else void refresh();
});

// Quick per-page toggle: pin an explicit on/off override for this site. The "Reset to
// global default" link clears it. Explicit (rather than clearing when it matches global)
// so a Force-on sticks on sites the smart detector would otherwise auto-skip as already-dark.
el.darkSiteToggle.addEventListener('change', async () => {
  if (!darkCurrent?.hostname || !darkCurrent.paid) return;
  const override: 'on' | 'off' = el.darkSiteToggle.checked ? 'on' : 'off';
  const data = (await send({
    type: 'darkmode:setSiteOverride',
    hostname: darkCurrent.hostname,
    override,
  })) as DarkModeData;
  renderDarkMode(data);
});

el.darkResetBtn.addEventListener('click', async () => {
  if (!darkCurrent?.hostname || !darkCurrent.paid) return;
  const data = (await send({
    type: 'darkmode:setSiteOverride',
    hostname: darkCurrent.hostname,
    override: null,
  })) as DarkModeData;
  renderDarkMode(data);
});

function openOptions(): void {
  chrome.runtime.openOptionsPage();
}
el.optionsBtn.addEventListener('click', openOptions);
el.openOptions.addEventListener('click', openOptions);

void refresh();
