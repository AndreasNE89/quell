// Hostname-specific hide/unhide stylesheet. Replaced on every cosmetic:refresh so
// removing the last custom rule (or allowlisting the page) actually clears the hide.

const ATTR = 'data-StampStack';
const VALUE = 'cosmetic';

/** Is `sel` a syntactically valid CSS selector? Guards against CSS breakout. */
export function isValidSelector(sel: string): boolean {
  try {
    document.createDocumentFragment().querySelector(sel);
    return true;
  } catch {
    return false;
  }
}

/** Serialize hide/unhide selectors. Empty string means the existing sheet must be removed. */
export function buildSpecificCss(hide: string[], unhide: string[]): string {
  const safeHide = hide.filter(isValidSelector);
  const safeUnhide = unhide.filter(isValidSelector);
  let css = '';
  if (safeHide.length) css += `${safeHide.join(',\n')} { display: none !important; }\n`;
  if (safeUnhide.length) css += `${safeUnhide.join(',\n')} { display: revert !important; }\n`;
  return css;
}

function existingSheet(): Element | null {
  return document.querySelector(`style[${ATTR}="${VALUE}"]`);
}

/** Insert or replace the specific cosmetic sheet. Empty hide+unhide removes it. */
export function injectSpecificCss(hide: string[], unhide: string[]): void {
  const existing = existingSheet();
  const css = buildSpecificCss(hide, unhide);
  if (!css) {
    existing?.remove();
    return;
  }
  const style = existing instanceof HTMLStyleElement ? existing : document.createElement('style');
  style.setAttribute(ATTR, VALUE);
  style.textContent = css;
  if (!existing) (document.head || document.documentElement).appendChild(style);
}
