/**
 * Capture CWS-ready screenshots of StampStack popup + options.
 * Uses Playwright Chromium (not system Chrome — Chrome 137+ dropped --load-extension)
 * and a temp profile (never .cws-chrome-profile).
 *
 * Prefer a store build so Dev unlock stays hidden and the unpaid Buy/Restore CTA shows:
 *   npm run build:store
 *   npm run store-screenshots
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync, existsSync, rmSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXT = join(ROOT, 'dist');
const OUT = join(ROOT, 'store', 'screenshots');
const W = 1280;
const H = 800;

if (!existsSync(join(EXT, 'manifest.json'))) {
  console.error('Missing dist/ — run npm run build first');
  process.exit(1);
}

mkdirSync(OUT, { recursive: true });
const PROFILE = mkdtempSync(join(tmpdir(), 'stampstack-shots-'));
console.log('Profile:', PROFILE);

async function getExtensionId(context) {
  let sw = context.serviceWorkers()[0];
  if (!sw) {
    try {
      sw = await context.waitForEvent('serviceworker', { timeout: 20_000 });
    } catch {
      /* fall through */
    }
  }
  if (sw) {
    const m = sw.url().match(/chrome-extension:\/\/([a-z]+)\//);
    if (m) return m[1];
  }

  const page = await context.newPage();
  const session = await context.newCDPSession(page);
  const { targetInfos } = await session.send('Target.getTargets');
  await page.close();
  const ext = targetInfos.find(
    (t) =>
      t.url?.startsWith('chrome-extension://') &&
      (t.type === 'service_worker' || t.type === 'background_page'),
  );
  if (ext) {
    const m = ext.url.match(/chrome-extension:\/\/([a-z]+)\//);
    if (m) return m[1];
  }
  console.error('Targets:', targetInfos.map((t) => `${t.type} ${t.url}`).join('\n'));
  throw new Error('Could not find StampStack service worker — extension failed to load');
}

// Official Chrome 137+ dropped --load-extension; use Playwright Chromium.
const context = await chromium.launchPersistentContext(PROFILE, {
  headless: false,
  args: [
    `--disable-extensions-except=${EXT}`,
    `--load-extension=${EXT}`,
    '--no-first-run',
    '--disable-search-engine-choice-screen',
  ],
  viewport: { width: W, height: H },
  ignoreDefaultArgs: ['--disable-extensions'],
});

try {
  const extensionId = await getExtensionId(context);
  console.log('Extension ID:', extensionId);

  const workers = context.serviceWorkers();
  if (workers[0]) {
    await workers[0]
      .evaluate(async () => {
        const settingsKey = 'stampstack.settings';
        const licenseKey = 'stampstack.license';
        const cur = (await chrome.storage.local.get(settingsKey))[settingsKey] || {};
        // Store listing should show the unpaid dark-mode upsell (Buy / Restore),
        // not an unpacked Dev-unlock session.
        await chrome.storage.local.set({
          [settingsKey]: {
            ...cur,
            paused: false,
            blockedTotal: 12847,
            allowlist: [],
            darkModeEnabled: false,
          },
          [licenseKey]: {
            paid: false,
            provider: 'none',
            verifiedAt: null,
          },
        });
      })
      .catch(() => {});
  }

  const popup = await context.newPage();
  await popup.setViewportSize({ width: W, height: H });
  await popup.goto(`chrome-extension://${extensionId}/popup.html`, {
    waitUntil: 'domcontentloaded',
    timeout: 15_000,
  });
  await popup.waitForTimeout(1000);
  const popupPath = join(OUT, '01-popup-1280x800.png');
  await popup.screenshot({ path: popupPath, type: 'png' });
  console.log('Wrote', popupPath);

  const options = await context.newPage();
  await options.setViewportSize({ width: W, height: H });
  await options.goto(`chrome-extension://${extensionId}/options.html`, {
    waitUntil: 'domcontentloaded',
    timeout: 15_000,
  });
  await options.waitForTimeout(1200);
  const optionsPath = join(OUT, '02-options-1280x800.png');
  await options.screenshot({ path: optionsPath, type: 'png' });
  console.log('Wrote', optionsPath);

  console.log('Done. See store/screenshots/README.md');
} finally {
  await context.close().catch(() => {});
  try {
    rmSync(PROFILE, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}
