// Popup controller: shows the active tab's status and wires the per-site + master toggles.

import type {
  DarkModeData,
  Message,
  PageReport,
  PopupData,
  SiteFixLevel,
  SiteToggleData,
} from '../shared/types.js';
import { nextSiteFix } from '../shared/site-fix.js';
import type { BreakageReport } from '../shared/breakage-report.js';
import { SUPPORT_EMAIL } from '../shared/constants.js';
import { applyI18n, msg, uiLanguage } from '../shared/i18n.js';
import {
  fixLanded,
  inheritedFixHost,
  siteState,
  toggleLanded,
  type PickBlock,
  type SiteState,
} from './site-state.js';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const el = {
  statusIcon: $<HTMLImageElement>('statusIcon'),
  host: $('host'),
  siteSub: $('siteSub'),
  siteToggle: $<HTMLInputElement>('siteToggle'),
  siteToggleLabel: $('siteToggleLabel'),
  incognitoNote: $('incognitoNote'),
  pauseToggle: $<HTMLInputElement>('pauseToggle'),
  pauseNote: $('pauseNote'),
  ytSponsoredToggle: $<HTMLInputElement>('ytSponsoredToggle'),
  ytShortsToggle: $<HTMLInputElement>('ytShortsToggle'),
  ytSponsorBlockToggle: $<HTMLInputElement>('ytSponsorBlockToggle'),
  ytSiteNote: $('ytSiteNote'),
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
  shortcutHint: $('shortcutHint'),
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
  darkUpsellText: $('darkUpsellText'),
  darkBuyBtn: $<HTMLButtonElement>('darkBuyBtn'),
  darkRestoreBtn: $<HTMLButtonElement>('darkRestoreBtn'),
  darkDevUnlockBtn: $<HTMLButtonElement>('darkDevUnlockBtn'),
  darkHint: $('darkHint'),
};

/** `{ok:false}` answers from the worker. `code` is optional until the worker sends one. */
interface WorkerResult {
  ok: boolean;
  error?: string;
  code?: string;
}

// Named `payload`, not `msg`: `msg` is the i18n lookup at module scope and shadowing it here
// would make a translated string silently resolve to a Message object.
function send(payload: Message): Promise<unknown> {
  return chrome.runtime.sendMessage(payload);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Every popup message goes through here. Cold service-worker wakes can drop the first
 * sendMessage, and the worker answers null when a handler throws; handing either to a renderer
 * threw inside the listener and left the control showing a state that was never applied.
 */
async function request<T>(payload: Message, attempts = 5): Promise<T | null> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const resp = (await send(payload)) as T | null | undefined;
      if (resp != null) return resp;
    } catch (e) {
      lastErr = e;
    }
    if (i + 1 < attempts) await sleep(50 * (i + 1));
  }
  if (lastErr) console.warn('[StampStack] sendMessage failed after retries', payload.type, lastErr);
  return null;
}

/**
 * A refusal from the worker, in this page's language. A `code` maps to a translated message.
 * The worker's own `error` is English prose, so it is shown only on an English page and is
 * otherwise replaced by the translated fallback.
 */
function workerError(r: WorkerResult | null, fallbackKey: string): string {
  if (r?.code) {
    const coded = msg(`popup_error_${r.code}`);
    if (coded) return coded;
  }
  if (r?.error) {
    console.warn('[StampStack]', r.error);
    if (uiLanguage().toLowerCase().startsWith('en')) return r.error;
  }
  return msg(fallbackKey);
}

function note(target: HTMLElement, text: string, warn: boolean): void {
  target.textContent = text;
  target.hidden = !text;
  target.classList.toggle('warn', warn);
}

// --- Rendering ---------------------------------------------------------------

let current: PopupData | null = null;
let currentSite: SiteState | null = null;
let darkCurrent: DarkModeData | null = null;
/** The picker shortcut Chrome actually assigned; '' when none. */
let pickShortcut = '';

