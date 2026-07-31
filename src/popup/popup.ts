// Popup controller: shows the active tab's status and wires the per-site + master toggles.

import type {
  DarkModeData,
  Message,
  PageReport,
  PopupData,
  SiteFixLevel,
} from '../shared/types.js';
import { nextSiteFix } from '../shared/site-fix.js';
import type { BreakageReport } from '../shared/breakage-report.js';
import { SUPPORT_EMAIL } from '../shared/constants.js';
import { isValidMatchPatternHost, normalizeHostname } from '../shared/hostname.js';
import { applyI18n, msg } from '../shared/i18n.js';

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
  repairLadder: $('repairLadder'),
  reportBreakage: $<HTMLButtonElement>('reportBreakage'),
  reportBreakageNote: $('reportBreakageNote'),
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

// Named `payload`, not `msg`: `msg` is the i18n lookup at module scope and shadowing it here
// would make a translated string silently resolve to a Message object.
function send(payload: Message): Promise<unknown> {
  return chrome.runtime.sendMessage(payload);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Cold service-worker wakes can drop the first sendMessage; match the content-script retry. */
async function sendWithRetry<T>(payload: Message, attempts = 5): Promise<T | null> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const resp = (await send(payload)) as T | null | undefined;
      if (resp != null) return resp;
    } catch (e) {
      lastErr = e;
    }
    await sleep(50 * (i + 1));
  }
  if (lastErr) console.warn('[StampStack] sendMessage failed after retries', payload.type, lastErr);
  return null;
}

