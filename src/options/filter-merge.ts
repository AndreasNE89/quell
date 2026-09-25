// Three-way merge for the "My filters" editor.
//
// The editor is not the only writer: the element picker appends to the same text from any tab,
// and a second Options tab can save too. Saving the editor's copy verbatim deleted whatever
// arrived after it was loaded. Rules are one per line and order carries no meaning, so a
// line-set merge is exact enough: keep what the user typed, drop what was deleted elsewhere
// and not touched here, and append what was added elsewhere.

import { appendFilterLine } from '../shared/custom-filters.js';

const lines = (text: string): string[] => (text ?? '').split(/\r?\n/);
const ruleSet = (text: string): Set<string> =>
  new Set(lines(text).map((l) => l.trim()).filter(Boolean));

export interface FilterMerge {
  text: string;
  /** Lines that came from `theirs`. */
  added: number;
  /** Lines of `mine` dropped because they were deleted elsewhere. */
  removed: number;
}

/**
 * @param base   the stored text the editor was loaded from
 * @param mine   the editor's text
 * @param theirs the stored text now
 */
export function mergeFilterText(base: string, mine: string, theirs: string): FilterMerge {
  if (theirs === base) return { text: mine, added: 0, removed: 0 };
  const baseRules = ruleSet(base);
  const theirRules = ruleSet(theirs);
  const mineRules = ruleSet(mine);

  let removed = 0;
  const kept = lines(mine).filter((line) => {
    const t = line.trim();
    // Blank lines and comments are layout the user owns; only rules can be "deleted elsewhere".
    const deletedElsewhere = !!t && baseRules.has(t) && !theirRules.has(t);
    if (deletedElsewhere) removed++;
    return !deletedElsewhere;
  });

  let text = kept.join('\n');
  let added = 0;
  for (const line of lines(theirs)) {
    const t = line.trim();
    if (!t || baseRules.has(t) || mineRules.has(t)) continue;
    const next = appendFilterLine(text, t);
    if (next !== text) added++;
    text = next;
  }
  return { text, added, removed };
}
