// The five store screenshots: their words, and where each real UI capture sits in the frame.
//
// Copy follows store/LISTING.md ("Screenshots") and the rebrand spec: headline of six words or
// fewer, split into the lines it should break on; one subline; plain words; no claim the product
// does not make itself. Captures arrive as `ui.<name>` = { src, w, h } in CSS pixels (the PNG
// behind `src` is twice that); `at` places one at a given scale. The stage is the 810×800 area
// right of the copy column.

/**
 * Place a 2x capture at `scale` (≤ 2 keeps it sharp). `cut` perforates the edges where the
 * capture stops short of the real panel ('bottom' or 'both'); `pad` puts white space around it.
 */
function at(u, { left, top, scale = 1, cut = '', pad = 0 }) {
  const w = Math.round(u.w * scale);
  const h = Math.round(u.h * scale);
  const [py, px] = Array.isArray(pad) ? pad : [pad, pad];
  return `<div class="ui${cut ? ` cut-${cut}` : ''}" style="left:${left}px;top:${top}px;width:${w + 2 * px}px;height:${h + 2 * py}px">` +
    `<div class="face" style="padding:${py}px ${px}px"><img src="${u.src}" width="${w}" height="${h}" alt="" /></div></div>`;
}

/** A plain browser window around a page capture shown at `scale`. */
function browser(u, { left, top, scale, url, extOn = false }) {
  const w = Math.round(u.w * scale);
  const h = Math.round(u.h * scale);
  return `<div class="window" style="left:${left}px;top:${top}px;width:${w}px">
    <div class="bar"><span class="dot"></span><span class="dot"></span><span class="dot"></span>
      <span class="url">${url}</span>
      <span class="ext${extOn ? ' on' : ''}"><img src="/icons/icon-32.png" alt="" /></span></div>
    <img class="page" src="${u.src}" width="${w}" height="${h}" alt="" />
  </div>`;
}

/** Small caption naming where a capture comes from. */
function tag(text, left, top) {
  return `<div class="tag" style="left:${left}px;top:${top}px">${text}</div>`;
}

/** Mouse pointer drawn over the art; headless captures have no cursor of their own. */
function cursor(left, top) {
  return `<svg class="cursor" style="left:${left}px;top:${top}px" viewBox="0 0 26 36"><path d="M2 2v27l7-6.5 5 11 4.6-2-5-10.6H23z" fill="#fff" stroke="#1a1d1b" stroke-width="2" stroke-linejoin="round"/></svg>`;
}

/**
 * Perforated stamp outline, the same construction as the icon: bites of radius `r` on a
 * `pitch` grid along every edge, cut inward (sweep 0 while walking the edge clockwise).
 */
function stampPath(w, h, r, pitch) {
  const edge = (len) => {
    const n = Math.max(1, Math.floor(len / pitch));
    const gap = (len - n * 2 * r) / (n + 1);
    return Array.from({ length: n }, (_, i) => gap + i * (gap + 2 * r));
  };
  let d = 'M0 0';
  for (const s of edge(w)) d += `H${s}A${r} ${r} 0 0 0 ${s + 2 * r} 0`;
  d += `H${w}`;
  for (const s of edge(h)) d += `V${s}A${r} ${r} 0 0 0 ${w} ${s + 2 * r}`;
  d += `V${h}`;
  for (const s of edge(w)) d += `H${w - s}A${r} ${r} 0 0 0 ${w - s - 2 * r} ${h}`;
  d += 'H0';
  for (const s of edge(h)) d += `V${h - s}A${r} ${r} 0 0 0 0 ${h - s - 2 * r}`;
  return `${d}Z`;
}

/**
 * Shot 1's before picture: the same page captured in a browser without StampStack, shown as a
 * small tilted stamp stuck on the frame with its own label, so it cannot pass for part of the
 * product's UI. It is what makes "Blocks ads." visible: the main capture has no trace of the
 * slots it removed.
 */