function render(data: PopupData): void {
  const blockingHere = !data.paused && !data.allowlisted && !!data.hostname;
  el.host.textContent = data.hostname ?? msg('popup_this_page');
  // No hostname means chrome://, about:, file:, the PDF viewer, … — nothing is being blocked
  // there and the toggle does nothing, so say that rather than claiming blocking is on.
  el.siteSub.textContent = !data.hostname
    ? msg('popup_does_not_run_on_this_page')
    : data.paused
      ? msg('popup_stampstack_is_paused')
      : data.allowlisted
        ? msg('popup_blocking_is_off_here')
        : msg('popup_blocking_on_this_site');

  el.siteToggle.checked = blockingHere;
  el.siteToggle.disabled = data.paused || !data.hostname;
  if (!data.hostname) el.siteToggleLabel.textContent = msg('popup_not_available_on_this_page');
  else if (data.coveredBy)
    el.siteToggleLabel.textContent = msg('popup_blocking_off_via', [data.coveredBy]);
  else if (data.allowlisted) el.siteToggleLabel.textContent = msg('popup_blocking_off_allowlisted');
  else if (data.paused) el.siteToggleLabel.textContent = msg('popup_paused_globally');
  else el.siteToggleLabel.textContent = msg('popup_block_on_this_site');

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
      ? msg('popup_paused_no_rules_active')
      : data.degraded
        ? msg('popup_rules_active_degraded', [data.activeRuleCount.toLocaleString()])
        : msg('popup_rules_active', [data.activeRuleCount.toLocaleString()]);
    el.ruleCount.classList.toggle('warn', !data.paused && data.degraded);
  }

  // Collapsed groups must not hide state: the summary carries it.
  const ytOn = [data.youtubeBlockSponsored, data.youtubeBlockShorts, data.youtubeSponsorBlock].filter(
    Boolean,
  ).length;
  el.ytSummary.textContent = data.paused
    ? msg('popup_summary_paused')
    : msg('popup_youtube_summary_on', [String(ytOn)]);

  // Same reason as the repair panel: a picked selector is stored per host and cosmetic
  // matching drops hosts that are not valid match patterns, so picking on one would appear
  // to work and then never apply.
  el.pickBtn.disabled = !data.hostname || !isValidMatchPatternHost(normalizeHostname(data.hostname));
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
  // Nothing here is ours to have broken on a page we do not run on, or while paused
  // everywhere. Allowlisted is different — see below.
  //
  // A host that is not expressible as a match pattern (an IPv6 literal, `http://[::1]/`) has a
  // hostname but nothing acts on it: isAllowlistedHost refuses it, cosmetic matching filters
  // it out, and the service worker rejects a breakage report for it. Offering the ladder there
  // would be three controls that silently do nothing, and the report would spend five retries
  // discovering that the refusal is permanent.
  const actionable = !!data.hostname && isValidMatchPatternHost(normalizeHostname(data.hostname));
  const unavailable = !actionable || data.paused;
  el.repairOpen.disabled = unavailable;
  el.repair.hidden = unavailable;
  if (unavailable) {
    el.repairPanel.hidden = true;
    el.repairOpen.setAttribute('aria-expanded', 'false');
    return;
  }

  // Allowlisted means the ladder is finished — there is no further rung to offer. The panel
  // stays reachable anyway, because someone who turned blocking off to fix a site is the
  // person most worth hearing from, and hiding this took the report away at exactly that
  // moment.
  el.repairLadder.hidden = data.allowlisted;
  if (data.allowlisted) {
    el.repairState.textContent = msg('popup_repair_state_allowlisted');
    return;
  }

  const level = data.siteFix;
  const next = nextSiteFix(level);

  el.repairState.textContent =
    level === 'injection'
      ? msg('popup_repair_state_injection')
      : level === 'cosmetics'
        ? msg('popup_repair_state_cosmetics')
        : msg('popup_everything_is_on_for_this_site');

  if (next === 'cosmetics') {
    el.repairNext.textContent = msg('popup_repair_next_cosmetics');
    el.repairHint.textContent = msg('popup_repair_hint_cosmetics');
  } else if (next === 'injection') {
    el.repairNext.textContent = msg('popup_repair_next_injection');
    el.repairHint.textContent = msg('popup_repair_hint_injection');
  } else {
    el.repairNext.textContent = msg('popup_repair_next_allowlist');
    el.repairHint.textContent = msg('popup_repair_hint_allowlist');
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
      ? msg('popup_dark_summary_unavailable')
      : data.apply
        ? msg('popup_dark_summary_on_here')
        : data.enabled
          ? msg('popup_dark_summary_off_here')
          : msg('popup_dark_summary_off');

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
        ? msg('popup_dark_hint_dev_unlock')
        : msg('popup_dark_hint_extpay_unconfigured');
    } else if (!data.license.configured) {
      el.darkHint.hidden = false;
      el.darkHint.textContent = msg('popup_dark_hint_purchases_unavailable');
    } else {
      // Production unpaid: nudge restore so reinstalls convert without support tickets.
      el.darkHint.hidden = false;
      el.darkHint.textContent = msg('popup_dark_hint_already_paid');
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
    el.darkHint.textContent = msg('popup_dark_hint_restricted_page');
    return;
  }
  el.darkHint.hidden = true;

  // Primary quick toggle for the current page.
  const hasHost = !!host;
  el.darkSiteRow.hidden = !hasHost;
  if (hasHost) {
    el.darkSiteToggle.checked = data.apply;
    el.darkSiteToggle.disabled = false;
    el.darkSiteLabel.textContent = data.apply
      ? msg('popup_dark_mode_is_on_here')
      : msg('popup_dark_mode_is_off_here');
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
      el.reportTitle.textContent = msg('popup_on_this_page');
      el.reportSummary.textContent = msg('popup_report_reload_to_see');
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

  // Each branch is one whole sentence: singular and plural are separate messages because the
  // plural rule and the word order both differ per language, and a suffix cannot be translated.
  if (named) {
    if (withRules) {
      parts.push(
        msg(named === 1 ? 'popup_report_tracker_one_rules' : 'popup_report_trackers_many_rules', [
          String(named),
          String(withRules),
        ]),
      );
    } else {
      parts.push(
        msg(named === 1 ? 'popup_report_tracker_one' : 'popup_report_trackers_many', [String(named)]),
      );
    }
  } else if (report.unnamedThirdParty) {
    parts.push(msg('popup_report_no_known_trackers'));
  } else {
    parts.push(msg('popup_report_no_third_party'));
  }
  if (report.hiddenElements) {
    parts.push(
      msg(report.hiddenElements === 1 ? 'popup_report_ad_slot_one' : 'popup_report_ad_slots_many', [
        String(report.hiddenElements),
      ]),
    );
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
    state.textContent = t.blocked ? msg('popup_report_state_blocked') : msg('popup_report_state_unlisted');
    li.append(name, state);
    el.reportList.append(li);
  }

  const foot: string[] = [];
  if (report.unnamedThirdParty) {
    foot.push(
      msg(
        report.unnamedThirdParty === 1
          ? 'popup_report_other_host_one'
          : 'popup_report_other_hosts_many',
        [String(report.unnamedThirdParty)],
      ),
    );
  }
  if (report.truncated) foot.push(msg('popup_report_list_truncated'));
  el.reportFoot.textContent = foot.join(' · ');
  el.reportFoot.hidden = foot.length === 0 || el.reportList.hidden;
}

