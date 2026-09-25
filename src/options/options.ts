// Options page: filter-list management, YouTube features, dark mode, and stats.

import type {
  Message,
  ListsData,
  ListRow,
  StatsData,
  ListGroup,
  PopupData,
  DarkModeData,
  DarkModeSiteOverride,
  LicenseData,
  SiteRulesData,
  SiteFixLevel,
  SiteToggleData,
  CustomFiltersData,
  SettingsImportResult,
  SponsorCategoriesData,
} from '../shared/types.js';
import { siteFixLabel } from '../shared/site-fix.js';
import { siteRuleCovers, siteRuleKeyFromInput, siteRuleScope } from '../shared/site-rules.js';
import { listAge, localizedListDate } from '../shared/list-age.js';
import { applyI18n, msg, uiLanguage } from '../shared/i18n.js';
import { STORAGE_KEY } from '../shared/constants.js';
import { listRowState } from './list-state.js';
import { mergeFilterText } from './filter-merge.js';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

/** `{ok:false}` answers from the worker. `code` is optional until the worker sends one. */
interface WorkerResult {
  ok: boolean;
  error?: string;
  code?: string;
}

function send(message: Message): Promise<unknown> {
  return chrome.runtime.sendMessage(message);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Every message from this page goes through here. A cold worker can drop the first message, and
 * the worker answers null when a handler throws; loaders that read fields off that null threw,
 * which left "Loading…" on screen for good and switches greyed out in a state never applied.
 */
async function request<T>(message: Message, attempts = 3): Promise<T | null> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const resp = (await send(message)) as T | null | undefined;
      if (resp != null) return resp;
    } catch (e) {
      lastErr = e;
    }
    if (i + 1 < attempts) await sleep(50 * (i + 1));
  }
  if (lastErr) console.warn('[StampStack] sendMessage failed after retries', message.type, lastErr);
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

/**
 * Update a container's rows in place, matched by key. Rebuilding with `textContent = ''` on
 * every settings write destroyed the focused switch and dropped keyboard focus to <body>.
 */
function syncRows<T>(
  container: HTMLElement,
  items: T[],
  keyOf: (item: T) => string,
  create: (item: T) => HTMLElement,
  update: (row: HTMLElement, item: T) => void,
): void {
  const existing = new Map<string, HTMLElement>();
  for (const node of [...container.childNodes]) {
    const key = node instanceof HTMLElement ? node.dataset['key'] : undefined;
    // Placeholder text ("Loading…", "None yet.") and anything unkeyed goes.
    if (key) existing.set(key, node as HTMLElement);
    else node.remove();
  }
  const wanted = new Set(items.map(keyOf));
  for (const [key, row] of existing) {
    if (!wanted.has(key)) {
      row.remove();
      existing.delete(key);
    }
  }
  let cursor = container.firstElementChild;
  for (const item of items) {
    const key = keyOf(item);
    let row = existing.get(key);
    if (!row) {
      row = create(item);
      row.dataset['key'] = key;
    }
    update(row, item);
    // Only move what is out of place: moving a node blurs it.
    if (row === cursor) cursor = cursor.nextElementSibling;
    else container.insertBefore(row, cursor);
  }
}

function setStatus(target: HTMLElement, text: string, warn = false): void {
  target.textContent = text;
  target.classList.toggle('list-warn', warn);
}

const GROUP_KEY: Record<ListGroup, string> = {
  ads: 'options_group_ads',
  privacy: 'options_group_privacy',
  security: 'options_group_security',
  annoyances: 'options_group_annoyances',
};

// The ladder labels live in shared/site-fix.ts for the popup's benefit; the options page
// translates them here rather than making that module depend on chrome.i18n.
const SITE_FIX_KEY: Record<SiteFixLevel, string> = {
  cosmetics: 'options_element_hiding_off',
  injection: 'options_element_hiding_scriptlets_off',
};

// --- Overview: stat cards, paused banner and the filter lists ------------------------------
//
// One stats:get answers all of it (it carries the list rows and the paused flag), so the rows
// and the paused state can never come from two different moments.

const lists = {
  rows: [] as ListRow[],
  paused: false,
  degraded: false,
  loaded: false,
  /** Ticket of the rows on screen. */
  shown: 0,
  /** Ticket counter shared by reads and toggles. */
  tickets: 0,
  /** lists:setEnabled requests in flight, and the newest one. */
  writes: 0,
  lastWrite: 0,
};
let stats: StatsData | null = null;

