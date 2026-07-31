// Apply translations to a rendered page.
//
// Chrome picks the locale from the browser's UI language and falls back to `default_locale`,
// so there is nothing to detect and no network call — which matters for an extension that
// makes none. Geolocation would be both a privacy regression and wrong: an English speaker in
// Shanghai wants English, a Chinese speaker in Oslo wants Chinese. The language the user set
// is the language they asked for.
//
// Markup carries `data-i18n="key"` for text and `data-i18n-attr="attr:key,attr:key"` for
// attributes. Strings built at runtime call `msg()` directly.

/**
 * Look up a message.
 *
 * Chrome already falls back to `default_locale` for any key a locale is missing, so a
 * half-translated locale degrades to English on its own — no second table needed here.
 *
 * What Chrome does NOT do is fail loudly on a key that exists nowhere: getMessage returns ''
 * and the caller quietly renders nothing. Callers must treat '' as "leave what was there",
 * which is what applyI18n does, and test/i18n.test.mjs is what actually catches the typo.
 */
export function msg(key: string, substitutions?: string | string[]): string {
  return chrome.i18n?.getMessage?.(key, substitutions) ?? '';
}

/** Replace text and attributes on every tagged element in the document. */
export function applyI18n(root: ParentNode = document): void {
  for (const el of root.querySelectorAll<HTMLElement>('[data-i18n]')) {
    const key = el.dataset['i18n'];
    if (!key) continue;
    const text = msg(key);
    if (text) el.textContent = text;
  }

  for (const el of root.querySelectorAll<HTMLElement>('[data-i18n-attr]')) {
    for (const pair of (el.dataset['i18nAttr'] ?? '').split(',')) {
      const [attr, key] = pair.split(':').map((s) => s.trim());
      if (!attr || !key) continue;
      const text = msg(key);
      if (text) el.setAttribute(attr, text);
    }
  }

  // The document title is not an element with text content the loop above can reach.
  const titleKey = document.documentElement.dataset['i18nTitle'];
  if (titleKey) {
    const text = msg(titleKey);
    if (text) document.title = text;
  }
}
