// Compose a breakage report the user sends themselves.
//
// StampStack collects nothing, which is the right call and has one cost: breakage is
// invisible. A site breaks, the user works the repair ladder, and either it helps or they
// uninstall — both silently. Without telemetry the only possible signal is someone choosing
// to describe what happened.
//
// So this builds a message and hands it to their mail client. Nothing is transmitted by the
// extension; the user reads the draft, edits it, and decides whether to send. That is also
// why the payload is deliberately thin: the hostname and the extension's own configuration,
// never page content, never the full URL, never what the page report observed.

import { SUPPORT_EMAIL } from './constants.js';
import { listAge } from './list-age.js';
import type { SiteFixLevel } from './types.js';

/** Everything the report states, gathered by the service worker. */
export interface BreakageFacts {
  hostname: string;
  /** Repair rung currently applied to this host. */
  siteFix: SiteFixLevel | null;
  /** Blocking switched off entirely for this host. */
  allowlisted: boolean;
  version: string;
  listsGeneratedAt: string | null;
  activeRuleCount: number;
  /** Chrome refused to load a list the user enabled. */
  degraded: boolean;
  enabledLists: string[];
  /** e.g. "Chrome 138" — best effort, "unknown" is fine. */
  browser: string;
  now: number;
}

export interface BreakageReport {
  to: string;
  subject: string;
  body: string;
  /** Pre-filled mailto: URL. */
  mailto: string;
}

/** The line the reader of the report needs first: how much filtering was still on. */
function repairState(facts: BreakageFacts): string {
  if (facts.allowlisted) return 'blocking off for this site (allowlisted)';
  if (facts.siteFix === 'injection') return 'element hiding and scriptlets off';
  if (facts.siteFix === 'cosmetics') return 'element hiding off';
  return 'everything on (no repair applied)';
}

/**
 * A fixed-width block so it survives a mail client's reflow, and is labelled so the user can
 * see exactly what they are about to send.
 */
function diagnostics(facts: BreakageFacts): string {
  const age = listAge(facts.listsGeneratedAt, facts.now);
  const rows: [string, string][] = [
    ['site', facts.hostname],
    ['repair step', repairState(facts)],
    ['version', facts.version],
    ['filter lists', age.level === 'unknown' ? 'unknown' : `${age.date} (${age.days}d old)`],
    [
      'rules active',
      `${facts.activeRuleCount.toLocaleString('en-US')}${facts.degraded ? ' (reduced — a list did not load)' : ''}`,
    ],
    ['lists on', facts.enabledLists.length ? facts.enabledLists.join(', ') : 'none'],
    ['browser', facts.browser],
  ];
  const width = Math.max(...rows.map(([k]) => k.length));
  return rows.map(([k, v]) => `${(k + ':').padEnd(width + 2)}${v}`).join('\n');
}

export function buildBreakageReport(facts: BreakageFacts): BreakageReport {
  const subject = `StampStack breakage: ${facts.hostname}`;
  const body =
    `What looked wrong on ${facts.hostname}?\n` +
    '(a missing video player, a stuck menu, a blank gap, a login that would not go through —\n' +
    'whatever you noticed. Replace this line.)\n' +
    '\n' +
    '\n' +
    '--- details about your StampStack setup (please keep) ---\n' +
    diagnostics(facts) +
    '\n' +
    '--- end ---\n';

  return {
    to: SUPPORT_EMAIL,
    subject,
    body,
    mailto: `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`,
  };
}

/** Parse a Chrome-ish user agent into something short. Never throws. */
export function browserLabel(userAgent: string | undefined | null): string {
  if (!userAgent) return 'unknown';
  // Order matters: Edge and Opera both also claim "Chrome/".
  const m =
    /\bEdg(?:e|A|iOS)?\/(\d+)/.exec(userAgent) ??
    /\bOPR\/(\d+)/.exec(userAgent) ??
    /\bChrome\/(\d+)/.exec(userAgent);
  if (!m) return 'unknown';
  const name = m[0].startsWith('Edg') ? 'Edge' : m[0].startsWith('OPR') ? 'Opera' : 'Chrome';
  return `${name} ${m[1]}`;
}