async function loadOverview(): Promise<void> {
  const ticket = ++lists.tickets;
  // A read that overlaps a toggle can see the stored setting before Chrome has loaded the
  // ruleset; rendered, that was a permanent "Not active — Chrome's shared rule limit is full".
  const raced = lists.writes > 0;
  const s = await request<StatsData>({ type: 'stats:get' });
  if (!s) {
    if (!lists.loaded) setStatus($('lists'), msg('options_load_failed'), true);
    return;
  }
  stats = s;
  if (!raced && lists.writes === 0 && ticket > lists.shown) {
    lists.shown = ticket;
    applyRows(s.lists, s.paused, s.degraded);
  }
  renderOverview();
}

function applyRows(rows: ListRow[], paused: boolean, degraded: boolean): void {
  lists.rows = rows;
  lists.paused = paused;
  lists.degraded = degraded;
  lists.loaded = true;
}

function renderOverview(): void {
  const paused = lists.paused;
  // `active`, not `enabled`: on a profile whose static-rule pool is exhausted these differ,
  // and the requested total would overstate the protection in force.
  const activeRules = paused
    ? 0
    : lists.rows.filter((l) => l.active).reduce((n, l) => n + l.ruleCount, 0);

  const brandIcon = $<HTMLImageElement>('brandIcon');
  brandIcon.classList.toggle('off', paused);
  brandIcon.alt = (paused && msg('popup_stampstack_is_paused')) || msg('popup_stampstack') || 'StampStack';
  $('pausedBanner').hidden = !paused;

  $('statRules').textContent = activeRules.toLocaleString();
  const rulesLabel = document.querySelector('#statRules')?.parentElement?.querySelector('.card-label');
  if (rulesLabel) {
    rulesLabel.textContent = msg(
      lists.degraded && !paused ? 'options_rules_active_reduced' : 'options_network_rules_active',
    );
  }

  if (stats) {
    $('statTotal').textContent = stats.statsReliable
      ? stats.blockedTotal.toLocaleString()
      : msg('options_stat_unavailable');
    $('statRegex').textContent = String(stats.regexRulesUsed);
    const totalLabel = document.querySelector('#statTotal')?.parentElement?.querySelector('.card-label');
    if (totalLabel) {
      totalLabel.textContent = msg(
        stats.statsReliable ? 'options_requests_blocked' : 'options_blocked_count_dev_only',
      );
    }
    renderListAge(stats.listsGeneratedAt);
  }

  if (lists.loaded) renderListRows();
  // "N rules active" in My filters depends on pause too.
  renderCustomStatus();
}

function renderListAge(generatedAt: string | null): void {
  // Lists are frozen at build time, so their age is the one thing about coverage the UI
  // could not previously say. Left unsaid, protection decays with nothing to show for it.
  const age = listAge(generatedAt, Date.now());
  const ageEl = $('listAge');
  // Built from the parts, not from age.text. That string stays English on purpose — it also
  // goes into the breakage-report email, which is read by the developer, not the user. The date
  // is formatted for this page's language: the English one read "（7 Sep 2026）" in Chinese.
  const when =
    age.days === 0
      ? msg('options_list_age_today')
      : msg(age.days === 1 ? 'options_list_age_day_one' : 'options_list_age_day_other', [
          String(age.days),
        ]);
  ageEl.textContent =
    age.level === 'unknown'
      ? msg('options_list_age_unknown')
      : msg(`options_list_age_${age.level}`, [when, localizedListDate(generatedAt, uiLanguage())]);
  ageEl.classList.toggle('list-warn', age.level === 'stale');
}

interface ListRowParts {
  name: HTMLElement;
  badge: HTMLElement;
  meta: HTMLElement;
  input: HTMLInputElement;
}
const listParts = new WeakMap<HTMLElement, ListRowParts>();

function renderListRows(): void {
  const container = $('lists');
  if (!lists.rows.length) {
    container.textContent = msg('options_no_filter_lists');
    return;
  }
  syncRows(container, lists.rows, (l) => l.id, createListRow, updateListRow);
}

function createListRow(l: ListRow): HTMLElement {
  const row = document.createElement('div');
  row.className = 'list-item';

  const info = document.createElement('div');
  info.className = 'list-info';
  const title = document.createElement('div');
  title.className = 'list-title';
  const name = document.createElement('span');
  const badge = document.createElement('span');
  badge.className = 'badge';
  title.append(name, badge);
  const meta = document.createElement('div');
  meta.className = 'list-meta';
  info.append(title, meta);

  const sw = document.createElement('label');
  sw.className = 'switch';
  const input = document.createElement('input');
  input.type = 'checkbox';
  const slider = document.createElement('span');
  slider.className = 'slider';
  sw.append(input, slider);
  input.addEventListener('change', () => {
    void toggleList(l.id, row);
  });

  row.append(info, sw);
  listParts.set(row, { name, badge, meta, input });
  return row;
}

