// Runs a page's procedural cosmetic rules and keeps their effects in step with the DOM.
//
// Hides and `:style()` work through marker attributes plus rules in StampStack's own sheet, not
// inline styles. A page rewriting an element's style attribute no longer brings an ad back, and
// every pass re-evaluates every rule, so an element that stops matching (a recycled list row
// that now shows organic content) loses its marker and reappears. This is uBO's model.
//
// Rules that turn out to be plain CSS (the compiler routes every `:has()` here) become
// stylesheet rules and cost nothing per mutation. The rest re-run on DOM changes, coalesced to
// one pass per frame, spaced out when a pass is expensive, and with uBO's per-rule time budget
// so one pathological rule cannot keep the page busy.

import {
  compileProcedural,
  splitProceduralAction,
  sanitizeStyleDeclaration,
  actionNameMatcher,
  proceduralMutationObserverInit,
  PROCEDURAL_ACTION_NAMES,
  type CompiledProcedural,
  type ProceduralActionName,
} from '../engine/procedural.js';
import { chunkedRules, setProceduralCss, validSelectors } from './specific-css.js';

/**
 * A rule as the service worker sends it. The compiler may split a trailing action off into
 * `action`/`arg`; an action still inside `expr` works the same way.
 */
export interface ProceduralRuleInput {
  expr: string;
  action?: string;
  arg?: string;
}

interface RuleState {
  key: string;
  compiled: CompiledProcedural;
  /** null = hide. */
  action: ProceduralActionName | null;
  /** Marker attribute for hide and `:style()` rules. */
  token: string | null;
  matcher: RegExp | null;
  marked: Set<Element>;
  budget: number;
  lastAllowance: number;
  disabled: boolean;
}

const HIDE_DECL = 'display: none !important;';
const ACTIONS = new Set<string>(PROCEDURAL_ACTION_NAMES);

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/** Attribute names pages cannot predict, so they cannot target or pre-empt the markers. */
function randomToken(): string {
  let s = '';
  while (s.length < 10) s += Math.random().toString(36).slice(2);
  return `s${s.slice(0, 10)}`;
}

/** A rule's selector and action, or null when it is malformed or asks for something unsafe. */
function resolveRule(
  rule: ProceduralRuleInput,
): { selector: string; action: ProceduralActionName | null; arg: string } | null {
  if (!rule || typeof rule.expr !== 'string') return null;
  const split = splitProceduralAction(rule.expr);
  if (!split || !split.selector) return null;
  if (rule.action !== undefined && rule.action !== null && rule.action !== '') {
    if (!ACTIONS.has(rule.action)) return null;
    return { selector: split.selector, action: rule.action as ProceduralActionName, arg: rule.arg ?? '' };
  }
  return split.action
    ? { selector: split.selector, action: split.action.name, arg: split.action.arg }
    : { selector: split.selector, action: null, arg: '' };
}

export class ProceduralRunner {
  private rules: RuleState[] = [];
  private plainHide: string[] = [];
  private plainStyle = new Map<string, string[]>();
  private readonly hideToken = randomToken();
  /** Normalized declaration → marker attribute. */
  private readonly styleTokens = new Map<string, string>();
  private readonly ownAttrs = new Set<string>([this.hideToken]);
  private readonly refs = new WeakMap<Element, Map<string, number>>();
  private observer: MutationObserver | null = null;
  private observerKey = '';
  private pending = false;
  private nextAllowed = 0;
  private removed = 0;
  private started = false;

