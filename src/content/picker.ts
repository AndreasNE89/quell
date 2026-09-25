// Element picker: click something on the page, get a cosmetic filter that hides it.
//
// Injected on demand by the service worker (never part of the always-on content script — it is
// only needed for a few seconds and installs page-wide capture listeners while active).
//
// Runs in the ISOLATED world, so nothing here can be observed or overridden by the page. The
// overlay lives in a closed shadow root to keep the site's CSS from restyling it and to keep our
// own elements out of any selector we generate.
//
// The overlay host covers the whole viewport and takes every pointer event itself, so the page
// never receives the pick's pointerdown or click (popunder scripts fire on those) and an ad
// iframe can be picked like any element instead of swallowing the click. The element under the
// pointer comes from elementsFromPoint, skipping the overlay. Input is handled in window capture
// listeners and only when trusted: a page cannot pick for the user, or cancel the pick, with
// synthetic events.

import {
  filterLineFor,
  isBareTagSelector,
  isPickable,
  selectorCandidates,
} from '../shared/selector.js';
import { parseCustomFilters } from '../shared/custom-filters.js';

const OVERLAY_ID = 'stampstack-picker-root';

type PickerSnapshot = Parameters<typeof selectorCandidates>[0];

interface Choice {
  selector: string;
  matches: number;
  /** Why this element cannot be saved as is, when it cannot. */
  refusal: string | null;
}

interface PickerState {
  root: HTMLElement;
  shadow: ShadowRoot;
  box: HTMLElement;
  label: HTMLElement;
  hint: HTMLElement;
  /** The element under the pointer. */
  hovered: Element | null;
  /** The element a click saves: `hovered`, or an ancestor after widening. */
  current: Element | null;
  /** How many levels up from the hovered element the user has widened the pick. */
  widen: number;
  choice: Choice | null;
  /** A save is in flight: further clicks wait for its answer. */
  busy: boolean;
  /** Element hiding is off on this page, or this host cannot hold a filter. */
  blocked: string | null;
}

let state: PickerState | null = null;

/** A catalog string when the locale has one (`$1` filled from `subs`), else the English text. */
function t(key: string, fallback: string, subs: string[] = []): string {
  let text = '';
  try {
    text = chrome.i18n?.getMessage(key, subs) ?? '';
  } catch {
    /* no i18n in this context */
  }
  return text || subs.reduce((s, v, i) => s.replace(`$${i + 1}`, v), fallback);
}

/** Snapshot the shape selectorCandidates needs, without leaking live DOM into the pure module. */
function describe(el: Element, depth = 0): PickerSnapshot {
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
    parent: parent && depth < 10 ? describe(parent, depth + 1) : null,
  };
}

function countMatches(selector: string, el: Element): number {
  try {
    if (!el.matches(selector)) return 0;
    return document.querySelectorAll(selector).length;
  } catch {
    return 0;
  }
}

/** Per pick session: hovering back and forth must not re-count every candidate each time. */
let choices = new WeakMap<Element, Choice>();

/**
 * The selector a click would save for `el`: the first candidate that matches only `el`, else the
 * one matching fewest (its count shown), and never a chain of bare tags.
 */
function chooseSelector(el: Element): Choice {
  let choice = choices.get(el);
  if (!choice) {
    choice = computeChoice(el);
    choices.set(el, choice);
  }
  return choice;
}