function updateListRow(row: HTMLElement, l: ListRow): void {
  const parts = listParts.get(row);
  if (!parts) return;
  parts.name.textContent = l.title;
  parts.badge.textContent = msg(GROUP_KEY[l.group]) || l.group;
  // A switch in flight shows what the user asked for until its own answer arrives; a render from
  // older data would flip it back mid-toggle.
  if (row.getAttribute('aria-busy') !== 'true') parts.input.checked = l.enabled;
  parts.input.setAttribute('aria-label', msg('options_enable_filter_list', [l.title]));
  const count = l.ruleCount.toLocaleString();
  const state = listRowState(l, lists.paused);
  // The user asked for this list and Chrome refused to load it. Saying so is the whole point —
  // the toggle used to read "on" while the rules were not there. Paused is not that: nothing
  // is loaded then by design, and the page says why at the top.
  setStatus(
    parts.meta,
    state === 'refused'
      ? msg('options_list_not_active', [count])
      : state === 'paused'
        ? msg('options_list_paused', [count])
        : msg('options_list_rule_count', [count]),
    state === 'refused',
  );
}

async function toggleList(id: string, row: HTMLElement): Promise<void> {
  const parts = listParts.get(row);
  if (!parts) return;
  const wanted = parts.input.checked;
  // aria-busy rather than `disabled`: disabling the focused switch sent focus to <body>.
  row.setAttribute('aria-busy', 'true');
  const ticket = ++lists.tickets;
  lists.lastWrite = ticket;
  lists.writes++;
  let data: ListsData | null = null;
  try {
    data = await request<ListsData>({ type: 'lists:setEnabled', id, enabled: wanted });
  } finally {
    lists.writes--;
    row.removeAttribute('aria-busy');
  }
  if (!data) {
    parts.input.checked = !wanted;
    const title = lists.rows.find((r) => r.id === id)?.title ?? id;
    setStatus(parts.meta, msg('options_list_toggle_failed', [title]), true);
    return;
  }
  // The answer is computed after the ruleset sync; the storage event that fires before it is
  // not. Render only the newest toggle's answer — an older one would flip the newer switch
  // back until its own answer arrived.
  if (ticket === lists.lastWrite && ticket > lists.shown) {
    lists.shown = ticket;
    applyRows(data.lists, typeof data.paused === 'boolean' ? data.paused : lists.paused, data.degraded);
    renderOverview();
  }
}

// --- YouTube ------------------------------------------------------------------

async function loadYoutubeOptions(): Promise<void> {
  const data = await request<PopupData>({ type: 'popup:get' });
  if (!data) return;
  const sponsored = $<HTMLInputElement>('ytSponsored');
  const shorts = $<HTMLInputElement>('ytShorts');
  const sponsorBlock = $<HTMLInputElement>('ytSponsorBlock');
  sponsored.checked = data.youtubeBlockSponsored;
  shorts.checked = data.youtubeBlockShorts;
  sponsorBlock.checked = data.youtubeSponsorBlock;
  sponsored.disabled = data.paused;
  shorts.disabled = data.paused;
  sponsorBlock.disabled = data.paused;
}

async function saveYoutubeOptions(changed: HTMLInputElement): Promise<void> {
  const data = await request<PopupData>({
    type: 'popup:setYoutubeOptions',
    youtubeBlockSponsored: $<HTMLInputElement>('ytSponsored').checked,
    youtubeBlockShorts: $<HTMLInputElement>('ytShorts').checked,
    youtubeSponsorBlock: $<HTMLInputElement>('ytSponsorBlock').checked,
  });
  setStatus($('youtubeStatus'), data ? '' : msg('options_setting_not_saved'), !data);
  if (!data) changed.checked = !changed.checked;
}

for (const id of ['ytSponsored', 'ytShorts', 'ytSponsorBlock']) {
  const input = $<HTMLInputElement>(id);
  input.addEventListener('change', () => {
    void saveYoutubeOptions(input);
  });
}

// --- SponsorBlock categories ------------------------------------------------
// All-or-nothing skipping was the gap here: two of the seven categories fired without ever
// appearing in the UI. Absent settings mean "enabled", so an older settings blob keeps the
// behavior it had rather than silently losing coverage.

type SponsorCategory = SponsorCategoriesData['categories'][number];

interface CategoryParts {
  title: HTMLElement;
  meta: HTMLElement;
  input: HTMLInputElement;
}
const categoryParts = new WeakMap<HTMLElement, CategoryParts>();

function categoryLabel(c: SponsorCategory): string {
  // The service worker sends English labels; translate them here. Falling back to what it
  // sent means a category added upstream still shows rather than rendering blank.
  return msg(`options_sponsor_cat_${c.id}_label`) || c.label;
}

