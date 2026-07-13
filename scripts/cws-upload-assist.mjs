/**
 * Chrome Web Store upload assist — real Google Chrome only (not Cursor browser).
 *
 * CRITICAL: Chrome is launched DETACHED with a stable user-data-dir. Playwright
 * connects over CDP. We NEVER call browser.close()/context.close() in a way that
 * kills Chrome — on finish we only disconnect CDP and leave Chrome running.
 *
 * Usage:
 *   node scripts/cws-upload-assist.mjs
 *   node scripts/cws-upload-assist.mjs --zip path\to\stampstack-1.1.0.zip
 *
 * If Google login appears, sign in in THAT Chrome window. Script waits; Chrome stays open.
 */

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  cpSync,
  readFileSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const ZIP_DEFAULT = join(ROOT, 'release', 'stampstack-1.1.0.zip');
const PROMO = join(ROOT, 'store', 'promo-small.png');
const ICON = join(ROOT, 'src', 'icons', 'icon-128.png');
const CHROME_EXE = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const DEVCONSOLE = 'https://chrome.google.com/webstore/devconsole';
const LOGIN_TIMEOUT_MS = 15 * 60 * 1000;
const PROFILE_DIR = join(ROOT, '.cws-chrome-profile');
const LEGACY_TEMP_PROFILE = join(tmpdir(), 'stampstack-cws-chrome-profile');
const CDP_PORT = 9333;
const CDP_URL = `http://127.0.0.1:${CDP_PORT}`;

const NAME = 'StampStack';
const SUMMARY =
  'Block ads and trackers with EasyList-style filters, cosmetics, and scriptlets — built for Manifest V3.';
const DESCRIPTION = `StampStack blocks ads and trackers in Chromium browsers using Manifest V3 Declarative Net Request, plus cosmetic filters and scriptlets for leftover page junk.

What it does
• Network blocking with packaged filter lists (EasyList-style rules compiled for DNR)
• Cosmetic hiding for ad placeholders and overlays
• Scriptlets for common anti-block and tracking patterns where supported
• Per-site allowlist from the toolbar popup
• Options to enable or disable filter lists and tune behavior

Privacy
• No accounts
• No analytics or telemetry to StampStack servers
• Settings stay in your browser’s local storage
• See the privacy policy linked on the store listing

Open source
https://github.com/AndreasNE89/quell

Tips
• After install, browse normally — blocking starts with the packaged lists
• Use the popup to pause StampStack on a site that breaks
• Open Options to manage which lists are enabled`;

const HOMEPAGE = 'https://github.com/AndreasNE89/quell';
const SUPPORT = 'https://github.com/AndreasNE89/quell/issues';

