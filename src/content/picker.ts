// Element picker: click something on the page, get a cosmetic filter that hides it.
//
// Injected on demand by the service worker (never part of the always-on content script — it is
// only needed for a few seconds and installs page-wide capture listeners while active).
//
// Runs in the ISOLATED world, so nothing here can be observed or overridden by the page. The
// overlay lives in a closed shadow root to keep the site's CSS from restyling it and to keep our
// own elements out of any selector we generate.

import { buildSelector, filterLineFor, isPickable } from '../shared/selector.js';

const OVERLAY_ID = 'stampstack-picker-root';

interface PickerState {
  root: HTMLElement;
  shadow: ShadowRoot;
  box: HTMLElement;
  label: HTMLElement;
  hint: HTMLElement;
  current: Element | null;
  /** How many levels up from the hovered element the user has widened the pick. */
  widen: number;
}

let state: PickerState | null = null;

/** Snapshot the shape buildSelector needs, without leaking live DOM into the pure module. */
function describe(el: Element, depth = 0): Parameters<typeof buildSelector>[0] {
  const parent = el.parentElement;
  let indexOfType = 0;
  let countOfType = 0;
  if (parent) {
    for (const sib of parent.children) {
      if (sib.tagName === el.tagName) {
        if (sib === el) indexOfType = countOfType;
        countOfType++;
      }
    }
  }
  const attrs: Record<string, string> = {};
  for (const name of ['data-testid', 'data-test', 'data-qa', 'aria-label', 'role', 'name']) {
    const v = el.getAttribute(name);
    if (v) attrs[name] = v;
  }
  return {
    tagName: el.tagName,
    id: el.id || undefined,
    classList: [...el.classList],
    attrs,
    indexOfType,
    countOfType,
    // Cap the climb so a deeply nested node does not build a giant snapshot chain.
    parent: parent && depth < 6 ? describe(parent, depth + 1) : null,
  };
}

/** Walk up `n` levels, never past a pickable element. */
function widenFrom(el: Element, n: number): Element {
  let node = el;
  for (let i = 0; i < n; i++) {
    const parent = node.parentElement;
    if (!parent || !isPickable(parent.tagName)) break;
    node = parent;
  }
  return node;
}

function styles(): string {
  return `
    :host { all: initial; }
    .box {
      position: fixed;
      pointer-events: none;
      z-index: 2147483647;
      border: 2px solid #0d9488;
      background: rgba(13, 148, 136, 0.18);
      border-radius: 2px;
      transition: all 60ms linear;
    }
    .label {
      position: fixed;
      z-index: 2147483647;
      pointer-events: none;
      max-width: min(70vw, 520px);
      padding: 4px 8px;
      background: #0f172a;
      color: #f8fafc;
      font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
      border-radius: 4px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35);
    }
    .hint {
      position: fixed;
      left: 50%;
      bottom: 16px;
      transform: translateX(-50%);
      z-index: 2147483647;
      pointer-events: none;
      padding: 8px 14px;
      background: #0f172a;
      color: #f8fafc;
      font: 13px/1.4 system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
      border-radius: 999px;
      box-shadow: 0 2px 12px rgba(0, 0, 0, 0.4);
    }
    kbd {
      padding: 1px 5px;
      border: 1px solid #475569;
      border-bottom-width: 2px;
      border-radius: 4px;
      font: inherit;
      font-size: 11px;
    }
  `;
}

function mount(): PickerState {
  const root = document.createElement('div');
  root.id = OVERLAY_ID;
  // closed: the page cannot reach in, and our nodes never appear in a generated selector.
  const shadow = root.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = styles();
  const box = document.createElement('div');
  box.className = 'box';
  const label = document.createElement('div');
  label.className = 'label';
  const hint = document.createElement('div');
  hint.className = 'hint';
  hint.innerHTML =
    'Click to hide · <kbd>↑</kbd>/<kbd>↓</kbd> widen or narrow · <kbd>Esc</kbd> cancel';
  shadow.append(style, box, label, hint);
  document.documentElement.appendChild(root);
  return { root, shadow, box, label, hint, current: null, widen: 0 };
}

function paint(s: PickerState, target: Element): void {
  const r = target.getBoundingClientRect();
  s.box.style.left = `${r.left}px`;
  s.box.style.top = `${r.top}px`;
  s.box.style.width = `${r.width}px`;
  s.box.style.height = `${r.height}px`;

  const selector = buildSelector(describe(target));
  s.label.textContent = selector;
  // Sit above the highlight, or below it when there is no room at the top.
  const above = r.top > 28;
  s.label.style.left = `${Math.max(4, r.left)}px`;
  s.label.style.top = above ? `${r.top - 24}px` : `${r.bottom + 6}px`;
}

function targetAt(x: number, y: number): Element | null {
  const hit = document.elementFromPoint(x, y);
  if (!hit || !isPickable(hit.tagName)) return null;
  if (hit.id === OVERLAY_ID) return null;
  return hit;
}

let hovered: Element | null = null;

function onMove(e: MouseEvent): void {
  if (!state) return;
  const hit = targetAt(e.clientX, e.clientY);
  if (!hit) return;
  hovered = hit;
  state.widen = 0;
  state.current = hit;
  paint(state, hit);
}

function onKey(e: KeyboardEvent): void {
  if (!state) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    stop();
    return;
  }
  if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && hovered) {
    e.preventDefault();
    state.widen = Math.max(0, state.widen + (e.key === 'ArrowUp' ? 1 : -1));
    state.current = widenFrom(hovered, state.widen);
    paint(state, state.current);
  }
}

function onClick(e: MouseEvent): void {
  if (!state?.current) return;
  // Swallow the click so the page never navigates from a pick.
  e.preventDefault();
  e.stopPropagation();
  const selector = buildSelector(describe(state.current));
  const line = filterLineFor(location.hostname.replace(/^www\./, ''), selector);
  void chrome.runtime.sendMessage({ type: 'customfilters:add', line });
  // Hide immediately: waiting for the storage round trip would feel broken.
  (state.current as HTMLElement).style?.setProperty?.('display', 'none', 'important');
  stop();
}

function stop(): void {
  if (!state) return;
  document.removeEventListener('mousemove', onMove, true);
  document.removeEventListener('keydown', onKey, true);
  document.removeEventListener('click', onClick, true);
  state.root.remove();
  state = null;
  hovered = null;
  delete (window as unknown as Record<string, unknown>)['__stampstackPickerActive'];
}

function start(): void {
  // executeScript re-evaluates this whole file on every injection, so module scope is fresh
  // each time — `state` cannot detect a picker that a previous injection already started.
  // Without a page-level guard, two clicks on "Pick an element" would leave two overlays and
  // two capture listeners, and a single pick would be written to the filter list twice.
  const flag = '__stampstackPickerActive';
  const w = window as unknown as Record<string, unknown>;
  if (w[flag]) return;
  w[flag] = true;

  const existing = document.getElementById(OVERLAY_ID);
  if (existing) existing.remove();

  state = mount();
  document.addEventListener('mousemove', onMove, true);
  document.addEventListener('keydown', onKey, true);
  // Capture phase so the page's own click handlers never see the pick.
  document.addEventListener('click', onClick, true);
}

start();
