// Options page: filter-list management, YouTube features, dark mode, and stats.

import type {
  Message,
  ListsData,
  StatsData,
  ListGroup,
  PopupData,
  DarkModeData,
  DarkModeSiteOverride,
  SiteRulesData,
  SiteFixLevel,
  CustomFiltersData,
  SponsorCategoriesData,
} from '../shared/types.js';
import { siteFixLabel } from '../shared/site-fix.js';
import { listAge } from '../shared/list-age.js';
import { applyI18n, msg } from '../shared/i18n.js';
import { STORAGE_KEY } from '../shared/constants.js';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

function send(message: Message): Promise<unknown> {
  return chrome.runtime.sendMessage(message);
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

async function loadStats(): Promise<void> {
  const s = (await send({ type: 'stats:get' })) as StatsData;
  // `active`, not `enabled`: on a profile whose static-rule pool is exhausted these differ,
  // and the requested total would overstate the protection in force.
  const activeRules = s.paused
    ? 0
    : s.lists.filter((l) => l.active).reduce((n, l) => n + l.ruleCount, 0);
  $('statTotal').textContent = s.statsReliable
    ? s.blockedTotal.toLocaleString()
    : msg('options_stat_unavailable');
  $('statRules').textContent = activeRules.toLocaleString();
  const rulesLabel = document.querySelector('#statRules')?.parentElement?.querySelector('.card-label');
  if (rulesLabel) {
    rulesLabel.textContent = msg(
      s.degraded ? 'options_rules_active_reduced' : 'options_network_rules_active',
    );
  }
  $('statRegex').textContent = String(s.regexRulesUsed);
  const totalLabel = document.querySelector('#statTotal')?.parentElement?.querySelector('.card-label');
  if (totalLabel) {
    totalLabel.textContent = msg(
      s.statsReliable ? 'options_requests_blocked' : 'options_blocked_count_dev_only',
    );
  }

  // Lists are frozen at build time, so their age is the one thing about coverage the UI
  // could not previously say. Left unsaid, protection decays with nothing to show for it.
  const age = listAge(s.listsGeneratedAt, Date.now());
  const ageEl = $('listAge');
  ageEl.textContent = age.text;
  ageEl.classList.toggle('list-warn', age.level === 'stale');
}

function listItem(l: ListsData['lists'][number]): HTMLElement {
  const row = document.createElement('div');
  row.className = 'list-item';

  const info = document.createElement('div');
  info.className = 'list-info';
  const title = document.createElement('div');
  title.className = 'list-title';
  title.textContent = l.title;
  const badge = document.createElement('span');
  badge.className = 'badge';
  badge.textContent = msg(GROUP_KEY[l.group]) || l.group;
  title.appendChild(badge);
  const meta = document.createElement('div');
  meta.className = 'list-meta';
  if (l.enabled && !l.active) {
    // The user asked for this list and Chrome refused to load it. Saying so is the whole
    // point — the toggle used to read "on" while the rules were not there.
    meta.classList.add('list-warn');
    meta.textContent = msg('options_list_not_active', [l.ruleCount.toLocaleString()]);
  } else {
    meta.textContent = msg('options_list_rule_count', [l.ruleCount.toLocaleString()]);
  }
  info.append(title, meta);

  const sw = document.createElement('label');
  sw.className = 'switch';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = l.enabled;
  input.setAttribute('aria-label', msg('options_enable_filter_list', [l.title]));
  const slider = document.createElement('span');
  slider.className = 'slider';
  sw.append(input, slider);

  input.addEventListener('change', async () => {
    input.disabled = true;
    await send({ type: 'lists:setEnabled', id: l.id, enabled: input.checked });
    input.disabled = false;
    void loadStats();
  });

  row.append(info, sw);
  return row;
}

async function loadLists(): Promise<void> {
  const data = (await send({ type: 'lists:get' })) as ListsData;
  const container = $('lists');
  container.textContent = '';
  if (!data.lists.length) {
    container.textContent = msg('options_no_filter_lists');
    return;
  }
  for (const l of data.lists) container.appendChild(listItem(l));
}

async function loadYoutubeOptions(): Promise<void> {
  const data = (await send({ type: 'popup:get' })) as PopupData;
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

async function saveYoutubeOptions(): Promise<void> {
  const sponsored = $<HTMLInputElement>('ytSponsored');
  const shorts = $<HTMLInputElement>('ytShorts');
  const sponsorBlock = $<HTMLInputElement>('ytSponsorBlock');
  await send({
    type: 'popup:setYoutubeOptions',
    youtubeBlockSponsored: sponsored.checked,
    youtubeBlockShorts: shorts.checked,
    youtubeSponsorBlock: sponsorBlock.checked,
  });
}

// --- SponsorBlock categories ------------------------------------------------
// All-or-nothing skipping was the gap here: two of the seven categories fired without ever
// appearing in the UI. Absent settings mean "enabled", so an older settings blob keeps the
// behavior it had rather than silently losing coverage.

function categoryRow(c: SponsorCategoriesData['categories'][number]): HTMLElement {
  const row = document.createElement('div');
  row.className = 'list-item';
  const info = document.createElement('div');
  info.className = 'list-info';
  const title = document.createElement('div');
  title.className = 'list-title';
  title.textContent = c.label;
  const meta = document.createElement('div');
  meta.className = 'list-meta';
  meta.textContent = c.hint;
  info.append(title, meta);

  const sw = document.createElement('label');
  sw.className = 'switch';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = c.enabled;
  input.setAttribute('aria-label', msg('options_skip_segments', [c.label]));
  const slider = document.createElement('span');
  slider.className = 'slider';
  sw.append(input, slider);
  input.addEventListener('change', async () => {
    input.disabled = true;
    const data = (await send({
      type: 'sponsorblock:setCategory',
      category: c.id,
      enabled: input.checked,
    })) as SponsorCategoriesData | null;
    input.disabled = false;
    if (data) renderSponsorCategories(data);
  });

  row.append(info, sw);
  return row;
}

function renderSponsorCategories(data: SponsorCategoriesData): void {
  const container = $('sponsorCategories');
  container.textContent = '';
  for (const c of data.categories) container.append(categoryRow(c));
  $('sponsorCategoriesNote').textContent = data.allOff
    ? msg('options_sponsor_all_categories_off')
    : '';
}

async function loadSponsorCategories(): Promise<void> {
  const data = (await send({ type: 'sponsorblock:getCategories' })) as SponsorCategoriesData | null;
  if (data) renderSponsorCategories(data);
}

function renderDarkOverrides(data: DarkModeData): void {
  const container = $('darkOverrides');
  container.textContent = '';
  const entries = Object.entries(data.siteOverrides);
  if (!entries.length) {
    container.textContent = msg('options_none_yet');
    return;
  }
  for (const [host, override] of entries.sort(([a], [b]) => a.localeCompare(b))) {
    const row = document.createElement('div');
    row.className = 'list-item';
    const info = document.createElement('div');
    info.className = 'list-info';
    const title = document.createElement('div');
    title.className = 'list-title';
    title.textContent = host;
    const meta = document.createElement('div');
    meta.className = 'list-meta';
    meta.textContent = msg(override === 'on' ? 'options_force_on' : 'options_force_off');
    info.append(title, meta);
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'override-clear';
    clear.textContent = msg('options_clear');
    clear.addEventListener('click', async () => {
      await send({ type: 'darkmode:setSiteOverride', hostname: host, override: null });
      void loadDarkMode();
    });
    row.append(info, clear);
    container.appendChild(row);
  }
}

async function loadDarkMode(): Promise<void> {
  const data = (await send({ type: 'darkmode:get' })) as DarkModeData;
  const toggle = $<HTMLInputElement>('darkModeEnabled');
  const status = $('darkLicenseStatus');
  const buy = $<HTMLButtonElement>('darkBuy');
  const hint = $('darkActionHint');
  const dev = $<HTMLButtonElement>('darkDevUnlock');

  buy.textContent = msg('options_buy_dark_mode_price', [data.license.priceLabel]);
  toggle.checked = data.paid && data.enabled;
  toggle.disabled = !data.paid;

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
    hint.textContent = msg(
      data.license.configured
        ? 'options_license_refresh_hint'
        : 'options_license_local_cache_hint',
    );
  } else {
    status.textContent = msg('options_license_free');
    hint.textContent = msg(
      data.license.configured
        ? 'options_license_buy_hint'
        : data.license.unpacked
          ? 'options_license_unpacked_hint'
          : 'options_license_unavailable_hint',
    );
  }

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

$<HTMLInputElement>('ytSponsored').addEventListener('change', () => {
  void saveYoutubeOptions();
});
$<HTMLInputElement>('ytShorts').addEventListener('change', () => {
  void saveYoutubeOptions();
});
$<HTMLInputElement>('ytSponsorBlock').addEventListener('change', () => {
  void saveYoutubeOptions();
});

$<HTMLInputElement>('darkModeEnabled').addEventListener('change', async () => {
  const toggle = $<HTMLInputElement>('darkModeEnabled');
  await send({ type: 'darkmode:setEnabled', enabled: toggle.checked });
  void loadDarkMode();
});

$('darkBuy').addEventListener('click', async () => {
  const r = (await send({ type: 'license:openCheckout' })) as { ok: boolean; error?: string };
  if (!r?.ok && r?.error) $('darkActionHint').textContent = r.error;
  void loadDarkMode();
});

$('darkRestore').addEventListener('click', async () => {
  const r = (await send({ type: 'license:openRestore' })) as { ok: boolean; error?: string };
  if (!r?.ok && r?.error) $('darkActionHint').textContent = r.error;
  void loadDarkMode();
});

$('darkRefresh').addEventListener('click', async () => {
  await send({ type: 'license:refresh' });
  void loadDarkMode();
});

$('darkDevUnlock').addEventListener('click', async () => {
  const r = (await send({ type: 'license:devUnlock' })) as { ok: boolean; error?: string };
  if (!r?.ok && r?.error) $('darkActionHint').textContent = r.error;
  else $('darkActionHint').textContent = msg('options_dev_unlock_applied');
  void loadDarkMode();
});

$<HTMLFormElement>('darkOverrideForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const host = $<HTMLInputElement>('darkOverrideHost').value.trim();
  const raw = $<HTMLSelectElement>('darkOverrideValue').value;
  if (!host) return;
  const override: DarkModeSiteOverride = raw === 'off' ? 'off' : 'on';
  await send({ type: 'darkmode:setSiteOverride', hostname: host, override });
  $<HTMLInputElement>('darkOverrideHost').value = '';
  void loadDarkMode();
});

// The Options page is long-lived — a user typically leaves it open in a tab and changes the
// same toggles from the popup. Without this the stale form would silently write its old values
// back on the next edit (re-enabling SponsorBlock's network calls, for instance).
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes[STORAGE_KEY]) return;
  void loadStats();
  void loadLists();
  void loadYoutubeOptions();
  void loadDarkMode();
  void loadSiteRules();
  void loadCustomFilters();
  void loadSponsorCategories();
});