function createCategoryRow(c: SponsorCategory): HTMLElement {
  const row = document.createElement('div');
  row.className = 'list-item';
  const info = document.createElement('div');
  info.className = 'list-info';
  const title = document.createElement('div');
  title.className = 'list-title';
  const meta = document.createElement('div');
  meta.className = 'list-meta';
  info.append(title, meta);

  const sw = document.createElement('label');
  sw.className = 'switch';
  const input = document.createElement('input');
  input.type = 'checkbox';
  const slider = document.createElement('span');
  slider.className = 'slider';
  sw.append(input, slider);
  input.addEventListener('change', async () => {
    const wanted = input.checked;
    row.setAttribute('aria-busy', 'true');
    const data = await request<SponsorCategoriesData>({
      type: 'sponsorblock:setCategory',
      category: c.id,
      enabled: wanted,
    });
    row.removeAttribute('aria-busy');
    if (!data) {
      input.checked = !wanted;
      setStatus($('sponsorCategoriesNote'), msg('options_setting_not_saved'), true);
      return;
    }
    renderSponsorCategories(data);
  });

  row.append(info, sw);
  categoryParts.set(row, { title, meta, input });
  return row;
}

function updateCategoryRow(row: HTMLElement, c: SponsorCategory): void {
  const parts = categoryParts.get(row);
  if (!parts) return;
  const label = categoryLabel(c);
  parts.title.textContent = label;
  parts.meta.textContent = msg(`options_sponsor_cat_${c.id}_hint`) || c.hint;
  parts.input.checked = c.enabled;
  // The translated label, not the worker's English one: a zh screen reader announced
  // "跳过 Self-promotion 片段" beside the row that read 自我推广.
  parts.input.setAttribute('aria-label', msg('options_skip_segments', [label]));
}

function renderSponsorCategories(data: SponsorCategoriesData): void {
  syncRows($('sponsorCategories'), data.categories, (c) => c.id, createCategoryRow, updateCategoryRow);
  setStatus(
    $('sponsorCategoriesNote'),
    data.allOff ? msg('options_sponsor_all_categories_off') : '',
  );
}

async function loadSponsorCategories(): Promise<void> {
  const data = await request<SponsorCategoriesData>({ type: 'sponsorblock:getCategories' });
  if (data) renderSponsorCategories(data);
  else if (!$('sponsorCategories').querySelector('.list-item')) {
    setStatus($('sponsorCategories'), msg('options_load_failed'), true);
  }
}

// --- Dark mode ------------------------------------------------------------------

function renderDarkOverrides(data: DarkModeData): void {
  const container = $('darkOverrides');
  const entries = Object.entries(data.siteOverrides).sort(([a], [b]) => a.localeCompare(b));
  if (!entries.length) {
    container.textContent = msg('options_none_yet');
    return;
  }
  syncRows(
    container,
    entries,
    ([host]) => host,
    ([host]) => {
      const row = document.createElement('div');
      row.className = 'list-item';
      const info = document.createElement('div');
      info.className = 'list-info';
      const title = document.createElement('div');
      title.className = 'list-title';
      title.textContent = host;
      const meta = document.createElement('div');
      meta.className = 'list-meta';
      info.append(title, meta);
      const clear = document.createElement('button');
      clear.type = 'button';
      clear.className = 'override-clear';
      clear.textContent = msg('options_clear');
      clear.addEventListener('click', async () => {
        const next = await request<DarkModeData>({
          type: 'darkmode:setSiteOverride',
          hostname: host,
          override: null,
        });
        if (!next) {
          setStatus($('darkActionHint'), msg('options_setting_not_saved'), true);
          return;
        }
        renderDarkMode(next);
        moveFocusAfterRemoval(container, $('darkOverrideHost'));
      });
      row.append(info, clear);
      return row;
    },
    (row, [, override]) => {
      const meta = row.querySelector('.list-meta');
      if (meta) meta.textContent = msg(override === 'on' ? 'options_force_on' : 'options_force_off');
    },
  );
}

async function loadDarkMode(): Promise<void> {
  const data = await request<DarkModeData>({ type: 'darkmode:get' });
  if (!data) {
    setStatus($('darkLicenseStatus'), msg('options_load_failed'), true);
    return;
  }
  renderDarkMode(data);
}

