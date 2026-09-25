// What one filter-list row in Options should say. Pure, so the states that shipped wrong can be
// tested without a browser: while paused every enabled list was reported as refused by Chrome's
// rule limit, and a list switched on showed that same warning for good.

import type { ListRow } from '../shared/types.js';

/**
 * - `on` / `off`: the user's choice, in force.
 * - `paused`: enabled, and not loaded only because StampStack is paused everywhere.
 * - `refused`: enabled, yet Chrome did not load it (the shared static-rule pool is full).
 */
export type ListRowState = 'on' | 'off' | 'paused' | 'refused';

export function listRowState(row: ListRow, paused: boolean): ListRowState {
  if (!row.enabled) return 'off';
  // No ruleset is loaded while paused, by design, so every row reads `active: false` then;
  // `enabled && !active` says nothing about the rule pool until pause is ruled out.
  if (paused) return 'paused';
  // `refused` is the worker's own verdict; a row without it falls back to the raw comparison.
  const refused = typeof row.refused === 'boolean' ? row.refused : !row.active;
  return refused ? 'refused' : 'on';
}