function computeChoice(el: Element): Choice {
  let best: { selector: string; matches: number } | null = null;
  for (const selector of selectorCandidates(describe(el))) {
    if (isBareTagSelector(selector)) continue;
    const matches = countMatches(selector, el);
    if (!matches) continue;
    if (matches === 1) return { selector, matches, refusal: null };
    if (!best || matches < best.matches) best = { selector, matches };
  }
  if (best) return { ...best, refusal: null };
  return {
    selector: '',
    matches: 0,
    refusal: t(
      'picker_refuse_structural',
      'Nothing here to target reliably — press ↑ to pick the box around it.',
    ),
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

// Brand colours on an arbitrary page. The forest border alone drops to ~2.7:1 on a dark site,
// so a 1px stamp-green ring outside it (~4.2:1 on #202124) keeps the box findable there, while
// the forest carries it on light pages (~6:1 on white). Label and hint are deep ink with cream
// text (~9:1).
function styles(): string {
  return `
    :host { all: initial; }
    .box {
      position: fixed;
      /* The box is sized from the target's rect, so the border must sit inside it. With the
         default content-box it overshot by 4px right and bottom, and on a full-width element
         the right edge landed off-screen. */
      box-sizing: border-box;
      pointer-events: none;
      border: 2px solid #2f6f4f;
      box-shadow: 0 0 0 1px #43906b;
      background: rgba(67, 144, 107, 0.2);
      border-radius: 2px;
      transition: all 60ms linear;
    }
    .label {
      position: fixed;
      pointer-events: none;
      max-width: min(70vw, 520px);
      padding: 4px 8px;
      background: #1f4d37;
      color: #fbf6ea;
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
      pointer-events: none;
      max-width: min(90vw, 640px);
      padding: 8px 14px;
      background: #1f4d37;
      color: #fbf6ea;
      font: 13px/1.4 system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
      border-radius: 999px;
      box-shadow: 0 2px 12px rgba(0, 0, 0, 0.4);
    }
    .hint.error { background: #7a1f1f; border-radius: 10px; }
    kbd {
      padding: 1px 5px;
      border: 1px solid #43906b;
      border-bottom-width: 2px;
      border-radius: 4px;
      font: inherit;
      font-size: 11px;
    }
  `;
}

/** Host styles, inline and !important so page CSS aimed at the id cannot move or hide it. */
const HOST_STYLE = [
  'all: initial',
  'position: fixed',
  'inset: 0',
  'width: 100vw',
  'height: 100vh',
  'margin: 0',
  'padding: 0',
  'border: 0',
  'z-index: 2147483647',
  'display: block',
  'visibility: visible',
  'opacity: 1',
  'pointer-events: auto',
  'cursor: crosshair',
  'background: transparent',
  'outline: none',
]
  .map((d) => `${d} !important`)
  .join('; ');

function showHint(s: PickerState, text: string | null, error = false): void {
  s.hint.classList.toggle('error', error);
  if (text !== null) {
    s.hint.textContent = text;
    return;
  }
  s.hint.textContent = '';
  const kbd = (key: string): HTMLElement => {
    const k = document.createElement('kbd');
    k.textContent = key;
    return k;
  };
  s.hint.append(
    `${t('picker_hint_click', 'Click to hide')} · `,
    kbd('↑'),
    '/',
    kbd('↓'),
    ` ${t('picker_hint_widen', 'widen or narrow')} · `,
    kbd('Esc'),
    ` ${t('picker_hint_cancel', 'cancel')}`,
  );
}

function mount(): PickerState {
  const root = document.createElement('div');
  root.id = OVERLAY_ID;
  root.setAttribute('style', HOST_STYLE);
  // Focusable, so keyboard input comes back to this document even if an iframe had focus.
  root.tabIndex = -1;
  // closed: the page cannot reach in, and our nodes never appear in a generated selector.
  const shadow = root.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = styles();
  const box = document.createElement('div');
  box.className = 'box';
  box.style.display = 'none';
  const label = document.createElement('div');
  label.className = 'label';
  label.style.display = 'none';
  const hint = document.createElement('div');
  hint.className = 'hint';
  shadow.append(style, box, label, hint);
  document.documentElement.appendChild(root);
  const s: PickerState = {
    root,
    shadow,
    box,
    label,
    hint,
    hovered: null,
    current: null,
    widen: 0,
    choice: null,
    busy: false,
    blocked: null,
  };
  showHint(s, null);
  return s;
}

function paint(s: PickerState, target: Element): void {
  const r = target.getBoundingClientRect();
  s.box.style.display = '';
  s.box.style.left = `${r.left}px`;
  s.box.style.top = `${r.top}px`;
  s.box.style.width = `${r.width}px`;
  s.box.style.height = `${r.height}px`;

  s.choice = chooseSelector(target);
  s.label.style.display = '';
  if (s.choice.refusal) {
    s.label.textContent = s.choice.refusal;
  } else {
    const n = s.choice.matches;
    const count =
      n === 1 ? t('picker_match_one', '1 match') : t('picker_match_many', '$1 matches', [String(n)]);
    s.label.textContent = `${s.choice.selector}  ·  ${count}`;
  }
  // Sit above the highlight, or below it when there is no room at the top.
  const above = r.top > 28;
  s.label.style.left = `${Math.max(4, r.left)}px`;
  s.label.style.top = above ? `${r.top - 24}px` : `${r.bottom + 6}px`;
}

function targetAt(x: number, y: number): Element | null {
  for (const hit of document.elementsFromPoint(x, y)) {
    if (!state || hit === state.root || hit.id === OVERLAY_ID) continue;
    return isPickable(hit.tagName) ? hit : null;
  }
  return null;
}

function onMove(e: MouseEvent): void {
  if (!e.isTrusted || !state) return;
  e.stopImmediatePropagation();
  if (state.busy || state.blocked) return;
  const hit = targetAt(e.clientX, e.clientY);
  if (!hit) return;
  // Moving inside the widened box keeps the widening: a 1px twitch before the click used to
  // drop it and save the narrow element.
  if (state.widen > 0 && state.current?.contains(hit)) return;
  if (hit === state.hovered && state.widen === 0) return;
  state.hovered = hit;
  state.widen = 0;
  state.current = hit;
  paint(state, hit);
}

function onKey(e: KeyboardEvent): void {
  if (!e.isTrusted || !state) return;
  // While picking, the keyboard belongs to the picker: the page must not act on it either.
  e.stopImmediatePropagation();
  if (e.type !== 'keydown') return;
  if (e.key === 'Escape') {
    e.preventDefault();
    stop();
    return;
  }
  if (e.key === 'Tab') {
    // Tabbing could move focus into an iframe, where Esc would no longer reach this listener.
    e.preventDefault();
    return;
  }
  if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && state.hovered && !state.busy && !state.blocked) {
    e.preventDefault();
    state.widen = Math.max(0, state.widen + (e.key === 'ArrowUp' ? 1 : -1));
    state.current = widenFrom(state.hovered, state.widen);
    paint(state, state.current);
    return;
  }
  if (e.key === 'Enter' && state.current && !state.busy && !state.blocked) {
    e.preventDefault();
    void save(state);
  }
}

/** Swallow every pointer event a pick produces; act on the primary-button click. */
function onPointer(e: Event): void {
  if (!e.isTrusted || !state) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  if (e.type !== 'click' || (e as MouseEvent).button !== 0) return;
  if (state.blocked) {
    stop();
    return;
  }
  if (state.busy) return;
  const m = e as MouseEvent;
  // A click without a preceding move (touchpad tap, keyboard-driven pointer) still picks.
  if (!state.current) {
    const hit = targetAt(m.clientX, m.clientY);
    if (!hit) return;
    state.hovered = state.current = hit;
    paint(state, hit);
  }
  void save(state);
}

/** After a successful save the filter itself takes over; drop our inline hide once it has. */
function handOffInlineHide(el: HTMLElement, prev: string | null): void {
  const restore = (): void => {
    if (prev === null) el.removeAttribute('style');
    else el.setAttribute('style', prev);
  };
  let tries = 0;
  const check = (): void => {
    if (!el.isConnected) return;
    const inline = el.getAttribute('style');
    restore();
    // Synchronous: nothing paints between restoring and re-hiding.
    if (getComputedStyle(el).display === 'none') return;
    if (inline === null) el.removeAttribute('style');
    else el.setAttribute('style', inline);
    if (++tries < 4) setTimeout(check, 250 * 2 ** tries);
  };
  setTimeout(check, 250);
}

async function save(s: PickerState): Promise<void> {
  const target = s.current;
  const choice = s.choice;
  if (!target || !choice) return;
  if (choice.refusal) {
    showHint(s, choice.refusal, true);
    return;
  }
  const line = filterLineFor(location.hostname.replace(/^www\./, ''), choice.selector);
  s.busy = true;
  showHint(s, t('picker_saving', 'Saving…'));
  // Hide immediately: waiting for the storage round trip would feel broken.
  const el = target as HTMLElement;
  const prev = el.getAttribute('style');
  el.style?.setProperty?.('display', 'none', 'important');
  let res: { ok?: boolean; error?: string } | null = null;
  try {
    res = (await chrome.runtime.sendMessage({ type: 'customfilters:add', line })) as typeof res;
  } catch (e) {
    res = { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  if (state !== s) return;
  if (!res?.ok) {
    // Nothing was saved: the element must not look hidden for good.
    if (prev === null) el.removeAttribute('style');
    else el.setAttribute('style', prev);
    s.busy = false;
    showHint(s, `${t('picker_save_failed', 'Not saved:')} ${res?.error ?? ''}`.trim(), true);
    return;
  }
  stop();
  handOffInlineHide(el, prev);
}

const POINTER_EVENTS = [
  'pointerdown',
  'pointerup',
  'mousedown',
  'mouseup',
  'click',
  'dblclick',
  'auxclick',
  'contextmenu',
  'touchstart',
  'touchend',
] as const;

/** Focus went into an iframe (or away): take it back so Esc keeps working. */
function onBlur(): void {
  if (!state) return;
  setTimeout(() => {
    if (state && document.activeElement !== state.root && !document.hasFocus()) {
      state.root.focus({ preventScroll: true });
    }
  }, 0);
}

/** Scrolling moves the page under a still pointer: keep the box on the element. */
function onScroll(): void {
  if (state?.current && !state.blocked) paint(state, state.current);
}

const LISTENERS: [string, EventListener][] = [
  ['mousemove', onMove as EventListener],
  ['pointermove', onMove as EventListener],
  ['keydown', onKey as EventListener],
  ['keyup', onKey as EventListener],
  ['keypress', onKey as EventListener],
  ...POINTER_EVENTS.map((type): [string, EventListener] => [type, onPointer]),
  ['blur', onBlur],
  ['scroll', onScroll],
];

/** Window capture phase: ahead of every document and element listener the page has. */
function listen(on: boolean): void {
  for (const [type, fn] of LISTENERS) {
    if (on) window.addEventListener(type, fn, { capture: true, passive: false });
    else window.removeEventListener(type, fn, { capture: true });
  }
}

function stop(): void {
  if (!state) return;
  listen(false);
  state.root.remove();
  state = null;
  delete (window as unknown as Record<string, unknown>)['__stampstackPickerActive'];
}

/** Refuse up front where a pick could not be saved or would not apply. */
async function checkPage(s: PickerState): Promise<void> {
  const host = location.hostname.replace(/^www\./, '');
  const probe = parseCustomFilters(filterLineFor(host, 'div'));
  if (probe.errors.length) {
    s.blocked = t('picker_host_refused', 'Filters cannot be saved for this address.');
  } else {
    try {
      const resp = (await chrome.runtime.sendMessage({
        type: 'cosmetic:get',
        hostname: location.hostname,
        isTop: true,
      })) as { allowlisted?: boolean } | null;
      if (resp?.allowlisted) {
        s.blocked = t(
          'picker_hiding_off',
          'Element hiding is off on this site (paused, allowed, or a repair step), so a pick would not apply.',
        );
      }
    } catch {
      /* worker unreachable: let the save report any problem */
    }
  }
  if (state === s && s.blocked) {
    s.box.style.display = 'none';
    s.label.style.display = 'none';
    showHint(s, `${s.blocked} ${t('picker_click_to_close', 'Click or press Esc to close.')}`, true);
  }
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

  choices = new WeakMap();
  state = mount();
  listen(true);
  state.root.focus({ preventScroll: true });
  void checkPage(state);
}

start();
