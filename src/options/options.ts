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
import { STORAGE_KEY } from '../shared/constants.js';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

function send(msg: Message): Promise<unknown> {
  return chrome.runtime.sendMessage(msg);
}

const GROUP_LABEL: Record<ListGroup, string> = {
  ads: 'Ads',
  privacy: 'Privacy',
  security: 'Security',
  annoyances: 'Annoyances',
};

async function loadStats(): Promise<void> {
  const s = (await send({ type: 'stats:get' })) as StatsData;
  // `active`, not `enabled`: on a profile whose static-rule pool is exhausted these differ,
  // and the requested total would overstate the protection in force.
  const activeRules = s.paused
    ? 0
    : s.lists.filter((l) => l.active).reduce((n, l) => n + l.ruleCount, 0);
  $('statTotal').textContent = s.statsReliable ? s.blockedTotal.toLocaleString() : 'n/a';
  $('statRules').textContent = activeRules.toLocaleString();
  const rulesLabel = document.querySelector('#statRules')?.parentElement?.querySelector('.card-label');
  if (rulesLabel) {
    rulesLabel.textContent = s.degraded ? 'rules active (reduced)' : 'network rules active';
  }
  $('statRegex').textContent = String(s.regexRulesUsed);
  const totalLabel = document.querySelector('#statTotal')?.parentElement?.querySelector('.card-label');
  if (totalLabel) {
    totalLabel.textContent = s.statsReliable ? 'requests blocked' : 'blocked count (dev only)';
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
  badge.textContent = GROUP_LABEL[l.group] ?? l.group;
  title.appendChild(badge);
  const meta = document.createElement('div');
  meta.className = 'list-meta';
  if (l.enabled && !l.active) {
    // The user asked for this list and Chrome refused to load it. Saying so is the whole
    // point — the toggle used to read "on" while the rules were not there.
    meta.classList.add('list-warn');
    meta.textContent =
      `Not active — Chrome's shared rule limit is full. ${l.ruleCount.toLocaleString()} ` +
      'network rules are not loaded; element hiding for this list still works.';
  } else {
    meta.textContent = `${l.ruleCount.toLocaleString()} network rules · cosmetics follow this toggle`;
  }
  info.append(title, meta);

  const sw = document.createElement('label');
  sw.className = 'switch';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = l.enabled;
  input.setAttribute('aria-label', `Enable filter list ${l.title}`);
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
    container.textContent = 'No filter lists available. Reinstall StampStack or contact support.';
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
  input.setAttribute('aria-label', `Skip ${c.label} segments`);
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
    ? 'Every category is off — StampStack will not contact the SponsorBlock API.'
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
    container.textContent = 'None yet.';
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
    meta.textContent = override === 'on' ? 'Force on' : 'Force off';
    info.append(title, meta);
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'override-clear';
    clear.textContent = 'Clear';
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

  buy.textContent = `Buy dark mode (${data.license.priceLabel})`;
  toggle.checked = data.paid && data.enabled;
  toggle.disabled = !data.paid;

  if (data.paid) {
    let statusText = 'Paid — unlocked';
    if (data.license.grace) statusText += ' (offline grace)';
    if (data.license.email) statusText += ` · ${data.license.email}`;
    status.textContent = statusText;
    hint.textContent = data.license.configured
      ? 'License refreshes from ExtensionPay when online. Offline grace lasts up to 14 days.'
      : 'Using a local license cache (ExtensionPay id missing in this build).';
  } else {
    status.textContent = 'Free — purchase required to enable';
    hint.textContent = data.license.configured
      ? 'Buy opens ExtensionPay / Stripe ($2 one-time). Already paid? Restore with the email from your receipt. Ad blocking stays free either way.'
      : data.license.unpacked
        ? 'ExtensionPay not configured in this build. Unpacked: use Dev unlock to test dark mode.'
        : 'Purchases unavailable in this build — update StampStack from the Chrome Web Store.';
  }

  buy.disabled = !data.license.configured && !data.license.unpacked;
  const restore = $<HTMLButtonElement>('darkRestore');
  restore.disabled = !data.license.configured;
  if (!data.license.configured) {
    buy.title = 'ExtensionPay not configured';
    restore.title = 'ExtensionPay not configured';
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
  else $('darkActionHint').textContent = 'Dev unlock applied (unpacked only).';
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
    container.textContent = 'Could not load site rules.';
    return;
  }

  const rows: { host: string; label: string; kind: 'fix' | 'allowlist' }[] = [
    ...Object.entries(data.siteFixes).map(([host, level]) => ({
      host,
      label: siteFixLabel(level),
      kind: 'fix' as const,
    })),
    ...data.allowlist.map((host) => ({
      host,
      label: 'No blocking at all',
      kind: 'allowlist' as const,
    })),
  ].sort((a, b) => a.host.localeCompare(b.host));

  if (!rows.length) {
    container.textContent = 'None yet.';
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
    clear.textContent = 'Remove';
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
    row.textContent = `Line ${err.line}: ${err.reason}`;
    box.append(row);
  }
}

async function loadCustomFilters(): Promise<void> {
  const data = (await send({ type: 'customfilters:get' })) as CustomFiltersData | null;
  if (!data) return;
  const box = $<HTMLTextAreaElement>('customFilters');
  // Never clobber an in-progress edit when a storage event triggers a reload.
  if (document.activeElement !== box) box.value = data.text;
  $('customStatus').textContent = `${data.count} rule${data.count === 1 ? '' : 's'} active`;
  renderCustomErrors(data);
}

$<HTMLButtonElement>('customSave').addEventListener('click', async () => {
  const text = $<HTMLTextAreaElement>('customFilters').value;
  const data = (await send({ type: 'customfilters:set', text })) as CustomFiltersData | null;
  if (!data) return;
  $('customStatus').textContent =
    `Saved — ${data.count} rule${data.count === 1 ? '' : 's'} active` +
    (data.errors.length ? `, ${data.errors.length} line(s) ignored` : '');
  renderCustomErrors(data);
});

// --- Backup ----------------------------------------------------------------

function backupStatus(text: string): void {
  $('backupStatus').textContent = text;
}

$<HTMLButtonElement>('exportBtn').addEventListener('click', async () => {
  const r = (await send({ type: 'settings:export' })) as { json: string } | null;
  if (!r) {
    backupStatus('Export failed.');
    return;
  }
  // Object URL rather than a data: URL — settings can exceed data-URL length limits once a
  // user has a few hundred allowlist entries.
  const url = URL.createObjectURL(new Blob([r.json], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = 'stampstack-settings.json';
  a.click();
  URL.revokeObjectURL(url);
  backupStatus('Exported stampstack-settings.json');
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
    backupStatus(r?.error ?? 'Import failed.');
    return;
  }
  backupStatus('Settings imported.');
  void loadStats();
  void loadLists();
  void loadYoutubeOptions();
  void loadDarkMode();
  void loadSiteRules();
  void loadCustomFilters();
});

void loadStats();
void loadLists();
void loadYoutubeOptions();
void loadDarkMode();
void loadSiteRules();
void loadCustomFilters();
void loadSponsorCategories();
void loadVersion();