// Storage events do not fire while the page is hidden in some cases; re-sync on return.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  void loadStats();
  void loadYoutubeOptions();
  void loadDarkMode();
});


// --- Site rules ------------------------------------------------------------
// One list for every per-site decision. Repair steps and the allowlist were previously
// invisible outside the popup, so a site fixed months ago on another page could not be found.

async function loadSiteRules(): Promise<void> {
  const data = (await send({ type: 'sitefix:list' })) as SiteRulesData | null;
  const container = $('siteRules');
  container.textContent = '';
  if (!data) {
    container.textContent = msg('options_site_rules_load_failed');
    return;
  }

  const rows: { host: string; label: string; kind: 'fix' | 'allowlist' }[] = [
    ...Object.entries(data.siteFixes).map(([host, level]) => ({
      host,
      label: msg(SITE_FIX_KEY[level]) || siteFixLabel(level),
      kind: 'fix' as const,
    })),
    ...data.allowlist.map((host) => ({
      host,
      label: msg('options_no_blocking_at_all'),
      kind: 'allowlist' as const,
    })),
  ].sort((a, b) => a.host.localeCompare(b.host));

  if (!rows.length) {
    container.textContent = msg('options_none_yet');
    return;
  }

  for (const row of rows) {
    const item = document.createElement('div');
    item.className = 'list-item';
    const info = document.createElement('div');
    info.className = 'list-info';
    const title = document.createElement('div');
    title.className = 'list-title';
    title.textContent = row.host;
    const meta = document.createElement('div');
    meta.className = 'list-meta';
    meta.textContent = row.label;
    info.append(title, meta);

    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'override-clear';
    clear.textContent = msg('options_remove');
    clear.addEventListener('click', async () => {
      if (row.kind === 'allowlist') {
        await send({ type: 'popup:toggleSite', hostname: row.host, enabled: true });
      } else {
        await send({ type: 'sitefix:set', hostname: row.host, level: null });
      }
      void loadSiteRules();
    });

    item.append(info, clear);
    container.append(item);
  }
}

