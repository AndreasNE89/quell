// Every switch in the popup must be clickable.
//
// 2.1.0 shipped with "Block on this site" completely inert to a mouse. The checkbox is styled
// `opacity: 0` and was sized `width: 0; height: 0`, and `.slider` is a later
// absolutely-positioned sibling that paints over the spot — so the only way a click could reach
// the input was via a `<label>`. Every switch had one except that one, which sat in a bare
// `<span class="switch">`. It looked identical and did nothing: no change event, no
// popup:toggleSite message, so no amount of reloading helped. "Pause everywhere" worked, which
// is exactly what the bug report said.
//
// test/site-toggle.test.mjs calls the service-worker handlers directly and passed the whole
// time, because the message it asserts on was never dispatched in the real popup. Nothing in
// the suite looked at the markup. This does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync('src/popup/popup.html', 'utf8');
const css = readFileSync('src/popup/popup.css', 'utf8');

/**
 * Checkbox ids that have no path for a click, given the markup.
 *
 * A checkbox is reachable when it is inside a `<label>` (implicit association) or some label
 * points at it with `for=`. Kept as a pure function of the markup so the detector itself can be
 * tested against the markup that shipped broken.
 */
function unreachableCheckboxes(markup) {
  const forTargets = new Set([...markup.matchAll(/<label[^>]*\bfor="([^"]+)"/g)].map((m) => m[1]));
  const out = [];
  for (const m of markup.matchAll(/<input[^>]*type="checkbox"[^>]*>/g)) {
    const id = /\bid="([^"]+)"/.exec(m[0])?.[1];
    if (!id) continue;
    const before = markup.slice(0, m.index);
    // Inside a label if the nearest preceding <label is not already closed.
    const insideLabel = before.lastIndexOf('<label') > before.lastIndexOf('</label>');
    if (!insideLabel && !forTargets.has(id)) out.push(id);
  }
  return out;
}

/** The declared size of the `.switch input` box, or null if the rule is absent. */
function switchInputSize(sheet) {
  const rule = /\.switch input\s*\{([^}]*)\}/.exec(sheet);
  if (!rule) return null;
  const body = rule[1];
  const get = (prop) => new RegExp(`(?:^|[;\\s])${prop}\\s*:\\s*([^;]+)`).exec(body)?.[1]?.trim();
  return { width: get('width'), height: get('height'), body };
}

test('every popup checkbox can receive a click', () => {
  assert.deepEqual(
    unreachableCheckboxes(html),
    [],
    'these checkboxes have no <label> and no for= — a mouse cannot reach them',
  );
});

test('the popup actually has switches to check', () => {
  // Guards the test: a regex that matched nothing would make the assertion above vacuous.
  const count = [...html.matchAll(/<input[^>]*type="checkbox"[^>]*>/g)].length;
  assert.ok(count >= 6, `expected the popup's switches, found ${count}`);
});

test('the detector catches the markup that actually shipped broken', () => {
  // Verbatim shape of the 2.1.0 site toggle: a bare span, no label anywhere.
  const shipped = `
    <div class="site-main">
      <div class="site-text"><div class="site-host" id="host">x</div></div>
      <span class="switch">
        <input type="checkbox" id="siteToggle" aria-label="Block on this site" />
        <span class="slider"></span>
      </span>
    </div>
    <label class="switch-row">
      <span>Pause everywhere</span>
      <span class="switch">
        <input type="checkbox" id="pauseToggle" aria-label="Pause" />
        <span class="slider"></span>
      </span>
    </label>`;
  assert.deepEqual(unreachableCheckboxes(shipped), ['siteToggle']);
});

test('an explicit for= also counts as reachable', () => {
  const withFor = `
    <label class="site-main" for="siteToggle">Block</label>
    <span class="switch"><input type="checkbox" id="siteToggle" /></span>`;
  assert.deepEqual(unreachableCheckboxes(withFor), []);
});

test('the switch input keeps a hit area of its own', () => {
  // The other half of the bug: even with a label, collapsing the input to nothing leaves the
  // control dependent on that label forever. Keep it covering the switch.
  const size = switchInputSize(css);
  assert.ok(size, '.switch input rule is missing');
  assert.notEqual(size.width, '0', '.switch input must not collapse its width to 0');
  assert.notEqual(size.height, '0', '.switch input must not collapse its height to 0');
  assert.match(size.body, /position:\s*absolute/, 'it must be positioned to cover the switch');
});

test('the hit-area detector would have flagged the shipped CSS', () => {
  const shippedCss = '.switch input {\n  opacity: 0;\n  width: 0;\n  height: 0;\n}\n';
  const size = switchInputSize(shippedCss);
  assert.equal(size.width, '0');
  assert.equal(size.height, '0');
});