function statusLine(data: PopupData, site: SiteState): string {
  // chrome://, about:, file:, the PDF viewer and the Web Store: nothing is filtered there and
  // the switch does nothing, so say that rather than claiming blocking is on.
  if (site.page !== 'web') return msg('popup_does_not_run_on_this_page');
  if (data.paused) return msg('popup_stampstack_is_paused');
  if (data.allowlisted) return msg('popup_blocking_is_off_here');
  // A repair step is part of "how this site is filtered". Kept inside the collapsed repair
  // panel only, a site switched back on after the last rung read as fully filtered while its
  // element hiding and script patches were still off.
  if (data.siteFix === 'injection') return msg('popup_blocking_on_fix_injection');
  if (data.siteFix === 'cosmetics') return msg('popup_blocking_on_fix_cosmetics');
  return msg('popup_blocking_on_this_site');
}

function toggleNote(data: PopupData, site: SiteState): string {
  if (site.page === 'none') return msg('popup_not_available_on_this_page');
  if (site.page === 'restricted') return msg('popup_restricted_page');
  if (data.coveredBy) return msg('popup_blocking_off_via', [data.coveredBy]);
  if (data.allowlisted) return msg('popup_blocking_off_allowlisted');
  if (data.paused) return msg('popup_paused_globally');
  // The worker cannot hold a per-site entry for this host. Say so instead of offering a switch
  // that springs back.
  if (!site.switchable) {
    return data.siteRefusal === 'ipv6'
      ? msg('popup_site_unsupported_ipv6')
      : msg('popup_site_unsupported_host', [data.hostname ?? '']);
  }
  return msg('popup_block_on_this_site');
}

function pickReason(block: PickBlock): string {
  switch (block) {
    case 'host':
      return msg('popup_pick_unavailable_host');
    case 'paused':
      return msg('popup_pick_unavailable_paused');
    case 'allowlisted':
      return msg('popup_pick_unavailable_allowlisted');
    case 'fix':
      return msg('popup_pick_unavailable_fix');
    default:
      return '';
  }
}

function render(data: PopupData): void {
  const site = siteState(data);
  currentSite = site;
  el.host.textContent = data.hostname ?? msg('popup_this_page');
  el.siteSub.textContent = statusLine(data, site);

  el.siteToggle.checked = site.filtering;
  el.siteToggle.disabled = data.paused || !site.switchable;
  // A warning belongs to the attempt that raised it; any fresh state replaces it.
  el.siteToggleLabel.classList.remove('warn');
  el.siteToggleLabel.textContent = toggleNote(data, site);
  // Settings are shared with Incognito windows (the worker stores one set, as uBO does).
  el.incognitoNote.hidden = !data.incognito || !site.switchable;

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

  // Collapsed groups must not hide state: the summary carries it. The three switches are
  // global preferences, but on an allowlisted YouTube page none of them runs, and "3 of 3 on"
  // there promised sponsor skipping that could not happen.
  const ytOn = [data.youtubeBlockSponsored, data.youtubeBlockShorts, data.youtubeSponsorBlock].filter(
    Boolean,
  ).length;
  el.ytSummary.textContent = data.paused
    ? msg('popup_summary_paused')
    : site.youtubeOffHere
      ? msg('popup_youtube_summary_off_here')
      : msg('popup_youtube_summary_on', [String(ytOn)]);
  note(el.ytSiteNote, site.youtubeOffHere && !data.paused ? msg('popup_youtube_off_here_note') : '', false);

  el.pickBtn.disabled = site.pick !== null;
  el.pickBtn.title = pickReason(site.pick);
  // Only the reasons nothing else on screen already gives: paused and allowlisted are the
  // status line, a page we do not run on is too.
  const pickWhy = site.pick === 'fix' ? pickReason('fix') : '';
  if (pickWhy || !el.pickHint.classList.contains('warn')) note(el.pickHint, pickWhy, false);
  renderShortcut();
  renderRepair(data, site);

  el.statusIcon.classList.toggle('off', !site.filtering);
  document.body.classList.toggle('paused', data.paused);
  document.body.classList.toggle('allowlisted', data.allowlisted);
}

/**
 * The repair ladder. Each press turns off one more layer instead of jumping straight to a
 * full allowlist, so a user fixing a collapsed menu keeps their ad blocking.
 */