  /** Replace the rule set. Rules that stay keep their marks and time budget. */
  setRules(input: readonly ProceduralRuleInput[]): void {
    const previous = new Map(this.rules.map((r) => [r.key, r]));
    const rules: RuleState[] = [];
    const plainHide: string[] = [];
    const plainStyle = new Map<string, string[]>();
    const seen = new Set<string>();

    for (const raw of input ?? []) {
      const r = resolveRule(raw);
      if (!r) continue;
      const key = `${r.action ?? ''}\0${r.arg}\0${r.selector}`;
      if (seen.has(key)) continue;
      seen.add(key);

      let decl: string | null = null;
      if (r.action === 'style') {
        decl = sanitizeStyleDeclaration(r.arg);
        // An unusable :style() must not degrade into hiding the element it meant to restyle.
        if (!decl) continue;
      }
      let matcher: RegExp | null = null;
      if (r.action === 'remove-attr' || r.action === 'remove-class') {
        matcher = actionNameMatcher(r.arg);
        if (!matcher) continue;
      }
      const compiled = compileProcedural(r.selector);
      if (!compiled) continue;

      if (compiled.plainCss && (r.action === null || r.action === 'style')) {
        if (r.action === null) plainHide.push(compiled.plainCss);
        else {
          const list = plainStyle.get(decl!) ?? [];
          list.push(compiled.plainCss);
          plainStyle.set(decl!, list);
        }
        continue;
      }

      const kept = previous.get(key);
      if (kept) {
        previous.delete(key);
        rules.push(kept);
        continue;
      }
      rules.push({
        key,
        compiled,
        action: r.action,
        token: r.action === null ? this.hideToken : r.action === 'style' ? this.styleToken(decl!) : null,
        matcher,
        marked: new Set(),
        budget: 200,
        lastAllowance: now(),
        disabled: false,
      });
    }

    for (const gone of previous.values()) this.release(gone);
    this.rules = rules;
    this.plainHide = plainHide;
    this.plainStyle = plainStyle;
    this.renderCss();
    if (this.started) {
      this.syncObserver();
      this.runPass();
    }
  }

  /** Begin evaluating: now, at DOMContentLoaded, and on every relevant DOM change. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.syncObserver();
    this.runPass();
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => this.runPass(), { once: true });
    }
  }

  /** Stop and undo every reversible effect (allowlisted page, cosmetics switched off). */
  stop(): void {
    this.started = false;
    this.observer?.disconnect();
    this.observer = null;
    this.observerKey = '';
    for (const r of this.rules) this.release(r);
    this.rules = [];
    this.plainHide = [];
    this.plainStyle = new Map();
    setProceduralCss('');
  }

  /** Evaluate every rule once, synchronously. */
  runPass(): void {
    const t0 = now();
    for (const r of this.rules) this.runRule(r);
    const spent = now() - t0;
    // A pass that took 20 ms waits 80 ms before the next one: at most ~20% of the main thread.
    this.nextAllowed = now() + Math.min(1000, spent * 4);
  }

  /** Elements this runner currently hides, plus how many it removed from the page. */
  hiddenElements(): { elements: Element[]; plainSelectors: string[]; removed: number } {
    const elements: Element[] = [];
    for (const r of this.rules) {
      if (r.token !== this.hideToken) continue;
      for (const el of r.marked) if (el.isConnected) elements.push(el);
    }
    return { elements, plainSelectors: [...this.plainHide], removed: this.removed };
  }

  private styleToken(decl: string): string {
    let t = this.styleTokens.get(decl);
    if (!t) {
      t = randomToken();
      this.styleTokens.set(decl, t);
      this.ownAttrs.add(t);
    }
    return t;
  }

  private renderCss(): void {
    let css = '';
    const plain = validSelectors(this.plainHide);
    if (plain.length) css += chunkedRules(plain, HIDE_DECL);
    for (const [decl, sels] of this.plainStyle) {
      const ok = validSelectors(sels);
      if (ok.length) css += chunkedRules(ok, decl);
    }
    if (this.rules.some((r) => r.token === this.hideToken)) css += `[${this.hideToken}] { ${HIDE_DECL} }\n`;
    for (const [decl, token] of this.styleTokens) {
      if (this.rules.some((r) => r.token === token)) css += `[${token}] { ${decl} }\n`;
    }
    setProceduralCss(css);
  }