const PERMISSIONS = {
  declarativeNetRequest:
    'Required to apply Declarative Net Request rulesets that block or redirect ad and tracker network requests. This is the primary Manifest V3 mechanism for an ad blocker.',
  scripting:
    'Required to inject cosmetic CSS and approved scriptlets into pages so leftover ad UI and common tracking scripts can be neutralized after the network layer.',
  storage:
    'Required to persist user settings (enabled filter lists, preferences) and the per-site allowlist locally on the device. Data is not uploaded to StampStack servers.',
  webNavigation:
    'Required to detect navigations so cosmetic filters and scriptlets can be applied consistently when users move between pages and frames.',
  host:
    'Required for a general-purpose ad and tracker blocker that works across websites the user visits. Without broad host access, StampStack cannot apply blocking and cosmetics on arbitrary sites.',
};

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function log(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[cws ${ts}] ${msg}`);
}

function reportPath() {
  return join(ROOT, 'store', 'cws-upload-report.json');
}

function writeReport(data) {
  mkdirSync(join(ROOT, 'store'), { recursive: true });
  writeFileSync(reportPath(), JSON.stringify(data, null, 2), 'utf8');
  log(`Report written: ${reportPath()}`);
}

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

function ensureProfile() {
  mkdirSync(PROFILE_DIR, { recursive: true });
  // Prefer stable profile; seed from previous temp profile if stable looks empty.
  const stableMarker = join(PROFILE_DIR, 'Default');
  const legacyMarker = join(LEGACY_TEMP_PROFILE, 'Default');
  if (!existsSync(stableMarker) && existsSync(legacyMarker)) {
    log(`Seeding profile from previous session: ${LEGACY_TEMP_PROFILE}`);
    try {
      cpSync(LEGACY_TEMP_PROFILE, PROFILE_DIR, { recursive: true });
      log('Copied login profile into .cws-chrome-profile');
    } catch (e) {
      log(`Profile copy warning: ${e.message}`);
    }
  }
}

async function cdpReady() {
  try {
    const res = await fetch(`${CDP_URL}/json/version`);
    return res.ok;
  } catch {
    return false;
  }
}

async function ensureChromeDetached() {
  if (await cdpReady()) {
    log(`Chrome already listening on ${CDP_URL} — reconnecting (will not restart)`);
    return;
  }

  ensureProfile();
  log(`Launching DETACHED Chrome (profile stays alive if this script exits)`);
  log(`Profile: ${PROFILE_DIR}`);

  const child = spawn(
    CHROME_EXE,
    [
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${PROFILE_DIR}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-blink-features=AutomationControlled',
      DEVCONSOLE,
    ],
    {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    },
  );
  child.unref();
  log(`Chrome PID ${child.pid} detached`);

  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (await cdpReady()) {
      log('CDP ready');
      return;
    }
    await sleep(400);
  }
  throw new Error(`Chrome CDP not ready at ${CDP_URL}`);
}

/**
 * Disconnect Playwright from CDP WITHOUT closing Chrome.
 * Never call browser.close() on a launchPersistentContext — that kills Chrome.
 * For connectOverCDP, we must NOT call browser.close() either in some versions;
 * prefer disposing connection via disconnect if available.
 */
async function disconnectOnly(browser) {
  try {
    // Playwright: browser.close() on CDP-connected browser closes the browser
    // in some versions. Use the internal disconnect if present.
    if (typeof browser.disconnect === 'function') {
      browser.disconnect();
      log('Disconnected Playwright CDP (Chrome left open)');
      return;
    }
  } catch (e) {
    log(`disconnect() note: ${e.message}`);
  }
  // Last resort: do nothing — keep Node alive so Chrome isn't orphaned badly.
  log('Leaving CDP connected; Chrome stays open. Do not kill this process unless Chrome is already independent.');
}

async function isDevConsole(page) {
  const url = page.url();
  if (url.includes('accounts.google.com') || /ServiceLogin|signin\/identifier/i.test(url)) {
    return false;
  }
  if (!url.includes('chrome.google.com/webstore/devconsole')) return false;
  const markers = [
    page.getByRole('button', { name: /new item|add new item|create/i }),
    page.getByText(/new item|add new item/i),
    page.getByRole('link', { name: /items/i }),
    page.locator('text=/Developer Dashboard|Chrome Web Store/i'),
  ];
  for (const m of markers) {
    try {
      if (await m.first().isVisible({ timeout: 1200 })) return true;
    } catch {
      /* continue */
    }
  }
  return /\/webstore\/devconsole(\/|$|\?)/.test(url);
}

async function waitForLogin(page) {
  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  log('If Google asks you to sign in, do it in the Chrome window on your desktop.');
  log(`Waiting up to ${LOGIN_TIMEOUT_MS / 60000} minutes — Chrome will NOT be closed.`);
  while (Date.now() < deadline) {
    if (await isDevConsole(page)) {
      log(`Dashboard ready: ${page.url()}`);
      return true;
    }
    const url = page.url();
    if (url.includes('accounts.google.com') || /signin|ServiceLogin/i.test(url)) {
      log('Login page detected — waiting for you (Chrome stays open)…');
    }
    await sleep(3000);
  }
  return false;
}

async function clickFirstVisible(page, locators, label) {
  for (const loc of locators) {
    try {
      const el = loc.first();
      if (await el.isVisible({ timeout: 2000 })) {
        await el.click({ timeout: 5000 });
        log(`Clicked: ${label}`);
        return true;
      }
    } catch {
      /* try next */
    }
  }
  log(`Could not click: ${label}`);
  return false;
}

async function fillFirst(page, selectors, value, label) {
  for (const sel of selectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 1500 })) {
        await el.click({ timeout: 2000 }).catch(() => {});
        await el.fill('');
        await el.fill(value, { timeout: 5000 });
        log(`Filled: ${label}`);
        return true;
      }
    } catch {
      /* try next */
    }
  }
  try {
    const byLabel = page.getByLabel(new RegExp(label, 'i')).first();
    if (await byLabel.isVisible({ timeout: 1500 })) {
      await byLabel.fill(value);
      log(`Filled via label: ${label}`);
      return true;
    }
  } catch {
    /* ignore */
  }
  log(`Could not fill: ${label}`);
  return false;
}

async function setFileIfPresent(page, filePath, hints) {
  if (!existsSync(filePath)) {
    log(`Missing file: ${filePath}`);
    return false;
  }
  const inputs = page.locator('input[type=file]');
  const count = await inputs.count();
  log(`Found ${count} file input(s); looking for: ${hints.join(' | ')}`);

  for (let i = 0; i < count; i++) {
    const input = inputs.nth(i);
    try {
      const accept = (await input.getAttribute('accept')) || '';
      const name = (await input.getAttribute('name')) || '';
      const id = (await input.getAttribute('id')) || '';
      const nearby = await input.evaluate((el) => {
        const parent = el.closest('div, section, form, label') || el.parentElement;
        return (parent?.textContent || '').slice(0, 240);
      });
      const blob = `${accept} ${name} ${id} ${nearby}`.toLowerCase();
      const hit = hints.some((h) => blob.includes(h.toLowerCase()));
      if (hit || (hints.includes('zip') && (accept.includes('zip') || accept.includes('.zip') || accept === ''))) {
        await input.setInputFiles(filePath);
        log(`Uploaded via input #${i}: ${filePath}`);
        return true;
      }
    } catch (e) {
      log(`Input #${i} skip: ${e.message}`);
    }
  }

  if (hints.includes('zip') && count > 0) {
    try {
      await inputs.first().setInputFiles(filePath);
      log(`Uploaded via first file input: ${filePath}`);
      return true;
    } catch (e) {
      log(`First-input upload failed: ${e.message}`);
    }
  }
  return false;
}

