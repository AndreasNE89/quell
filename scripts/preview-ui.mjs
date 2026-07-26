// Render the popup (or Options) as a plain page, with chrome.* stubbed, so the UI can be
// eyeballed without loading the extension in Chrome.
//
// This exists because a real bug survived three releases without being noticed: four controls
// carried the `hidden` attribute but were still visible, because `hidden` is only a UA-stylesheet
// `display: none` and any class-level `display` rule beats it. An unpaid user was shown the
// dark-mode toggles and the "Dev unlock" button. No unit test could see that — only rendering
// could. Keeping the harness in the repo means the next such bug is one command away.
//
// Usage:
//   npm run preview                       popup, unpaid, ordinary site
//   npm run preview -- --state=paid       popup with dark mode unlocked
//   npm run preview -- --page=options
//   npm run preview -- --list             show the available states

import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, cpSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DIST = join(ROOT, 'dist');
const OUT = join(ROOT, '.preview');

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

/**
 * Popup states worth looking at. Each one is a real branch in the render path, and several of
 * them are only reachable in a store build or after a purchase — i.e. exactly the states that
 * are otherwise never seen during development.
 */
const STATES = {
  unpaid: {
    label: 'ordinary site, dark mode not purchased (the default a new user sees)',
    popup: { hostname: 'www.theguardian.com', paused: false, allowlisted: false, siteFix: null },
    dark: { paid: false, enabled: false, apply: false, restricted: false },
  },
  paid: {
    label: 'dark mode unlocked and on for this site',
    popup: { hostname: 'www.theguardian.com', paused: false, allowlisted: false, siteFix: null },
    dark: { paid: true, enabled: true, apply: true, restricted: false, override: 'on' },
  },
  allowlisted: {
    label: 'blocking turned off for this site',
    popup: { hostname: 'www.theguardian.com', paused: false, allowlisted: true, siteFix: null },
    dark: { paid: true, enabled: true, apply: true, restricted: false },
  },
  repaired: {
    label: 'a breakage fix is active on this site',
    popup: { hostname: 'shop.example.com', paused: false, allowlisted: false, siteFix: 'injection' },
    dark: { paid: true, enabled: false, apply: false, restricted: false },
  },
  paused: {
    label: 'paused everywhere',
    popup: { hostname: 'www.theguardian.com', paused: true, allowlisted: false, siteFix: null },
    dark: { paid: false, enabled: false, apply: false, restricted: false },
  },
  degraded: {
    label: 'Chrome refused to load a list (shared rule pool exhausted)',
    popup: { hostname: 'www.theguardian.com', paused: false, allowlisted: false, siteFix: null, degraded: true },
    dark: { paid: false, enabled: false, apply: false, restricted: false },
  },
  restricted: {
    label: 'a page StampStack cannot run on (chrome://, PDF viewer, …)',
    popup: { hostname: null, paused: false, allowlisted: false, siteFix: null },
    dark: { paid: true, enabled: true, apply: false, restricted: true },
  },
};

if (process.argv.includes('--list')) {
  console.log('Available --state values:\n');
  for (const [id, s] of Object.entries(STATES)) console.log(`  ${id.padEnd(12)} ${s.label}`);
  process.exit(0);
}

const page = arg('page', 'popup');
const stateId = arg('state', 'unpaid');
const state = STATES[stateId];
if (page !== 'popup' && page !== 'options') {
  console.error(`--page must be "popup" or "options" (got ${page})`);
  process.exit(1);
}
if (!state) {
  console.error(`Unknown --state "${stateId}". Try --list.`);
  process.exit(1);
}
if (!existsSync(join(DIST, `${page}.html`))) {
  console.error('dist/ is missing — run `npm run build` first.');
  process.exit(1);
}