  private runRule(r: RuleState): void {
    if (r.disabled) return;
    const t0 = now();
    // uBO's allowance: 50 ms of budget back every 2 s, capped at 200 ms. A rule that is out of
    // budget skips this pass and keeps what it matched last time.
    const allowance = Math.floor((t0 - r.lastAllowance) / 2000);
    if (allowance >= 1) {
      r.budget = Math.min(200, r.budget + allowance * 50);
      r.lastAllowance = t0;
    }
    if (r.budget <= 0) return;
    const els = r.compiled.run();
    r.budget -= now() - t0;
    if (r.budget < -500) {
      r.disabled = true;
      console.info('[StampStack] procedural rule disabled, too slow:', r.key.split('\0')[2]);
    }
    this.apply(r, els);
  }

  private apply(r: RuleState, els: Element[]): void {
    switch (r.action) {
      case null:
      case 'style': {
        const next = new Set(els);
        for (const el of r.marked) if (!next.has(el)) this.unmark(el, r.token!);
        for (const el of next) if (!r.marked.has(el)) this.mark(el, r.token!);
        r.marked = next;
        return;
      }
      case 'remove':
        for (const el of els) {
          el.remove();
          this.removed++;
        }
        return;
      case 'remove-attr':
        for (const el of els) {
          for (const name of el.getAttributeNames()) {
            if (!this.ownAttrs.has(name) && r.matcher!.test(name)) el.removeAttribute(name);
          }
        }
        return;
      case 'remove-class':
        for (const el of els) {
          for (const cls of Array.from(el.classList)) if (r.matcher!.test(cls)) el.classList.remove(cls);
        }
        return;
    }
  }

  private mark(el: Element, token: string): void {
    let m = this.refs.get(el);
    if (!m) this.refs.set(el, (m = new Map()));
    const n = (m.get(token) ?? 0) + 1;
    m.set(token, n);
    if (n === 1) el.setAttribute(token, '');
  }

  private unmark(el: Element, token: string): void {
    const m = this.refs.get(el);
    const n = (m?.get(token) ?? 0) - 1;
    if (n > 0) {
      m!.set(token, n);
      return;
    }
    m?.delete(token);
    el.removeAttribute(token);
  }

  private release(r: RuleState): void {
    if (r.token) for (const el of r.marked) this.unmark(el, r.token);
    r.marked = new Set();
  }

  /** Our own marker writes and sheet updates must not wake the observer. */
  private isOwnMutation(rec: MutationRecord): boolean {
    if (rec.type === 'attributes') return !!rec.attributeName && this.ownAttrs.has(rec.attributeName);
    const t = rec.target;
    if (t instanceof HTMLStyleElement && t.hasAttribute('data-StampStack')) return true;
    if (rec.type !== 'childList') return false;
    const nodes = [...Array.from(rec.addedNodes), ...Array.from(rec.removedNodes)];
    return nodes.length > 0 && nodes.every((n) => n instanceof HTMLStyleElement && n.hasAttribute('data-StampStack'));
  }

  private syncObserver(): void {
    // Only rules that need JS on every change are observed; plain-CSS rules are in the sheet.
    const exprs = this.rules.map((r) => r.key.split('\0')[2]!);
    const init = exprs.length ? proceduralMutationObserverInit(exprs) : null;
    const key = init ? JSON.stringify(init) : '';
    if (key === this.observerKey) return;
    this.observer?.disconnect();
    this.observer = null;
    this.observerKey = key;
    if (!init || typeof MutationObserver !== 'function') return;
    this.observer = new MutationObserver((records) => {
      if (records.every((rec) => this.isOwnMutation(rec))) return;
      this.schedule();
    });
    // The document itself, not documentElement: document.open() swaps the root element.
    this.observer.observe(document, init);
  }

  private schedule(): void {
    if (this.pending) return;
    this.pending = true;
    const frame = (): void => {
      requestAnimationFrame(() => {
        this.pending = false;
        if (this.started) this.runPass();
      });
    };
    const wait = this.nextAllowed - now();
    if (wait > 1) setTimeout(frame, wait);
    else frame();
  }
}
