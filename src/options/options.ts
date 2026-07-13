// Options page: filter-list management + stats.

import type { Message, ListsData, StatsData, ListGroup } from '../shared/types.js';

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
  // Only count rules that are actually enforced right now.
  const activeRules = s.paused
    ? 0
    : s.lists.filter((l) => l.enabled).reduce((n, l) => n + l.ruleCount, 0);
  $('statTotal').textContent = s.blockedTotal.toLocaleString();
  $('statRules').textContent = activeRules.toLocaleString();
  $('statRegex').textContent = String(s.regexRulesUsed);
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
  meta.textContent = `${l.ruleCount.toLocaleString()} network rules`;
  info.append(title, meta);

  const sw = document.createElement('label');
  sw.className = 'switch';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = l.enabled;
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
    container.textContent = 'No lists compiled. Run `npm run build`.';
    return;
  }
  for (const l of data.lists) container.appendChild(listItem(l));
}

void loadStats();
void loadLists();
