// Popup controller: shows the active tab's status and wires the per-site + master toggles.

import type { Message, PopupData } from '../shared/types.js';

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
  tabBlocked: $('tabBlocked'),
  totalBlocked: $('totalBlocked'),
  optionsBtn: $('optionsBtn'),
  openOptions: $('openOptions'),
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
  el.ytSponsoredToggle.disabled = data.paused;
  el.ytShortsToggle.disabled = data.paused;

  el.tabBlocked.textContent = data.statsReliable ? String(data.tabBlocked) : '—';
  el.totalBlocked.textContent = data.statsReliable
    ? data.blockedTotal.toLocaleString()
    : 'n/a';

  el.statusDot.classList.toggle('off', !blockingHere);
  document.body.classList.toggle('paused', data.paused);
  document.body.classList.toggle('allowlisted', data.allowlisted);
}

let current: PopupData | null = null;

async function refresh(): Promise<void> {
  current = (await send({ type: 'popup:get' })) as PopupData;
  render(current);
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

function openOptions(): void {
  chrome.runtime.openOptionsPage();
}
el.optionsBtn.addEventListener('click', openOptions);
el.openOptions.addEventListener('click', openOptions);

void refresh();