function beforeStamp(u, { left, top, width, label }) {
  const pad = 8;
  const h = Math.round((u.h * width) / u.w);
  const W = width + 2 * pad;
  const H = h + 2 * pad;
  return `<div class="inset" style="left:${left}px;top:${top}px;width:${W}px;height:${H}px">
    <svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}"><path d="${stampPath(W, H, 4, 15)}" fill="#fbf6ea" /></svg>
    <img src="${u.src}" width="${width}" height="${h}" style="left:${pad}px;top:${pad}px" alt="" />
    <div class="inset-label">${label}</div>
  </div>`;
}

/**
 * Shot 2's diagram: the repair steps as a face-on stack of stamps, peeled from the front.
 * Labels are the popup's own words for what each step switches off.
 */
function repairStack({ left, top }) {
  const W = 286;
  const H = 128;
  const STEP = 104; // how far each stamp peeks out below the one in front of it
  const layers = [
    { n: 1, label: 'Element hiding', note: 'blocking stays on', edge: '#43906b', panel: '#2f6f4f', rot: -0.9 },
    { n: 2, label: 'Script patches', note: 'blocking stays on', edge: '#2f6f4f', panel: '#245a41', rot: 0.7 },
    { n: 3, label: 'Blocking', note: 'last resort', edge: '#1f4d37', panel: '#173d2c', rot: -0.4, last: true },
  ];
  const outline = stampPath(W, H, 5.5, 22);
  // Painted back to front so stamp 1 ends up on top; each label sits in the strip left showing.
  const stamps = [...layers]
    .reverse()
    .map((l) => {
      const y = (l.n - 1) * STEP;
      const base = l.n === 1 ? 52 : H - 66; // label baseline block, inside the visible strip
      const noteW = l.last ? 96 : 146;
      const note = l.last ? ['#f6ded6', '#a3402b'] : ['#fbf6ea', '#1f4d37'];
      return `<g transform="translate(12 ${y + 12}) rotate(${l.rot} ${W / 2} ${H / 2})">
        <path d="${outline}" fill="${l.edge}" />
        <rect x="12" y="12" width="${W - 24}" height="${H - 24}" fill="${l.panel}" />
        <text x="30" y="${base + 34}" fill="#fbf6ea" font-size="38" font-weight="700">${l.n}</text>
        <text x="66" y="${base + 14}" fill="#fbf6ea" font-size="22" font-weight="700">${l.label}</text>
        <rect x="66" y="${base + 24}" width="${noteW}" height="24" rx="12" fill="${note[0]}" />
        <text x="${66 + noteW / 2}" y="${base + 41}" fill="${note[1]}" font-size="13.5" font-weight="700" text-anchor="middle">${l.note}</text>
      </g>`;
    })
    .join('');
  const w = W + 24;
  const h = STEP * 2 + H + 24;
  return `<div class="abs" style="left:${left}px;top:${top}px">
    <div class="tag" style="position:static;margin:0 0 14px 14px">What each step turns off</div>
    <svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" style="display:block;font-family:'Frame Lato',sans-serif">${stamps}</svg>
  </div>`;
}

