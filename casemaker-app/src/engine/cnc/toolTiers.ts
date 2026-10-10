/**
 * Which tier a registry entry belongs to (#311, tracking #212).
 *
 * A row's tier is read from its KEY NAMESPACE and from nothing else. That is not a shortcut: the
 * wire shape every tier shares (`ToolLibraryEntry`) carries `{key, tool, provenance}` and no field
 * saying where the row came from, and the service's own `origin` stays on disk. The key is the one
 * thing that cannot be ambiguous — `inv:` is minted only by the inventory, `user:` only by the
 * house's own tool file, `cat:` only by the catalogue importer (`catalogue.rs` re-derives the key
 * from the row's own `cutterId` and refuses a row where the two disagree), and the built-ins are
 * the shipped `TOOL_LIBRARY`, whose keys are bare.
 *
 * WHY THE GROUPING IS LOAD-BEARING IN THE UI. One of the built-ins is literally named "1 mm flat
 * end (assumed)". In a flat list sorted by name it would sit next to a cutter the user physically
 * owns, and the only thing separating a shipped assumption from a measured possession would be a
 * small tag. Grouped, the heading says it: this is what the app assumes, that is what you have —
 * the same provenance discipline decision 28 uses for the fixture.
 *
 * Plain data, no React, so the grouping and the counting can be tested on their own and the panel
 * does not re-invent the rule in three places.
 */

import type { ToolLibraryEntry } from './toolLibrary';

/** The four tiers, lowest-numbered last: the list is drawn in this order. */
export type ToolTier = 'owned' | 'yours' | 'catalogue' | 'builtin';

export const TIER_ORDER: readonly ToolTier[] = ['owned', 'yours', 'catalogue', 'builtin'];

/**
 * The tier a key belongs to. An unknown namespace is a BUILT-IN and not an error: the registry only
 * ever holds these four, and the built-ins are the ones with bare keys, so the fallback says the
 * honest thing about a key nobody claimed.
 */
export function tierOf(key: string): ToolTier {
  if (key.startsWith('inv:')) return 'owned';
  if (key.startsWith('user:')) return 'yours';
  if (key.startsWith('cat:')) return 'catalogue';
  return 'builtin';
}

/** The word in the row's tag column. Lower case: it reads as a label, not as a sentence. */
export const TIER_TAG: Record<ToolTier, string> = {
  owned: 'owned',
  yours: 'yours',
  catalogue: 'catalogue',
  builtin: 'built-in',
};

/** The group heading. */
export const TIER_HEADING: Record<ToolTier, string> = {
  owned: 'Owned',
  yours: 'Yours',
  catalogue: 'Makera catalogue',
  builtin: 'Built-in',
};

/**
 * What the heading means, in one line under it. The catalogue's line carries its row count, so it
 * is built rather than fixed — "129 rows read from Makera Studio's library on this PC" is where a
 * `cat:` row came from, and the count is the only honest way to say "this is not your doing".
 */
export function tierNote(tier: ToolTier, count: number): string {
  switch (tier) {
    case 'owned':
      return 'the inventory — a physical cutter, with the code on its box';
    case 'yours':
      return 'your own definitions — typed, or cloned from a catalogue row';
    case 'catalogue':
      return `${count} ${count === 1 ? 'row' : 'rows'} read from Makera Studio’s library on this PC · read-only · clone to change`;
    case 'builtin':
      return 'permanent — the pickers resolve these with no service, no file and no network';
  }
}

export interface TierGroup {
  tier: ToolTier;
  entries: ToolLibraryEntry[];
}

/** The entries in drawing order, grouped, with empty tiers left out. */
export function groupByTier(entries: readonly ToolLibraryEntry[]): TierGroup[] {
  const groups: TierGroup[] = [];
  for (const tier of TIER_ORDER) {
    const inTier = entries.filter((e) => tierOf(e.key) === tier);
    if (inTier.length > 0) groups.push({ tier, entries: inTier });
  }
  return groups;
}

/** How many entries each tier holds, in the order the counts line reads them. */
export function tierCounts(entries: readonly ToolLibraryEntry[]): Record<ToolTier, number> {
  const counts: Record<ToolTier, number> = { owned: 0, yours: 0, catalogue: 0, builtin: 0 };
  for (const e of entries) counts[tierOf(e.key)] += 1;
  return counts;
}

/**
 * Everything one row can be found by, lower-cased: the search field's placeholder promises "name,
 * code or size", so the name, the code on the box, the provenance sentence and every dimension the
 * row shows are all in here.
 *
 * `codes` is passed in because a code is a fact about the POSSESSION and lives on the inventory
 * item, not on the definition the entry carries — the same split the panel draws.
 */
export function toolSearchText(entry: ToolLibraryEntry, codes: readonly string[] = []): string {
  const t = entry.tool;
  const parts: Array<string | number | null | undefined> = [
    t.name,
    t.typeText,
    t.shape,
    entry.key,
    entry.provenance,
    ...codes,
    t.tipDiameter,
    t.diameter,
    t.handleDiameter,
    t.fluteLength,
    t.shoulderLength,
    t.stickout,
  ];
  return parts.filter((p) => p !== null && p !== undefined).join(' ').toLowerCase();
}

/** Whether a row matches what has been typed. Every space-separated word must appear (AND). */
export function matchesSearch(text: string, query: string): boolean {
  const words = query.trim().toLowerCase().split(/\s+/).filter((w) => w.length > 0);
  return words.every((w) => text.includes(w));
}

/**
 * The catalogue row a catalogue key names, or null. `cat:<cutterId>` is the only key shape that
 * carries an id the house recognises elsewhere: `Origin.id` is that `cutterId` and NOT the key
 * (`house.rs`), so a clone registered from a catalogue row can name where it came from without
 * either side guessing.
 */
export function catalogueIdOf(key: string): string | null {
  return key.startsWith('cat:') && key.length > 4 ? key.slice(4) : null;
}