function renderRepair(data: PopupData, site: SiteState): void {
  // Nothing here is ours to have broken on a page we do not run on, or while paused
  // everywhere. Allowlisted is different — see below.
  //
  // The report needs only a host the worker will name (its report:breakage gate); the rungs
  // need one it can hold a per-site entry for. Where those differ the panel stays, for the
  // report, and says why there is no ladder.
  const unavailable = !site.reportable || data.paused;
  el.repairOpen.disabled = unavailable;
  el.repair.hidden = unavailable;
  if (unavailable) {
    el.repairPanel.hidden = true;
    el.repairOpen.setAttribute('aria-expanded', 'false');
    el.repairOpen.classList.remove('active');
    return;
  }

  // Allowlisted means the ladder is finished — there is no further rung to offer. The panel
  // stays reachable anyway, because someone who turned blocking off to fix a site is the
  // person most worth hearing from, and hiding this took the report away at exactly that
  // moment.
  el.repairLadder.hidden = data.allowlisted || !site.switchable;
  if (data.allowlisted) {
    el.repairState.textContent = msg('popup_repair_state_allowlisted');
    return;
  }
  if (!site.switchable) {
    el.repairState.textContent = msg('popup_repair_state_unsupported_host', [data.hostname ?? '']);
    return;
  }

  const level = data.siteFix;
  const next = nextSiteFix(level);
  const inherited = inheritedFixHost(data);

  const state =
    level === 'injection'
      ? // On YouTube this rung also removes the player-ad hooks: network blocking stays on, but
        // it alone does not stop the video ads there.
        msg(site.youtube ? 'popup_repair_state_injection_youtube' : 'popup_repair_state_injection')
      : level === 'cosmetics'
        ? msg('popup_repair_state_cosmetics')
        : msg('popup_everything_is_on_for_this_site');
  // A fix set on example.com applies on forum.example.com too; without saying where it came
  // from, Undo here looked like it would only affect this page.
  el.repairState.textContent = inherited ? `${state} ${msg('popup_repair_inherited', [inherited])}` : state;

  el.repairHint.classList.remove('warn');
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
  el.repairReset.textContent = inherited
    ? msg('popup_undo_for_host', [inherited])
    : msg('popup_undo_turn_filtering_back_on');
}

function renderLoadFailed(): void {
  // Leave every control in the markup's disabled state: with no answer there is nothing true to
  // show, and the old defaults ("Blocking on this site", 0 blocked) were claims.
  el.siteSub.textContent = msg('popup_load_failed');
  el.statusIcon.classList.add('off');
}

/**
 * The tip names the shortcut Chrome actually assigned. `suggested_key` is only a suggestion:
 * Chrome leaves it unset when another extension already holds Alt+Shift+X, the user can clear
 * or rebind it, and on macOS it reads ⌥⇧X.
 */
function renderShortcut(): void {
  const show = !!pickShortcut && currentSite?.pick === null;
  el.shortcutHint.hidden = !show;
  if (!show) return;
  // Translated as one sentence; the key goes wherever the translator put $SHORTCUT$.
  const MARK = '';
  const [before = '', after = ''] = msg('popup_shortcut_tip', [MARK]).split(MARK);
  const kbd = document.createElement('kbd');
  kbd.textContent = pickShortcut;
  el.shortcutHint.replaceChildren(before, kbd, after);
}

async function loadShortcut(): Promise<void> {
  try {
    const commands = (await chrome.commands?.getAll?.()) ?? [];
    pickShortcut = commands.find((c) => c.name === 'pick-element')?.shortcut ?? '';
  } catch {
    pickShortcut = '';
  }
  renderShortcut();
}