export const SHOTS = [
  {
    file: '01-blocks-ads-names-trackers.png',
    headline: ['Blocks ads.', 'Names the trackers.'],
    subline: 'See which known trackers a page contacts, and which ones StampStack has rules for.',
    stage: (ui) => {
      const scale = 770 / ui.news.w;
      const top = Math.round((800 - (44 + ui.news.h * scale)) / 2) - 6;
      // The popup hangs from the toolbar button, right-aligned under it as Chrome draws it.
      const popupScale = 1.12;
      const popupLeft = 16 + 770 - 12 - Math.round(ui.popupReport.w * popupScale);
      // The before picture overlaps the window's lower-left corner and hangs out past it.
      const insetW = 250;
      const insetH = Math.round((ui.newsPlain.h * insetW) / ui.newsPlain.w) + 16;
      const windowBottom = top + 44 + Math.round(ui.news.h * scale);
      return (
        browser(ui.news, { left: 16, top, scale, url: 'news.example', extOn: true }) +
        at(ui.popupReport, { left: popupLeft, top: top + 46, scale: popupScale, cut: 'bottom' }) +
        beforeStamp(ui.newsPlain, { left: -2, top: windowBottom - insetH + 40, width: insetW, label: 'Same page without StampStack' })
      );
    },
  },
  {
    file: '02-site-broken-keep-blocking.png',
    headline: ['Site broken?', 'Fix it, keep blocking.'],
    subline: 'Try the gentlest fix first. The first two steps keep ads blocked.',
    stage: (ui) => {
      const scale = 1.18;
      const top = Math.round((800 - ui.popupRepair.h * scale) / 2);
      return at(ui.popupRepair, { left: 16, top, scale, cut: 'bottom' }) + repairStack({ left: 452, top: 212 });
    },
  },
  {
    file: '03-hide-anything.png',
    headline: ['Hide anything with a click.'],
    subline: 'Point at it, click, and it stays hidden on that site. Or press Alt+Shift+X.',
    stage: (ui) => {
      const top = Math.round((800 - (44 + ui.picker.h)) / 2) - 6;
      const [x, y] = ui.picker.pointer;
      return browser(ui.picker, { left: 16, top, scale: 1, url: 'recipes.example' }) + cursor(16 + x - 2, top + 44 + y - 2);
    },
  },
  {
    file: '04-skip-sponsor-segments.png',
    headline: ['Skip sponsor segments.'],
    subline: 'Sponsors only by default, from the community SponsorBlock database. Undo any skip.',
    stage: (ui) => {
      // Two rows: the skip notice on a grey player beside the popup's YouTube group, then the
      // Settings segment picker under both.
      const segH = ui.segments.h + 36;
      const rowTop = Math.round((800 - (38 + ui.popupYoutube.h + 30 + 38 + segH)) / 2);
      const segTop = rowTop + 38 + ui.popupYoutube.h + 30 + 38;
      return (
        tag('In the popup', 16, rowTop) +
        at(ui.popupYoutube, { left: 16, top: rowTop + 38, cut: 'both' }) +
        tag('While you watch', 786 - ui.player.w, rowTop) +
        at(ui.player, { left: 786 - ui.player.w, top: rowTop + 38 }) +
        tag('In Settings', 16, segTop - 38) +
        at(ui.segments, { left: 16, top: segTop, pad: [18, 22], cut: 'both' })
      );
    },
  },
  {
    file: '05-no-account-no-telemetry.png',
    headline: ['No account.', 'No telemetry.'],
    subline: 'Nothing to sign up for. Your settings stay in your browser.',
    stage: (ui) => {
      // The Settings header (its subtitle says it too) above the filter lists: two cuts from
      // one page, shown apart so they don't pass for one contiguous screen.
      const w = ui.lists.w + 52;
      const headH = ui.optionsHead.h + 44;
      const h = headH + 22 + ui.lists.h + 48;
      const left = Math.round((810 - w) / 2);
      const top = Math.round((800 - h) / 2);
      return (
        at(ui.optionsHead, { left, top, pad: [22, 26], cut: 'bottom' }) +
        at(ui.lists, { left, top: top + headH + 22, pad: [24, 26], cut: 'both' })
      );
    },
  },
];

/** The full frame page for one shot. */
export function frameHtml(shot, ui) {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8" /><link rel="stylesheet" href="/frame.css" /></head>
<body>
  <div class="lockup"><img src="/brand/stampstack-icon.svg" alt="" />StampStack</div>
  <div class="copy"><h1>${shot.headline.join('<br />')}</h1><div class="perf"></div><p>${shot.subline}</p></div>
  <div class="stage">${shot.stage(ui)}</div>
</body></html>`;
}