async function fillPermissionJustifications(page) {
  const filled = [];
  for (const [key, text] of Object.entries(PERMISSIONS)) {
    const patterns = [
      key === 'host' ? /all_urls|host permission|host access/i : new RegExp(key, 'i'),
    ];
    let ok = false;
    for (const pat of patterns) {
      try {
        const row = page.locator('div, section, li, tr').filter({ hasText: pat }).first();
        if (await row.isVisible({ timeout: 800 })) {
          const area = row.locator('textarea, input[type=text]').first();
          if (await area.isVisible({ timeout: 500 })) {
            await area.fill(text);
            ok = true;
            break;
          }
        }
      } catch {
        /* continue */
      }
    }
    if (!ok) {
      const areas = page.locator('textarea');
      const n = await areas.count();
      for (let i = 0; i < n; i++) {
        const a = areas.nth(i);
        try {
          const ph =
            ((await a.getAttribute('placeholder')) || '') +
            ((await a.getAttribute('aria-label')) || '');
          const val = await a.inputValue().catch(() => '');
          if (!val && new RegExp(key, 'i').test(ph)) {
            await a.fill(text);
            ok = true;
            break;
          }
        } catch {
          /* continue */
        }
      }
    }
    if (ok) {
      filled.push(key);
      log(`Permission justification filled: ${key}`);
    }
  }
  return filled;
}

async function holdOpen() {
  log('--- Chrome stays open. Press Enter here when you are done with the draft (does NOT close Chrome). ---');
  try {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    await new Promise((resolve) => rl.question('', () => { rl.close(); resolve(); }));
  } catch {
    await new Promise(() => {});
  }
}

