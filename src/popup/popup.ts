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
    ? 'Quell is paused'
    : data.allowlisted
      ? 'Blocking is off here'
      : 'Blocking on this site';

  el.siteToggle.checked = blockingHere;
  el.siteToggle.disabled = data.paused || !data.hostname;
  el.pauseToggle.checked = data.paused;
  el.tabBlocked.textContent = String(data.tabBlocked);
  el.totalBlocked.textContent = data.blockedTotal.toLocaleString();

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

function openOptions(): void {
  chrome.runtime.openOptionsPage();
}
el.optionsBtn.addEventListener('click', openOptions);
el.openOptions.addEventListener('click', openOptions);

void refresh();