function renderDarkMode(data: DarkModeData): void {
  const toggle = $<HTMLInputElement>('darkModeEnabled');
  const status = $('darkLicenseStatus');
  const buy = $<HTMLButtonElement>('darkBuy');
  const hint = $('darkActionHint');
  const dev = $<HTMLButtonElement>('darkDevUnlock');

  buy.textContent = msg('options_buy_dark_mode_price', [data.license.priceLabel]);
  toggle.checked = data.paid && data.enabled;
  toggle.disabled = !data.paid;
  status.classList.remove('list-warn');

  if (data.paid) {
    // One whole sentence per state rather than glued-together fragments: "(offline grace)" and
    // the email are not separable clauses in every language.
    const email = data.license.email;
    if (data.license.grace) {
      status.textContent = email
        ? msg('options_license_paid_grace_email', [email])
        : msg('options_license_paid_grace');
    } else {
      status.textContent = email
        ? msg('options_license_paid_email', [email])
        : msg('options_license_paid');
    }
    setStatus(
      hint,
      msg(data.license.configured ? 'options_license_refresh_hint' : 'options_license_local_cache_hint'),
    );
  } else {
    status.textContent = msg('options_license_free');
    setStatus(
      hint,
      msg(
        data.license.configured
          ? 'options_license_buy_hint'
          : data.license.unpacked
            ? 'options_license_unpacked_hint'
            : 'options_license_unavailable_hint',
      ),
    );
  }

  // A paid user was still offered "Buy dark mode ($2)" as the primary action, one click from a
  // second checkout. Restore and Refresh stay: they are how a license is recovered.
  buy.hidden = data.paid;
  buy.disabled = !data.license.configured && !data.license.unpacked;
  const restore = $<HTMLButtonElement>('darkRestore');
  restore.disabled = !data.license.configured;
  if (!data.license.configured) {
    buy.title = msg('options_extensionpay_not_configured');
    restore.title = msg('options_extensionpay_not_configured');
  } else {
    buy.title = '';
    restore.title = '';
  }

  // Store / CWS: never show. Also hide once paid (popup already does).
  dev.hidden = !data.license.unpacked || data.paid;
  renderDarkOverrides(data);
}

async function loadVersion(): Promise<void> {
  const man = chrome.runtime.getManifest();
  $('ver').textContent = man.version;
}

$<HTMLInputElement>('darkModeEnabled').addEventListener('change', async () => {
  const toggle = $<HTMLInputElement>('darkModeEnabled');
  const wanted = toggle.checked;
  const data = await request<DarkModeData>({ type: 'darkmode:setEnabled', enabled: wanted });
  if (!data) {
    toggle.checked = !wanted;
    setStatus($('darkActionHint'), msg('options_setting_not_saved'), true);
    return;
  }
  void loadDarkMode();
});

/** Run a purchase action; its outcome is rendered after the reload so the reload cannot erase it. */
async function licenseAction(
  type: 'license:openCheckout' | 'license:openRestore',
  fallbackKey: string,
): Promise<void> {
  const r = await request<WorkerResult>({ type }, 1);
  await loadDarkMode();
  if (!r?.ok) setStatus($('darkActionHint'), workerError(r, fallbackKey), true);
}

$('darkBuy').addEventListener('click', () => {
  void licenseAction('license:openCheckout', 'options_checkout_unavailable');
});

$('darkRestore').addEventListener('click', () => {
  void licenseAction('license:openRestore', 'options_restore_unavailable');
});

$('darkRefresh').addEventListener('click', async () => {
  const r = await request<LicenseData>({ type: 'license:refresh' }, 1);
  await loadDarkMode();
  // Silent before: with ExtensionPay unreachable the cached state came back looking verified.
  if (!r) setStatus($('darkActionHint'), msg('options_license_refresh_failed'), true);
  else if (r.unreachable) setStatus($('darkActionHint'), msg('options_license_refresh_unreachable'), true);
});

$('darkDevUnlock').addEventListener('click', async () => {
  const r = await request<WorkerResult>({ type: 'license:devUnlock' }, 1);
  await loadDarkMode();
  // `r?.ok`, not "no error string": a null answer used to report "Dev unlock applied".
  if (r?.ok) setStatus($('darkActionHint'), msg('options_dev_unlock_applied'));
  else setStatus($('darkActionHint'), workerError(r, 'popup_dev_unlock_failed'), true);
});

$<HTMLFormElement>('darkOverrideForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $<HTMLInputElement>('darkOverrideHost');
  const host = input.value.trim();
  const raw = $<HTMLSelectElement>('darkOverrideValue').value;
  if (!host) return;
  const override: DarkModeSiteOverride = raw === 'off' ? 'off' : 'on';
  const data = await request<DarkModeData>({ type: 'darkmode:setSiteOverride', hostname: host, override });
  if (!data) {
    setStatus($('darkActionHint'), msg('options_setting_not_saved'), true);
    return;
  }
  input.value = '';
  renderDarkMode(data);
});

// The Options page is long-lived — a user typically leaves it open in a tab and changes the
// same toggles from the popup. Without this the stale form would silently write its old values
// back on the next edit (re-enabling SponsorBlock's network calls, for instance).
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes[STORAGE_KEY]) return;
  void loadOverview();
  void loadYoutubeOptions();
  void loadDarkMode();
  void loadSiteRules();
  void loadCustomFilters();
  void loadSponsorCategories();
});

