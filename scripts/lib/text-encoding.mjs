// What Chrome accepts as the text of an extension file it loads as a script or stylesheet.
//
// Chrome checks content scripts, executeScript files and the like with base::IsStringUTF8,
// which rejects invalid UTF-8 and also Unicode noncharacters (U+FDD0..U+FDEF and U+xFFFE /
// U+xFFFF on every plane): "Could not load file 'picker.js'. It isn't UTF-8 encoded." esbuild
// copies such a character from a regex literal into the bundle unchanged.

/**
 * Why Chrome would refuse `bytes` as a UTF-8 script, or null when it would load it.
 * @param {Uint8Array} bytes
 * @returns {string | null}
 */
export function chromeRejectsText(bytes) {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return 'not valid UTF-8';
  }
  for (let i = 0; i < text.length; i++) {
    const c = text.codePointAt(i);
    if ((c >= 0xfdd0 && c <= 0xfdef) || (c & 0xfffe) === 0xfffe) {
      const line = text.slice(0, i).split('\n').length;
      return `noncharacter U+${c.toString(16).toUpperCase().padStart(4, '0')} on line ${line}`;
    }
    if (c > 0xffff) i++;
  }
  return null;
}