function renderDarkMode(data: DarkModeData): void {
  darkCurrent = data;
  el.darkUpsellText.textContent = msg('popup_dark_upsell', [data.license.priceLabel]);
  const host = data.hostname;
  // chrome://, about:blank, the new-tab page and the PDF viewer have no host, and dark mode's
  // CSS never reaches them — "on here" there was a claim about a page it cannot touch.
  const unavailableHere = !!data.restricted || !host;

  // Summary for the collapsed group. Unpaid shows the price so the group is still a hook.
  el.darkSummary.textContent = !data.paid
    ? data.license.priceLabel
    : unavailableHere
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
      note(
        el.darkHint,
        data.license.configured
          ? msg('popup_dark_hint_dev_unlock')
          : msg('popup_dark_hint_extpay_unconfigured'),
        false,
      );
    } else if (!data.license.configured) {
      note(el.darkHint, msg('popup_dark_hint_purchases_unavailable'), false);
    } else {
      // Production unpaid: nudge restore so reinstalls convert without support tickets.
      note(el.darkHint, msg('popup_dark_hint_already_paid'), false);
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
    note(el.darkHint, msg('popup_dark_hint_restricted_page'), false);
    return;
  }
  note(el.darkHint, '', false);

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
  // A page Chrome keeps extensions off has no content script, and reloading never gives it
  // one — "Reload the page to see what it connects to" there was a dead end.
  if (currentSite && currentSite.page !== 'web') {
    el.report.hidden = true;
    return;
  }
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
    li.className = t.blocked ? 'report-item blocked' : t.partial ? 'report-item partial' : 'report-item seen';
    const name = document.createElement('span');
    name.className = 'report-name';
    name.textContent = t.label;
    const state = document.createElement('span');
    state.className = 'report-state';
    // "not in our lists" is the honest phrasing: we know we have no rule, we do not know
    // whether the request itself succeeded. "partly" is a rule that covers some of its paths.
    state.textContent = t.blocked
      ? msg('popup_report_state_blocked')
      : t.partial
        ? msg('popup_report_state_partial')
        : msg('popup_report_state_unlisted');
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
  el.reportToggle.setAttribute('aria-expanded', String(show));
});

// --- Loading -----------------------------------------------------------------

function show(data: PopupData): void {
  current = data;
  render(data);
}

async function loadDark(): Promise<void> {
  const dark = await request<DarkModeData>({
    type: 'darkmode:get',
    hostname: current?.hostname ?? null,
  });
  if (dark) renderDarkMode(dark);
}

async function loadReport(): Promise<void> {
  const report = await request<PageReport>({ type: 'report:get' }, 2);
  if (report) renderReport(report);
}