$<HTMLFormElement>('siteRuleForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $<HTMLInputElement>('siteRuleHost');
  const host = input.value.trim();
  if (!host) return;
  const choice = $<HTMLSelectElement>('siteRuleLevel').value;
  if (choice === 'allowlist') {
    await send({ type: 'popup:toggleSite', hostname: host, enabled: false });
  } else {
    await send({ type: 'sitefix:set', hostname: host, level: choice as SiteFixLevel });
  }
  input.value = '';
  void loadSiteRules();
});

// --- My filters ------------------------------------------------------------
// Raw text is the user's document: comments, ordering and half-finished lines all have to
// survive a round trip, so the editor saves the text verbatim and reports what did not parse
// rather than silently rewriting it.

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

async function loadCustomFilters(): Promise<void> {
  const data = (await send({ type: 'customfilters:get' })) as CustomFiltersData | null;
  if (!data) return;
  const box = $<HTMLTextAreaElement>('customFilters');
  // Never clobber an in-progress edit when a storage event triggers a reload.
  if (document.activeElement !== box) box.value = data.text;
  $('customStatus').textContent = rulesActiveText(data.count);
  renderCustomErrors(data);
}

// Chrome's message format has no plural rules, so singular and plural are separate whole
// messages — a locale that needs a different split can still translate each one.
function rulesActiveText(count: number): string {
  const key = count === 1 ? 'options_custom_rules_active_one' : 'options_custom_rules_active_other';
  return msg(key, [count.toLocaleString()]);
}