// Storage events do not fire while the page is hidden in some cases; re-sync on return.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  void loadOverview();
  void loadYoutubeOptions();
  void loadDarkMode();
  void loadCustomFilters();
});

/** After a row's own button removed it, keep keyboard focus in the list instead of <body>. */
function moveFocusAfterRemoval(container: HTMLElement, fallback: HTMLElement): void {
  if (document.activeElement && document.activeElement !== document.body) return;
  const next = container.querySelector<HTMLElement>('button');
  (next ?? fallback).focus();
}

// --- Site rules ------------------------------------------------------------
// One list for every per-site decision. Repair steps and the allowlist were previously
// invisible outside the popup, so a site fixed months ago on another page could not be found.

interface SiteRuleRow {
  host: string;
  kind: 'fix' | 'allowlist';
  level: SiteFixLevel | null;
  /** Another entry that also applies to this host (a parent domain). */
  coveredBy: string | null;
}

let siteRules: SiteRulesData | null = null;

async function loadSiteRules(): Promise<void> {
  const data = await request<SiteRulesData>({ type: 'sitefix:list' });
  if (!data) {
    if (!siteRules) setStatus($('siteRules'), msg('options_site_rules_load_failed'), true);
    return;
  }
  renderSiteRules(data);
}

function siteRuleRows(data: SiteRulesData): SiteRuleRow[] {
  const all = [...data.allowlist, ...Object.keys(data.siteFixes)];
  const parentOf = (host: string): string | null =>
    all.find((other) => other !== host && siteRuleCovers(other, host)) ?? null;
  return [
    ...Object.entries(data.siteFixes).map(([host, level]) => ({
      host,
      kind: 'fix' as const,
      level,
      coveredBy: parentOf(host),
    })),
    ...data.allowlist.map((host) => ({
      host,
      kind: 'allowlist' as const,
      level: null,
      coveredBy: parentOf(host),
    })),
  ].sort((a, b) => a.host.localeCompare(b.host) || a.kind.localeCompare(b.kind));
}

function siteRuleMeta(row: SiteRuleRow): string {
  const label =
    row.kind === 'allowlist'
      ? msg('options_no_blocking_at_all')
      : msg(SITE_FIX_KEY[row.level!]) || siteFixLabel(row.level);
  const parts = [label];
  // A host the suffix heuristics cannot treat as a site (go.dev, an intranet name) gets a rule
  // for that address alone; everything else also covers its subdomains.
  if (siteRuleScope(row.host) === 'exact') parts.push(msg('options_site_rule_exact_scope'));
  // Removing this row does not end the rule for this host while a parent's entry still applies.
  if (row.coveredBy) parts.push(msg('options_site_rule_covered_by', [row.coveredBy]));
  return parts.join(' · ');
}

function renderSiteRules(data: SiteRulesData): void {
  siteRules = data;
  const container = $('siteRules');
  const rows = siteRuleRows(data);
  if (!rows.length) {
    container.textContent = msg('options_none_yet');
    return;
  }
  syncRows(
    container,
    rows,
    (r) => `${r.kind}:${r.host}`,
    (r) => {
      const item = document.createElement('div');
      item.className = 'list-item';
      const info = document.createElement('div');
      info.className = 'list-info';
      const title = document.createElement('div');
      title.className = 'list-title';
      title.textContent = r.host;
      const meta = document.createElement('div');
      meta.className = 'list-meta';
      info.append(title, meta);
      const clear = document.createElement('button');
      clear.type = 'button';
      clear.className = 'override-clear';
      clear.textContent = msg('options_remove');
      clear.setAttribute('aria-label', msg('options_remove_site_rule', [r.host]));
      clear.addEventListener('click', () => {
        void removeSiteRule(r.host, r.kind);
      });
      item.append(info, clear);
      return item;
    },
    (item, r) => {
      const meta = item.querySelector('.list-meta');
      if (meta) meta.textContent = siteRuleMeta(r);
    },
  );
}

/**
 * Remove exactly this row. The popup's messages clear every entry covering a host — right for
 * "turn blocking back on here", wrong for one row: removing shop.example.com took example.com
 * with it.
 */
async function removeSiteRule(host: string, kind: SiteRuleRow['kind']): Promise<void> {
  const error = $('siteRuleError');
  error.textContent = '';
  const data =
    kind === 'allowlist'
      ? await request<SiteRulesData & { applied?: boolean }>({ type: 'allowlist:remove', hostname: host })
      : await request<SiteRulesData>({ type: 'sitefix:remove', hostname: host });
  if (!data) {
    error.textContent = msg('options_site_rule_remove_failed', [host]);
    return;
  }
  // The row stays: Chrome refused, so the site is still unblocked.
  if ('applied' in data && data.applied === false) {
    error.textContent = msg('options_site_rule_remove_not_applied', [host]);
  }
  renderSiteRules(data);
  moveFocusAfterRemoval($('siteRules'), $('siteRuleHost'));
}

