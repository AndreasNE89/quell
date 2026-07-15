// Options page: filter-list management, YouTube features, dark mode, and stats.

import type {
  Message,
  ListsData,
  StatsData,
  ListGroup,
  PopupData,
  DarkModeData,
  DarkModeSiteOverride,
} from '../shared/types.js';

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
  const activeRules = s.paused
    ? 0
    : s.lists.filter((l) => l.enabled).reduce((n, l) => n + l.ruleCount, 0);
  $('statTotal').textContent = s.statsReliable ? s.blockedTotal.toLocaleString() : 'n/a';
  $('statRules').textContent = activeRules.toLocaleString();
  $('statRegex').textContent = String(s.regexRulesUsed);
  const totalLabel = document.querySelector('#statTotal')?.parentElement?.querySelector('.card-label');
  if (totalLabel) {
    totalLabel.textContent = s.statsReliable ? 'requests blocked' : 'blocked count (dev only)';
  }
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
  meta.textContent = `${l.ruleCount.toLocaleString()} network rules · cosmetics follow this toggle`;
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
  sponsored.checked = data.youtubeBlockSponsored;
  shorts.checked = data.youtubeBlockShorts;
  sponsored.disabled = data.paused;
  shorts.disabled = data.paused;
}

async function saveYoutubeOptions(): Promise<void> {
  const sponsored = $<HTMLInputElement>('ytSponsored');
  const shorts = $<HTMLInputElement>('ytShorts');
  await send({
    type: 'popup:setYoutubeOptions',
    youtubeBlockSponsored: sponsored.checked,
    youtubeBlockShorts: shorts.checked,
  });
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
    meta.textContent =
      override === 'on'
        ? 'Force on'
        : data.autoOffHosts?.[host]
          ? 'Auto-disabled (site looks dark)'
          : 'Force off';
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
      ? ''
      : 'ExtensionPay id not set yet — using local license cache.';
  } else {
    status.textContent = 'Free — purchase required to enable';
    hint.textContent = data.license.configured
      ? 'Checkout opens ExtensionPay / Stripe. Restore uses the email from your receipt.'
      : 'Set EXTPAY_EXTENSION_ID in src/shared/extpay-config.ts before shipping. Unpacked: use Dev unlock.';
  }

  buy.disabled = !data.license.configured && !data.license.unpacked;
  if (!data.license.configured) buy.title = 'ExtensionPay not configured';
  else buy.title = '';

  dev.hidden = !data.license.unpacked;
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

void loadStats();
void loadLists();
void loadYoutubeOptions();
void loadDarkMode();
void loadVersion();
