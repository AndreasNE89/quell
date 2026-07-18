// Popup controller: shows the active tab's status and wires the per-site + master toggles.

import type { DarkModeData, Message, PopupData } from '../shared/types.js';

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
  darkDevUnlockBtn: $<HTMLButtonElement>('darkDevUnlockBtn'),
  darkHint: $('darkHint'),
  darkAutoNote: $('darkAutoNote'),
};

function send(msg: Message): Promise<unknown> {
  return chrome.runtime.sendMessage(msg);
}

function render(data: PopupData): void {
  const blockingHere = !data.paused && !data.allowlisted && !!data.hostname;
  el.host.textContent = data.hostname ?? 'This page';
  el.siteSub.textContent = data.paused
    ? 'StampStack is paused'
    : data.allowlisted
      ? 'Blocking is off here'
      : 'Blocking on this site';

  el.siteToggle.checked = blockingHere;
  el.siteToggle.disabled = data.paused || !data.hostname;
  if (data.allowlisted) el.siteToggleLabel.textContent = 'Blocking off (allowlisted)';
  else if (data.paused) el.siteToggleLabel.textContent = 'Paused globally';
  else el.siteToggleLabel.textContent = 'Block on this site';

  el.pauseToggle.checked = data.paused;
  el.ytSponsoredToggle.checked = data.youtubeBlockSponsored;
  el.ytShortsToggle.checked = data.youtubeBlockShorts;
  el.ytSponsorBlockToggle.checked = data.youtubeSponsorBlock;
  el.ytSponsoredToggle.disabled = data.paused;
  el.ytShortsToggle.disabled = data.paused;
  el.ytSponsorBlockToggle.disabled = data.paused;

  el.tabBlocked.textContent = data.statsReliable ? String(data.tabBlocked) : '—';
  el.totalBlocked.textContent = data.statsReliable
    ? data.blockedTotal.toLocaleString()
    : 'n/a';

  el.statusDot.classList.toggle('off', !blockingHere);
  document.body.classList.toggle('paused', data.paused);
  document.body.classList.toggle('allowlisted', data.allowlisted);
}

function renderDarkMode(data: DarkModeData): void {
  darkCurrent = data;
  el.darkPrice.textContent = data.license.priceLabel;
  const host = data.hostname;

  if (!data.paid) {
    // Locked: only the upsell + config hint. Hide the toggles.
    el.darkSiteRow.hidden = true;
    el.darkResetBtn.hidden = true;
    el.darkModeRow.hidden = true;
    el.darkAutoNote.hidden = true;
    el.darkUpsell.hidden = false;
    el.darkBuyBtn.disabled = false;
    el.darkDevUnlockBtn.hidden = !data.license.unpacked;
    if (data.license.unpacked) {
      el.darkHint.hidden = false;
      el.darkHint.textContent = data.license.configured
        ? 'Unpacked dev: use Dev unlock to test dark mode without paying.'
        : 'ExtensionPay not configured — use Dev unlock here, or Options.';
    } else if (!data.license.configured) {
      el.darkHint.hidden = false;
      el.darkHint.textContent = 'Set ExtensionPay id in Options / extpay-config before buying.';
    } else {
      el.darkHint.hidden = true;
    }
    return;
  }

  // Paid: global (all-sites) default toggle is always shown.
  el.darkUpsell.hidden = true;
  el.darkDevUnlockBtn.hidden = true;
  el.darkModeRow.hidden = false;
  el.darkModeToggle.checked = data.enabled;
  el.darkModeToggle.disabled = false;

  if (data.restricted) {
    el.darkSiteRow.hidden = true;
    el.darkResetBtn.hidden = true;
    el.darkAutoNote.hidden = true;
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
  el.darkAutoNote.hidden = !(hasHost && data.autoOff && data.override === 'off');
}

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
  } catch (e) {
    console.warn('[StampStack] popup refresh failed', e);
  }
}

el.siteToggle.addEventListener('change', async () => {
  if (!current?.hostname) return;
  const data = (await send({
    type: 'popup:toggleSite',
    hostname: current.hostname,
    enabled: el.siteToggle.checked,
  })) as PopupData;
  current = data;
  render(data);
});

el.pauseToggle.addEventListener('change', async () => {
  const data = (await send({ type: 'popup:setPaused', paused: el.pauseToggle.checked })) as PopupData;
  current = data;
  render(data);
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
        : 'Checkout unavailable. Configure ExtensionPay in Options.');
  }
  el.darkBuyBtn.disabled = false;
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