$<HTMLFormElement>('siteRuleForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $<HTMLInputElement>('siteRuleHost');
  const typed = input.value.trim();
  const error = $('siteRuleError');
  error.textContent = '';
  if (!typed) return;
  // Checked with the worker's own rule (site-rules.ts) first, and the entry kept, so a host it
  // would refuse can be corrected rather than vanishing.
  const host = siteRuleKeyFromInput(typed);
  if (!host) {
    error.textContent = msg('options_site_rule_invalid', [typed]);
    input.focus();
    return;
  }
  const choice = $<HTMLSelectElement>('siteRuleLevel').value;
  if (choice === 'allowlist') {
    const r = await request<SiteToggleData>({ type: 'popup:toggleSite', hostname: host, enabled: false });
    if (r?.applied === false) {
      // Nothing was stored. Keep the entry so trying again is one click.
      error.textContent = msg('options_site_rule_not_applied', [host]);
      input.focus();
      return;
    }
  } else {
    await request<PopupData>({ type: 'sitefix:set', hostname: host, level: choice as SiteFixLevel });
  }
  // Both answers describe the active tab, not this host, so confirm against the stored rules
  // before clearing what the user typed.
  const after = await request<SiteRulesData>({ type: 'sitefix:list' });
  if (after) renderSiteRules(after);
  const stored =
    choice === 'allowlist' ? after?.allowlist.includes(host) : after?.siteFixes[host] === choice;
  if (!stored) {
    error.textContent = msg('options_site_rule_add_failed', [host]);
    input.focus();
    return;
  }
  input.value = '';
});

// --- My filters ------------------------------------------------------------
// Raw text is the user's document: comments, ordering and half-finished lines all have to
// survive a round trip, so the editor saves the text verbatim and reports what did not parse
// rather than silently rewriting it.
//
// It is also not the only writer: the element picker appends from any tab. So the editor keeps
// the stored text it was loaded from, never overwrites unsaved typing, and merges on Save.

const custom = {
  /** The stored text the editor was last loaded from or saved as; null before the first load. */
  base: null as string | null,
  dirty: false,
  /** The stored text changed while the editor held unsaved edits. */
  changedElsewhere: false,
  count: 0,
  errors: 0,
  truncated: false,
  /** The status line reports a save just made, rather than the stored state. */
  saved: false,
  merged: false,
  failed: '',
};

function renderCustomErrors(data: CustomFiltersData): void {
  const box = $('customErrors');
  box.textContent = '';
  if (!data.errors.length) return;
  for (const err of data.errors) {
    const row = document.createElement('div');
    row.className = 'filter-error';
    row.textContent = msg('options_filter_error_line', [String(err.line), err.reason]);
    box.append(row);
  }
}

// Chrome's message format has no plural rules, so singular and plural are separate whole
// messages — a locale that needs a different split can still translate each one.
function renderCustomStatus(): void {
  const status = $('customStatus');
  if (custom.failed) return setStatus(status, custom.failed, true);
  if (custom.changedElsewhere) return setStatus(status, msg('options_custom_changed_elsewhere'), true);
  if (custom.base == null) return;
  const n = [custom.count.toLocaleString()];
  const one = custom.count === 1;
  // Paused, nothing applies. "N rules active" there contradicted the 0 on the rules card.
  const paused = lists.paused;
  const parts = [
    custom.saved
      ? paused
        ? msg(one ? 'options_custom_saved_paused_one' : 'options_custom_saved_paused_other', n)
        : msg(one ? 'options_custom_saved_one' : 'options_custom_saved_other', n)
      : paused
        ? msg(one ? 'options_custom_rules_paused_one' : 'options_custom_rules_paused_other', n)
        : msg(one ? 'options_custom_rules_active_one' : 'options_custom_rules_active_other', n),
  ];
  // Two complete sentences, not two fragments: word order inside each is the translator's.
  if (custom.saved && custom.errors) {
    parts.push(
      msg(custom.errors === 1 ? 'options_custom_lines_ignored_one' : 'options_custom_lines_ignored_other', [
        custom.errors.toLocaleString(),
      ]),
    );
  }
  if (custom.saved && custom.merged) parts.push(msg('options_custom_merged'));
  if (custom.truncated) parts.push(msg('options_custom_truncated'));
  setStatus(status, parts.join(' '), custom.truncated);
}

function adoptCustomFilters(data: CustomFiltersData, saved: boolean, merged = false): void {
  custom.base = data.text;
  custom.dirty = false;
  custom.changedElsewhere = false;
  custom.count = data.count;
  custom.errors = data.errors.length;
  custom.truncated = !!data.truncated;
  custom.saved = saved;
  custom.merged = merged;
  custom.failed = '';
  renderCustomErrors(data);
  renderCustomStatus();
}