async function refresh(): Promise<void> {
  const data = await request<PopupData>({ type: 'popup:get' });
  if (!data) {
    renderLoadFailed();
    return;
  }
  show(data);
  await loadDark();
  // Last: it round-trips to the content script, so never let it delay the main UI.
  await loadReport();
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

// --- Per-site controls ---------------------------------------------------------

// The picker needs the page in front of the user, so the popup must close for it to be usable.
el.pickBtn.addEventListener('click', async () => {
  const r = await request<WorkerResult & { reason?: PickBlock }>({ type: 'picker:start' }, 2);
  if (!r?.ok) {
    // The worker applies the same gate as the button and names the reason it refused; the
    // translated sentence for it beats its English one.
    const why = r?.reason ? pickReason(r.reason) : '';
    note(el.pickHint, why || workerError(r, 'popup_picker_could_not_start'), true);
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

function openRepairPanel(): void {
  el.repairPanel.hidden = false;
  el.repairOpen.setAttribute('aria-expanded', 'true');
  el.repairOpen.classList.add('active');
}

/** Keep keyboard focus in the panel when the control that had it was just hidden. */
function keepFocus(from: HTMLElement): void {
  if (!from.hidden && !from.closest('[hidden]')) return;
  const next = [el.repairNext, el.repairReset, el.reportBreakage].find(
    (b) => !b.hidden && !b.closest('[hidden]') && !b.disabled,
  );
  next?.focus();
}

async function setSiteFix(level: SiteFixLevel | null, from: HTMLElement): Promise<void> {
  if (!current?.hostname) return;
  const data = await request<PopupData>({
    type: 'sitefix:set',
    hostname: current.hostname,
    level,
  });
  openRepairPanel();
  if (!data) {
    note(el.repairHint, msg('popup_repair_failed'), true);
    return;
  }
  show(data);
  keepFocus(from);
  // The worker answers with the site as it is whether or not it stored anything, so only a
  // state that actually moved is worth a reload.
  if (fixLanded(data, level)) promptReload();
  else note(el.repairHint, msg('popup_repair_no_effect'), true);
}

/**
 * Render a popup:toggleSite answer. Returns whether the switch took effect.
 *
 * Chrome can refuse the allowlist rule change. The worker then stores nothing and answers
 * `applied: false` with the site as it still is, so the switch goes back to the truth and the
 * note says the change did not happen, rather than showing blocking off while it is still on.
 * An answer that is `applied` yet leaves the site where it was (a host the worker will not key)
 * gets the same treatment rather than a reload prompt.
 */
function renderToggleResult(data: SiteToggleData, wantedBlocking: boolean): boolean {
  show(data);
  if (data.applied !== false && toggleLanded(data, wantedBlocking)) return true;
  const key =
    data.applied === false
      ? wantedBlocking
        ? 'popup_site_toggle_not_applied_on'
        : 'popup_site_toggle_not_applied_off'
      : wantedBlocking
        ? 'popup_site_toggle_unchanged_off'
        : 'popup_site_toggle_unchanged_on';
  el.siteToggleLabel.textContent = msg(key);
  el.siteToggleLabel.classList.add('warn');
  return false;
}

el.repairNext.addEventListener('click', async () => {
  const step = el.repairNext.dataset['level'];
  // The bottom rung is the existing allowlist, not another fix level.
  if (step === 'allowlist') {
    if (!current?.hostname) return;
    const data = await request<SiteToggleData>({
      type: 'popup:toggleSite',
      hostname: current.hostname,
      enabled: false,
    });
    if (!data) {
      el.siteToggleLabel.textContent = msg('popup_site_toggle_failed');
      el.siteToggleLabel.classList.add('warn');
      note(el.repairHint, msg('popup_site_toggle_failed'), true);
      return;
    }
    const landed = renderToggleResult(data, false);
    keepFocus(el.repairNext);
    if (landed) promptReload();
    // The panel is where the user is looking; say it there too.
    else note(el.repairHint, el.siteToggleLabel.textContent ?? '', true);
    return;
  }
  await setSiteFix(step === 'injection' ? 'injection' : 'cosmetics', el.repairNext);
});

el.repairReset.addEventListener('click', () => {
  void setSiteFix(null, el.repairReset);
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
  const hostname = current?.hostname;
  if (!hostname) return;
  el.reportBreakage.disabled = true;
  try {
    const report = await request<BreakageReport>({
      type: 'report:breakage',
      hostname,
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
        noteFailed(msg('popup_breakage_no_app', [hostname, report.to]));
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
  const data = await request<SiteToggleData>({
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
  // Nothing changed when Chrome refused, so there is nothing to reload for.
  if (renderToggleResult(data, wanted)) promptReload();
});

// --- Global controls ---------------------------------------------------------------

el.pauseToggle.addEventListener('change', async () => {
  const wanted = el.pauseToggle.checked;
  const data = await request<PopupData>({ type: 'popup:setPaused', paused: wanted });
  if (!data || data.paused !== wanted) {
    el.pauseToggle.checked = data ? data.paused : !wanted;
    note(el.pauseNote, msg('popup_pause_failed'), true);
    if (data) show(data);
    return;
  }
  note(el.pauseNote, '', false);
  show(data);
  promptReload();
  void loadReport();
});

async function saveYoutubeOptions(changed: HTMLInputElement): Promise<void> {
  const data = await request<PopupData>({
    type: 'popup:setYoutubeOptions',
    youtubeBlockSponsored: el.ytSponsoredToggle.checked,
    youtubeBlockShorts: el.ytShortsToggle.checked,
    youtubeSponsorBlock: el.ytSponsorBlockToggle.checked,
  });
  if (!data) {
    changed.checked = !changed.checked;
    note(el.ytSiteNote, msg('popup_setting_not_saved'), true);
    return;
  }
  show(data);
}

for (const toggle of [el.ytSponsoredToggle, el.ytShortsToggle, el.ytSponsorBlockToggle]) {
  toggle.addEventListener('change', () => {
    void saveYoutubeOptions(toggle);
  });
}

// --- Dark mode ---------------------------------------------------------------------

function darkFailed(text: string): void {
  note(el.darkHint, text, true);
}

el.darkModeToggle.addEventListener('change', async () => {
  if (!darkCurrent?.paid) {
    el.darkModeToggle.checked = false;
    el.darkUpsell.hidden = false;
    return;
  }
  const wanted = el.darkModeToggle.checked;
  const data = await request<DarkModeData>({ type: 'darkmode:setEnabled', enabled: wanted });
  if (!data) {
    el.darkModeToggle.checked = !wanted;
    darkFailed(msg('popup_setting_not_saved'));
    return;
  }
  renderDarkMode(data);
});

el.darkBuyBtn.addEventListener('click', async () => {
  el.darkBuyBtn.disabled = true;
  const r = await request<WorkerResult>({ type: 'license:openCheckout' }, 1);
  // Re-render first: it rewrites the hint, and the outcome of this click must be what stays.
  await loadDark();
  if (!r?.ok) {
    darkFailed(
      workerError(
        r,
        darkCurrent?.license.unpacked ? 'popup_checkout_unavailable_unpacked' : 'popup_checkout_unavailable',
      ),
    );
  }
  el.darkBuyBtn.disabled = !!darkCurrent && !darkCurrent.license.configured && !darkCurrent.license.unpacked;
});

el.darkRestoreBtn.addEventListener('click', async () => {
  el.darkRestoreBtn.disabled = true;
  const r = await request<WorkerResult>({ type: 'license:openRestore' }, 1);
  await loadDark();
  if (!r?.ok) darkFailed(workerError(r, 'popup_restore_unavailable'));
  el.darkRestoreBtn.disabled = !darkCurrent?.license.configured;
});

el.darkDevUnlockBtn.addEventListener('click', async () => {
  el.darkDevUnlockBtn.disabled = true;
  const r = await request<WorkerResult & { darkMode?: DarkModeData }>({ type: 'license:devUnlock' }, 1);
  el.darkDevUnlockBtn.disabled = false;
  if (!r?.ok) {
    darkFailed(workerError(r, 'popup_dev_unlock_failed'));
    return;
  }
  if (r.darkMode) renderDarkMode(r.darkMode);
  else await loadDark();
});

// Quick per-page toggle: pin an explicit on/off override for this site. The "Reset to
// global default" link clears it. Explicit (rather than clearing when it matches global)
// so a Force-on sticks on sites the smart detector would otherwise auto-skip as already-dark.
el.darkSiteToggle.addEventListener('change', async () => {
  if (!darkCurrent?.hostname || !darkCurrent.paid) return;
  const wanted = el.darkSiteToggle.checked;
  const data = await request<DarkModeData>({
    type: 'darkmode:setSiteOverride',
    hostname: darkCurrent.hostname,
    override: wanted ? 'on' : 'off',
  });
  if (!data) {
    el.darkSiteToggle.checked = !wanted;
    darkFailed(msg('popup_setting_not_saved'));
    return;
  }
  renderDarkMode(data);
});

el.darkResetBtn.addEventListener('click', async () => {
  if (!darkCurrent?.hostname || !darkCurrent.paid) return;
  const data = await request<DarkModeData>({
    type: 'darkmode:setSiteOverride',
    hostname: darkCurrent.hostname,
    override: null,
  });
  if (!data) {
    darkFailed(msg('popup_setting_not_saved'));
    return;
  }
  renderDarkMode(data);
  // The link hides itself once the override is gone; hand focus to the switch it reset.
  if (el.darkResetBtn.hidden) el.darkSiteToggle.focus();
});

function openOptions(): void {
  chrome.runtime.openOptionsPage();
}
el.optionsBtn.addEventListener('click', openOptions);
el.openOptions.addEventListener('click', openOptions);

// Before the first paint: static markup must not flash English and then switch.
applyI18n();

void refresh();
void loadShortcut();