/** The stub is injected as a classic script so it runs before the module entry point. */
function chromeStub() {
  const popup = {
    url: state.popup.hostname ? `https://${state.popup.hostname}/` : 'chrome://extensions/',
    tabBlocked: 0,
    blockedTotal: 0,
    // Store builds have no onRuleMatchedDebug, so this is the branch users actually see.
    statsReliable: false,
    activeRuleCount: state.popup.degraded ? 64625 : 120377,
    coveredBy: null,
    degraded: false,
    youtubeBlockSponsored: true,
    youtubeBlockShorts: false,
    youtubeSponsorBlock: true,
    ...state.popup,
  };
  const dark = {
    hostname: state.popup.hostname,
    override: null,
    siteOverrides: state.dark.paid ? { 'news.example.com': 'off' } : {},
    license: {
      paid: state.dark.paid,
      grace: false,
      verifiedAt: null,
      provider: state.dark.paid ? 'extensionpay' : 'none',
      configured: true,
      // Never true here: this harness stands in for a STORE build, where Dev unlock must not
      // appear at all. That is the bug this file exists to catch.
      unpacked: false,
      priceLabel: '$2',
    },
    ...state.dark,
  };
  const report = {
    available: !!state.popup.hostname && !state.popup.paused && !state.popup.allowlisted,
    reason: state.popup.hostname ? undefined : 'restricted',
    hostname: state.popup.hostname,
    hiddenElements: 6,
    truncated: false,
    unnamedThirdParty: 4,
    trackers: [
      { host: 'plausible.io', label: 'Plausible', blocked: false },
      { host: 'doubleclick.net', label: 'Google Ads', blocked: true },
      { host: 'google-analytics.com', label: 'Google Analytics', blocked: true },
      { host: 'criteo.com', label: 'Criteo', blocked: true },
      { host: 'scorecardresearch.com', label: 'Comscore', blocked: true },
    ],
  };
  const lists = {
    lists: [
      { id: 'quell-seed', title: 'StampStack Seed (built-in)', group: 'ads', enabled: true, ruleCount: 103 },
      { id: 'easylist', title: 'EasyList', group: 'ads', enabled: true, ruleCount: 54522 },
      { id: 'easyprivacy', title: 'EasyPrivacy', group: 'privacy', enabled: true, ruleCount: 55525 },
    ],
  };
  const sponsor = {
    categories: [
      { id: 'sponsor', label: 'Sponsor', hint: 'Paid promotion, paid referrals, direct advertising.', enabled: true },
      { id: 'selfpromo', label: 'Self-promotion', hint: 'Unpaid plugs for the creator’s own merch.', enabled: true },
      { id: 'intro', label: 'Intro / intermission', hint: 'Title cards and animated intros.', enabled: false },
    ],
    allOff: false,
  };

  const replies = {
    'popup:get': popup,
    'darkmode:get': dark,
    'report:get': report,
    'lists:get': lists,
    'stats:get': { blockedTotal: 0, paused: popup.paused, lists: lists.lists, regexRulesUsed: 209, statsReliable: false },
    'sitefix:list': { allowlist: ['ads.example.com'], siteFixes: { 'shop.example.com': 'injection' } },
    'customfilters:get': { text: '! my rules\nexample.com##.sponsored-widget\n', count: 1, errors: [] },
    'sponsorblock:getCategories': sponsor,
  };

  return `<script>
window.chrome = {
  runtime: {
    sendMessage: (m) => Promise.resolve(${JSON.stringify(replies)}[m.type] ?? null),
    openOptionsPage: () => {},
    getManifest: () => ({ version: ${JSON.stringify(
      JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version,
    )} }),
  },
  storage: { onChanged: { addListener: () => {} } },
  tabs: {
    query: () => Promise.resolve([{ id: 1, url: ${JSON.stringify(popup.url)} }]),
    reload: () => {},
    sendMessage: () => Promise.resolve(null),
  },
};
</script>`;
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
for (const f of [`${page}.html`, `${page}.css`, `${page}.js`]) cpSync(join(DIST, f), join(OUT, f));

let html = readFileSync(join(OUT, `${page}.html`), 'utf8');
html = html.replace(
  `<script type="module" src="${page}.js"></script>`,
  `${chromeStub()}\n    <script type="module" src="${page}.js"></script>`,
);
// A neutral backdrop so the panel's own edges are visible when it is not in a real popup.
html = html.replace(
  '</head>',
  `<style>
    html { background: #8a8f8c; }
    body { margin: 20px auto; box-shadow: 0 2px 16px rgba(0,0,0,.28); border-radius: 12px; }
  </style></head>`,
);
writeFileSync(join(OUT, 'index.html'), html);

console.log(`\n  ${page} · ${stateId} — ${state.label}`);
console.log(`\n  file:///${join(OUT, 'index.html').replace(/\\/g, '/')}\n`);
console.log('  Other states: npm run preview -- --list');
console.log('  .preview/ is gitignored and safe to delete.\n');