async function loadCustomFilters(): Promise<void> {
  const data = await request<CustomFiltersData>({ type: 'customfilters:get' });
  if (!data) {
    if (custom.base == null) {
      custom.failed = msg('options_custom_load_failed');
      renderCustomStatus();
    }
    return;
  }
  // The storage event after this page's own Save, or an unrelated settings write: nothing to
  // take in, and the "Saved — …" confirmation must stay.
  if (data.text === custom.base) return;
  const box = $<HTMLTextAreaElement>('customFilters');
  if (custom.dirty) {
    // Never overwrite typing. The old guard was focus, so clicking elsewhere and then flipping
    // any popup switch wiped the unsaved text.
    custom.changedElsewhere = true;
    renderCustomStatus();
    return;
  }
  box.value = data.text;
  adoptCustomFilters(data, false);
}

$<HTMLTextAreaElement>('customFilters').addEventListener('input', () => {
  const box = $<HTMLTextAreaElement>('customFilters');
  custom.dirty = box.value !== custom.base;
  // Typed back to what was stored while something else changed it: take the newer text now.
  if (!custom.dirty && custom.changedElsewhere) void loadCustomFilters();
});

window.addEventListener('beforeunload', (e) => {
  if (custom.dirty) e.preventDefault();
});

$<HTMLButtonElement>('customSave').addEventListener('click', async () => {
  const box = $<HTMLTextAreaElement>('customFilters');
  const mine = box.value;
  // Saving the editor's copy verbatim deleted every rule the picker added since it was loaded.
  const stored = await request<CustomFiltersData>({ type: 'customfilters:get' });
  if (!stored) {
    custom.failed = msg('options_custom_save_failed');
    renderCustomStatus();
    return;
  }
  let text = mine;
  let merged = false;
  if (custom.base != null && stored.text !== custom.base) {
    const m = mergeFilterText(custom.base, mine, stored.text);
    text = m.text;
    merged = m.added > 0 || m.removed > 0;
  }
  const data = await request<CustomFiltersData>({ type: 'customfilters:set', text });
  if (!data) {
    custom.failed = msg('options_custom_save_failed');
    renderCustomStatus();
    return;
  }
  // Typing that happened during the round trip stays in the box and stays unsaved.
  const typedSince = box.value !== mine;
  if (!typedSince) box.value = data.text;
  adoptCustomFilters(data, true, merged);
  custom.dirty = typedSince;
});

// --- Backup ----------------------------------------------------------------

// Filename, not prose: it stays the same in every locale and is passed into the message.
const BACKUP_FILENAME = 'stampstack-settings.json';

function backupStatus(text: string, warn = false): void {
  setStatus($('backupStatus'), text, warn);
}

$<HTMLButtonElement>('exportBtn').addEventListener('click', async () => {
  const r = await request<{ json: string }>({ type: 'settings:export' });
  if (!r) {
    backupStatus(msg('options_export_failed'), true);
    return;
  }
  // Object URL rather than a data: URL — settings can exceed data-URL length limits once a
  // user has a few hundred allowlist entries.
  const url = URL.createObjectURL(new Blob([r.json], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = BACKUP_FILENAME;
  a.click();
  URL.revokeObjectURL(url);
  backupStatus(msg('options_exported_file', [BACKUP_FILENAME]));
});

$<HTMLButtonElement>('importBtn').addEventListener('click', () => {
  $<HTMLInputElement>('importFile').click();
});

$<HTMLInputElement>('importFile').addEventListener('change', async (e) => {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  const json = await file.text();
  const r = await request<SettingsImportResult & { code?: string }>({ type: 'settings:import', json }, 1);
  if (!r?.ok) {
    backupStatus(workerError(r, 'options_import_failed'), true);
    return;
  }
  // Fields the file had with the wrong type were left as they were, and filters over the cap
  // were cut; say so, rather than reporting a clean import.
  const parts = [
    r.ignored?.length
      ? msg('options_settings_imported_ignored', [r.ignored.join(', ')])
      : msg('options_settings_imported'),
  ];
  if (r.truncated) parts.push(msg('options_import_filters_truncated'));
  backupStatus(parts.join(' '), !!r.ignored?.length || !!r.truncated);
  void loadOverview();
  void loadYoutubeOptions();
  void loadDarkMode();
  void loadSiteRules();
  void loadCustomFilters();
  void loadSponsorCategories();
});

// Once, before anything loads: the loaders replace container contents afterwards, so this
// must not run again or it would overwrite rendered rows with their placeholder text.
applyI18n();

void loadOverview();
void loadYoutubeOptions();
void loadDarkMode();
void loadSiteRules();
void loadCustomFilters();
void loadSponsorCategories();
void loadVersion();