el.reportToggle.addEventListener('click', () => {
  const show = el.reportList.hidden;
  el.reportList.hidden = !show;
  el.reportFoot.hidden = !show || !el.reportFoot.textContent;
  el.reportToggle.textContent = show ? msg('popup_hide') : msg('popup_details');
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
    el.pickHint.textContent = r?.error ?? msg('popup_picker_could_not_start');
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

/**
 * Hand the composed report to the user's mail client.
 *
 * Not every profile has one — `tabs.create({ url: mailto:… })` often resolves even when no
 * handler exists (blank tab). Clipboard is the reliable path. Also: opening a tab closes the
 * action popup, so any note after `tabs.create` never paints — set feedback first, then open.
 */
/** Outcome the user can act on. */
function noteSent(text: string): void {
  el.reportBreakageNote.textContent = text;
  el.reportBreakageNote.classList.add('sent');
  el.reportBreakageNote.classList.remove('failed');
}

/** Outcome that left them with nothing — must not wear the success accent. */
function noteFailed(text: string): void {
  el.reportBreakageNote.textContent = text;
  el.reportBreakageNote.classList.add('failed');
  el.reportBreakageNote.classList.remove('sent');
}

el.reportBreakage.addEventListener('click', async () => {
  if (!current?.hostname) return;
  el.reportBreakage.disabled = true;
  try {
    const report = await sendWithRetry<BreakageReport>({
      type: 'report:breakage',
      hostname: current.hostname,
    });
    if (!report) {
      noteFailed(msg('popup_breakage_build_failed', [SUPPORT_EMAIL]));
      return;
    }

    let copied = false;
    try {
      await navigator.clipboard.writeText(
        `To: ${report.to}\nSubject: ${report.subject}\n\n${report.body}`,
      );
      copied = true;
    } catch {
      // Best-effort; no clipboardWrite permission — some profiles still allow it from a gesture.
    }

    // Paint before tabs.create closes this popup. Double-rAF gives the layout a frame.
    noteSent(
      copied
        ? msg('popup_breakage_copied', [report.to])
        : msg('popup_breakage_opening', [report.to]),
    );
    await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));

    try {
      await chrome.tabs.create({ url: report.mailto, active: true });
    } catch {
      // Popup may already be gone; if not, correct the optimistic note. With the report on the
      // clipboard the user still has everything they need, so that stays the success accent;
      // without it there is nothing to act on and it is a failure.
      if (copied) {
        noteSent(msg('popup_breakage_no_app_copied', [report.to]));
      } else {
        noteFailed(msg('popup_breakage_no_app', [current.hostname, report.to]));
      }
    }
  } catch {
    noteFailed(msg('popup_breakage_build_failed', [SUPPORT_EMAIL]));
  } finally {
    el.reportBreakage.disabled = false;
  }
});

el.siteToggle.addEventListener('change', async () => {
  if (!current?.hostname) return;
  const wanted = el.siteToggle.checked;
  // A null answer used to reach render() and throw inside this async listener: no UI change, no
  // error, switch left claiming a state that was never applied. Not the cause of the 2.1.1 bug
  // (the click never reached this handler at all) but the same silence, one layer up.
  const data = await sendWithRetry<PopupData>({
    type: 'popup:toggleSite',
    hostname: current.hostname,
    enabled: wanted,
  });
  if (!data) {
    el.siteToggle.checked = !wanted; // Never leave the switch claiming a state we did not reach.
    el.siteToggleLabel.textContent = msg('popup_site_toggle_failed');
    el.siteToggleLabel.classList.add('warn');
    return;
  }
  el.siteToggleLabel.classList.remove('warn');
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
        ? msg('popup_checkout_unavailable_unpacked')
        : msg('popup_checkout_unavailable'));
  }
  el.darkBuyBtn.disabled = false;
  void refresh();
});

el.darkRestoreBtn.addEventListener('click', async () => {
  el.darkRestoreBtn.disabled = true;
  const r = (await send({ type: 'license:openRestore' })) as { ok: boolean; error?: string };
  if (!r?.ok) {
    el.darkHint.hidden = false;
    el.darkHint.textContent = r?.error ?? msg('popup_restore_unavailable');
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
    el.darkHint.textContent = r?.error ?? msg('popup_dev_unlock_failed');
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

// Before the first paint: static markup must not flash English and then switch.
applyI18n();

void refresh();
