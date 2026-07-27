// Summarize what a filter-list refresh actually changed, as markdown for a PR body.
//
//   node scripts/list-refresh-report.mjs --before-meta a.json --after-meta b.json \
//                                        --before-lock c.json --after-lock d.json
//
// The committed .txt diffs run to tens of thousands of lines and nobody reads them. What
// makes a refresh reviewable is two numbers per list — how many bytes moved, and how many
// DNR rules came out the other side — plus a loud warning when a list shrinks hard, which is
// what a truncated or rate-limited download looks like from here.

import { readFileSync } from 'node:fs';
import { diffLock } from './lib/list-lock.mjs';

/** A list losing this share of its rules is treated as suspect rather than routine. */
export const SHRINK_WARN = 0.1;

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? null : process.argv[i + 1];
}

const readJson = (p) => {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
};

/** Rule counts keyed by list id. */
export function ruleCounts(meta) {
  const out = {};
  for (const l of meta?.lists ?? []) out[l.id] = l.ruleCount ?? 0;
  return out;
}

/**
 * Per-list rule movement plus the totals.
 *
 * `suspect` marks a list that lost more than SHRINK_WARN of its rules. Upstream lists do
 * shrink legitimately, so this is a flag for a human, never an automatic failure.
 */
export function ruleDelta(beforeMeta, afterMeta) {
  const before = ruleCounts(beforeMeta);
  const after = ruleCounts(afterMeta);
  const rows = [];
  for (const id of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
    const b = before[id] ?? 0;
    const a = after[id] ?? 0;
    rows.push({ id, before: b, after: a, delta: a - b, suspect: b > 0 && a < b * (1 - SHRINK_WARN) });
  }
  const sum = (o) => Object.values(o).reduce((n, v) => n + v, 0);
  return {
    rows,
    totalBefore: sum(before),
    totalAfter: sum(after),
    suspect: rows.filter((r) => r.suspect),
  };
}

const signed = (n) => (n > 0 ? `+${n.toLocaleString()}` : n < 0 ? `−${Math.abs(n).toLocaleString()}` : '0');

/** Markdown for a PR body. Returns null when nothing moved. */
export function report({ beforeMeta, afterMeta, beforeLock, afterLock }) {
  const lock = diffLock(beforeLock, afterLock ?? { lists: {} });
  const rules = ruleDelta(beforeMeta, afterMeta);
  if (lock.clean && rules.totalBefore === rules.totalAfter) return null;

  const out = [];
  out.push('Automated refresh of the upstream filter lists.', '');
  out.push(`**${signed(rules.totalAfter - rules.totalBefore)} rules** — ` +
    `${rules.totalBefore.toLocaleString()} → **${rules.totalAfter.toLocaleString()}**`, '');

  out.push('| List | Rules | Change | Bytes |');
  out.push('|---|---:|---:|---:|');
  const bytesFor = (id) => {
    const c = lock.changed.find((x) => x.id === id);
    if (!c) return lock.added.some((x) => x.id === id) ? 'new' : '—';
    const abs = Math.abs(c.delta);
    // Below a kilobyte, round-to-KB would print "0 KB" for a list that did change.
    return `${c.delta >= 0 ? '+' : '−'}${abs < 1024 ? `${abs} B` : `${(abs / 1024).toFixed(0)} KB`}`;
  };
  for (const r of rules.rows) {
    const flag = r.suspect ? ' ⚠️' : '';
    out.push(`| \`${r.id}\`${flag} | ${r.after.toLocaleString()} | ${signed(r.delta)} | ${bytesFor(r.id)} |`);
  }
  out.push('');

  if (rules.suspect.length) {
    out.push(
      `> ⚠️ ${rules.suspect.map((r) => `\`${r.id}\``).join(', ')} lost more than ` +
        `${Math.round(SHRINK_WARN * 100)}% of its rules. Upstream lists do shrink, but a ` +
        'truncated or rate-limited download looks the same from here — worth a glance before merging.',
      '',
    );
  }
  if (lock.removed.length)
    out.push(`Removed from the registry: ${lock.removed.map((r) => `\`${r.id}\``).join(', ')}`, '');
  if (lock.absent.length)
    out.push(`> Declared in \`lists.json\` but not downloaded: ${lock.absent.join(', ')}`, '');

  out.push('---', '');
  // Precise about what has and has not run. GitHub does not trigger workflows for a PR opened
  // with GITHUB_TOKEN, so ci.yml has *not* seen this branch — claiming otherwise would tell a
  // reviewer the build was checked by something that never looked at it.
  out.push('Gated inside the refresh job itself: `check-lists`, typecheck, tests, store package');
  out.push('and the obfuscation scan all passed before this was opened. `ci.yml` does not run on');
  out.push('this PR — GitHub does not trigger workflows for a pull request opened with');
  out.push('`GITHUB_TOKEN` — but it does run on merge, which is where the byte-for-byte rebuild');
  out.push('check happens.');
  out.push('');
  out.push('Merging pins the new lists. Cutting a release from them is a separate, deliberate');
  out.push('step (`docs/RELEASE_CHECKLIST.md`).');
  return out.join('\n');
}

// Only run as a CLI, so the tests can import the pure parts.
if (process.argv.some((a) => a.startsWith('--'))) {
  const wanted = ['before-meta', 'after-meta', 'before-lock', 'after-lock'];
  const loaded = {};
  const problems = [];
  for (const name of wanted) {
    const path = arg(name);
    if (!path) {
      problems.push(`--${name} was not given`);
      continue;
    }
    const value = readJson(path);
    if (value === null) problems.push(`--${name}: ${path} is missing or not valid JSON`);
    loaded[name] = value;
  }

  // Exit 1, never 3. Unreadable inputs make every comparison come out empty, which is
  // indistinguishable from a genuine no-op — and a caller that treats the two alike would
  // turn a broken run into a confident "upstream is unchanged" and drop a real refresh.
  if (problems.length) {
    console.error('list-refresh-report: cannot read its inputs —');
    for (const p of problems) console.error(`  ${p}`);
    process.exit(1);
  }

  const body = report({
    beforeMeta: loaded['before-meta'],
    afterMeta: loaded['after-meta'],
    beforeLock: loaded['before-lock'],
    afterLock: loaded['after-lock'],
  });
  if (body) process.stdout.write(body + '\n');
  else process.exit(3); // genuinely nothing moved — the workflow skips the PR
}