$<HTMLButtonElement>('customSave').addEventListener('click', async () => {
  const text = $<HTMLTextAreaElement>('customFilters').value;
  const data = (await send({ type: 'customfilters:set', text })) as CustomFiltersData | null;
  if (!data) return;
  // Two complete sentences, not two fragments: word order inside each is the translator's.
  const saved = msg(
    data.count === 1 ? 'options_custom_saved_one' : 'options_custom_saved_other',
    [data.count.toLocaleString()],
  );
  const ignored = data.errors.length
    ? msg(
        data.errors.length === 1
          ? 'options_custom_lines_ignored_one'
          : 'options_custom_lines_ignored_other',
        [data.errors.length.toLocaleString()],
      )
    : '';
  $('customStatus').textContent = ignored ? `${saved} ${ignored}` : saved;
  renderCustomErrors(data);
});

// --- Backup ----------------------------------------------------------------

// Filename, not prose: it stays the same in every locale and is passed into the message.
const BACKUP_FILENAME = 'stampstack-settings.json';

function backupStatus(text: string): void {
  $('backupStatus').textContent = text;
}

$<HTMLButtonElement>('exportBtn').addEventListener('click', async () => {
  const r = (await send({ type: 'settings:export' })) as { json: string } | null;
  if (!r) {
    backupStatus(msg('options_export_failed'));
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
  const r = (await send({ type: 'settings:import', json })) as
    | { ok: boolean; error?: string }
    | null;
  if (!r?.ok) {
    backupStatus(r?.error ?? msg('options_import_failed'));
    return;
  }
  backupStatus(msg('options_settings_imported'));
  void loadStats();
  void loadLists();
  void loadYoutubeOptions();
  void loadDarkMode();
  void loadSiteRules();
  void loadCustomFilters();
});

// Once, before anything loads: the loaders replace container contents afterwards, so this
// must not run again or it would overwrite rendered rows with their placeholder text.
applyI18n();

void loadStats();
void loadLists();
void loadYoutubeOptions();
void loadDarkMode();
void loadSiteRules();
void loadCustomFilters();
void loadSponsorCategories();
void loadVersion();