async function main() {
  // Never let signals close Chrome via Playwright lifecycle.
  process.on('SIGINT', () => {
    log('SIGINT received — exiting Node only. Chrome (detached) stays open.');
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    log('SIGTERM received — exiting Node only. Chrome (detached) stays open.');
    process.exit(0);
  });

  const zipPath = argValue('--zip') || ZIP_DEFAULT;
  const report = {
    startedAt: new Date().toISOString(),
    zipPath,
    profileDir: PROFILE_DIR,
    cdpUrl: CDP_URL,
    succeeded: [],
    skipped: [],
    blockers: [],
    draftUrl: null,
    notes: [
      'Chrome launched detached; script must not kill the browser.',
      'Did not submit for review.',
    ],
  };

  if (!existsSync(zipPath)) {
    report.blockers.push(`Zip not found: ${zipPath}`);
    writeReport(report);
    console.error(report.blockers[0]);
    process.exit(1);
  }
  if (!existsSync(CHROME_EXE)) {
    report.blockers.push(`Chrome not found at ${CHROME_EXE}`);
    writeReport(report);
    console.error(report.blockers[0]);
    process.exit(1);
  }

  let browser;
  try {
    await ensureChromeDetached();
    browser = await chromium.connectOverCDP(CDP_URL);
    const context = browser.contexts()[0] || (await browser.newContext());
    let page = context.pages().find((p) => p.url().includes('webstore') || p.url().includes('accounts.google'))
      || context.pages()[0]
      || (await context.newPage());

    await page.bringToFront().catch(() => {});
    if (!page.url().includes('webstore') && !page.url().includes('accounts.google')) {
      await page.goto(DEVCONSOLE, { waitUntil: 'domcontentloaded', timeout: 60000 });
    }
    log(`Active page: ${page.url()}`);

    const loggedIn = await waitForLogin(page);
    if (!loggedIn) {
      report.blockers.push('Still waiting for Google sign-in — Chrome left open for you');
      writeReport(report);
      log('Login not completed yet. Chrome is still open — finish sign-in, then re-run: npm run cws-upload');
      await disconnectOnly(browser);
      await holdOpen();
      return;
    }
    report.succeeded.push('Reached developer console');
    report.draftUrl = page.url();

    const clickedNew = await clickFirstVisible(
      page,
      [
        page.getByRole('button', { name: /new item/i }),
        page.getByRole('link', { name: /new item/i }),
        page.getByText(/^new item$/i),
        page.getByRole('button', { name: /add new item/i }),
        page.locator('button:has-text("New item")'),
        page.locator('a:has-text("New item")'),
      ],
      'New item',
    );

    if (!clickedNew) {
      const publisher =
        'https://chrome.google.com/webstore/devconsole/1f8d61af-6eca-4c07-8551-2613a81caae5';
      log(`Trying publisher dashboard: ${publisher}`);
      await page.goto(publisher, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await sleep(2000);
      const again = await clickFirstVisible(
        page,
        [
          page.getByRole('button', { name: /new item/i }),
          page.getByText(/^new item$/i),
          page.locator('button:has-text("New item")'),
        ],
        'New item (publisher)',
      );
      if (!again) {
        report.blockers.push('Could not find New item — Chrome left open for manual upload');
        await page.screenshot({ path: join(ROOT, 'store', 'cws-debug.png'), fullPage: true }).catch(() => {});
        writeReport(report);
        await disconnectOnly(browser);
        await holdOpen();
        return;
      }
    }
    report.succeeded.push('Opened New item flow');
    await sleep(1500);

    try {
      const terms = page.getByRole('checkbox', { name: /agree|terms|developer agreement/i });
      if (await terms.first().isVisible({ timeout: 2000 })) {
        await terms.first().check();
        log('Accepted developer terms checkbox');
        report.succeeded.push('Accepted terms checkbox');
      }
    } catch {
      /* optional */
    }

    let uploaded = await setFileIfPresent(page, zipPath, [
      'zip',
      'package',
      'upload',
      'crx',
      'extension',
    ]);
    if (!uploaded) {
      await clickFirstVisible(
        page,
        [
          page.getByRole('button', { name: /upload/i }),
          page.getByText(/choose file|browse|select file/i),
        ],
        'Upload trigger',
      );
      await sleep(1000);
      uploaded = await setFileIfPresent(page, zipPath, ['zip', 'package', 'upload']);
    }

    if (uploaded) {
      report.succeeded.push('Uploaded package zip via setInputFiles');
    } else {
      report.blockers.push('Could not find file input for zip — Chrome left open');
      await page.screenshot({ path: join(ROOT, 'store', 'cws-debug.png'), fullPage: true }).catch(() => {});
    }

    await sleep(2000);
    await clickFirstVisible(
      page,
      [
        page.getByRole('button', { name: /continue|submit|upload|next|create/i }),
        page.locator('button:has-text("Continue")'),
        page.locator('button:has-text("Submit")'),
      ],
      'Continue after upload',
    );
    await sleep(4000);

    report.draftUrl = page.url();
    log(`URL after upload step: ${report.draftUrl}`);

    if (await fillFirst(page, ['input[aria-label*="name" i]', 'input[name*="name" i]', 'input[placeholder*="name" i]'], NAME, 'name')) {
      report.succeeded.push('Set name StampStack');
    }
    if (
      await fillFirst(
        page,
        [
          'textarea[aria-label*="summary" i]',
          'input[aria-label*="summary" i]',
          'textarea[name*="summary" i]',
          'textarea[placeholder*="summary" i]',
        ],
        SUMMARY,
        'summary',
      )
    ) {
      report.succeeded.push('Set summary');
    }
    if (
      await fillFirst(
        page,
        [
          'textarea[aria-label*="description" i]',
          'textarea[name*="description" i]',
          'textarea[placeholder*="description" i]',
        ],
        DESCRIPTION,
        'description',
      )
    ) {
      report.succeeded.push('Set detailed description');
    }

    try {
      const cat = page.getByLabel(/category/i).first();
      if (await cat.isVisible({ timeout: 2000 })) {
        await cat.click();
        await sleep(500);
        const opt = page.getByRole('option', { name: /productivity/i });
        if (await opt.first().isVisible({ timeout: 2000 })) {
          await opt.first().click();
        } else {
          await page.getByText(/^productivity$/i).first().click();
        }
        report.succeeded.push('Set category Productivity');
      }
    } catch {
      report.skipped.push('Category Productivity (manual)');
    }

    if (
      await fillFirst(
        page,
        [
          'input[aria-label*="homepage" i]',
          'input[aria-label*="official" i]',
          'input[placeholder*="homepage" i]',
        ],
        HOMEPAGE,
        'homepage',
      )
    ) {
      report.succeeded.push('Set homepage URL');
    }

    if (
      await fillFirst(
        page,
        ['input[aria-label*="support" i]', 'input[placeholder*="support" i]'],
        SUPPORT,
        'support',
      )
    ) {
      report.succeeded.push('Set support URL');
    }

    report.skipped.push(
      'Privacy policy URL — not invented; host docs/privacy-policy.html then paste HTTPS URL',
    );
    report.blockers.push(
      'Privacy policy HTTPS URL required before submit — host privacy-policy.html publicly',
    );

    if (await setFileIfPresent(page, PROMO, ['promo', '440', 'small tile', 'image/png', 'png'])) {
      report.succeeded.push('Uploaded promo-small.png');
    } else {
      report.skipped.push('Promo tile (no matching input)');
    }

    if (await setFileIfPresent(page, ICON, ['icon', '128', 'store icon'])) {
      report.succeeded.push('Uploaded icon-128.png');
    } else {
      report.skipped.push('Store icon (often from package)');
    }

    const perms = await fillPermissionJustifications(page);
    if (perms.length) report.succeeded.push(`Permission justifications: ${perms.join(', ')}`);
    else report.skipped.push('Permission justifications (may be on another tab)');

    report.skipped.push('Screenshots — none under store/screenshots/; required before submit');
    report.notes.push('Did NOT submit for review');
    report.draftUrl = page.url();
    report.finishedAt = new Date().toISOString();
    writeReport(report);

    await page.screenshot({ path: join(ROOT, 'store', 'cws-final.png'), fullPage: true }).catch(() => {});
    log('--- Summary ---');
    log(`Succeeded: ${report.succeeded.join('; ') || '(none)'}`);
    log(`Skipped: ${report.skipped.join('; ') || '(none)'}`);
    log(`Blockers: ${report.blockers.join('; ') || '(none)'}`);
    log(`Draft URL: ${report.draftUrl}`);

    await disconnectOnly(browser);
    browser = null;
    await holdOpen();
  } catch (err) {
    report.blockers.push(String(err?.message || err));
    report.finishedAt = new Date().toISOString();
    writeReport(report);
    console.error(err);
    log('Error occurred — Chrome (if started) should still be open.');
    if (browser) {
      try {
        await disconnectOnly(browser);
      } catch {
        /* ignore */
      }
    }
    await holdOpen();
  }
}

main();
