/**
 * The house depth margins as shop defaults (#447): the `margins.*` keys of `location.json`'s
 * `defaults` section, and the pure arithmetic between them and the `MarginSettings` record every
 * reader already takes (`settingsStore.margins`, `effectiveMargins`, `recommendMargins`).
 *
 * THE SETTING IS A PROJECTION. With a location, `settingsStore.margins` is rebuilt from the section
 * ({@link marginsFromDefaults}) whenever it loads or changes, so the panel, the job store and the run
 * sheet read the shop's numbers without knowing where they live. An edit to the setting goes the
 * other way, one key at a time ({@link marginWrites}). With no house service nothing here runs, and
 * the setting stays this browser's own — labelled so on the Settings menu.
 *
 * `source` KEEPS ITS MEANING. `'user'` has always meant "the two margins a job COPIES were set on
 * purpose" (SettingsMenu's `commitMargin`): while it is `'default'`, a blank that states its print
 * uses its own layer height — and that is ALL it decides (`houseBoundaryMargin`). So the projection
 * says `'user'` exactly when `margins.boundaryMarginMm` is chosen or measured, and a `'user'` record
 * whose boundary would otherwise read back as a seed pins it `chosen` at its value — "pinned at 0.2"
 * is not the same as "following the layer". A Z tolerance set on its own (a `default` record off its
 * seed) is kept and leaves the boundary following the layer, as it did.
 *
 * PURE: no store, no fetch. `locationStore.ts` owns the migration and the write-through.
 */

import { KNOWN_DEFAULTS, readDefault, type ShopDefault, type ShopDefaults } from '@/platform/defaultsClient';
import type { MarginSettings } from '@/engine/cnc/engrave/depthBounds';

/** Each `MarginSettings` number and its shop-default key. */
export const MARGIN_KEYS = {
  boundaryMargin: 'margins.boundaryMarginMm',
  zTolerance: 'margins.zToleranceMm',
  minFloor: 'margins.minFloorMm',
  edgeMargin: 'margins.edgeMarginMm',
  jawClearance: 'margins.jawClearanceMm',
  breakthrough: 'margins.breakthroughMm',
  measuredThicknessTolerance: 'margins.measuredThicknessToleranceMm',
} as const;

export type MarginField = keyof typeof MARGIN_KEYS;

/** The six the Settings menu shows (the thickness ± is not one of them). */
const SETTING_FIELDS: readonly MarginField[] = [
  'boundaryMargin',
  'zTolerance',
  'minFloor',
  'edgeMargin',
  'jawClearance',
  'breakthrough',
];

const ALL_FIELDS = Object.keys(MARGIN_KEYS) as MarginField[];

function seedOf(field: MarginField): number {
  const known = KNOWN_DEFAULTS[MARGIN_KEYS[field]];
  if (!known) throw new Error(`${MARGIN_KEYS[field]} is not in KNOWN_DEFAULTS`);
  return known.fallback;
}

function setByHand(source: string): boolean {
  return source === 'chosen' || source === 'measured';
}

/** The house setting the section describes. With no section (`null`), the labelled fallbacks. */
export function marginsFromDefaults(defaults: ShopDefaults | null): MarginSettings {
  const read = (f: MarginField) => readDefault(defaults, MARGIN_KEYS[f]);
  // `source` decides only the boundary margin (`houseBoundaryMargin`), so only its provenance sets it.
  const pinned = setByHand(read('boundaryMargin').source);
  return {
    boundaryMargin: read('boundaryMargin').value,
    zTolerance: read('zTolerance').value,
    minFloor: read('minFloor').value,
    edgeMargin: read('edgeMargin').value,
    jawClearance: read('jawClearance').value,
    breakthrough: read('breakthrough').value,
    measuredThicknessTolerance: read('measuredThicknessTolerance').value,
    source: pinned ? 'user' : 'default',
  };
}

/** Whether the section already holds a margin somebody set — the shop has an opinion of its own. */
export function shopHasOwnMargins(defaults: ShopDefaults | null): boolean {
  return ALL_FIELDS.some((f) => {
    const d = defaults?.[MARGIN_KEYS[f]];
    return d !== undefined && setByHand(d.source);
  });
}

/** One write to the section: a `chosen` value, or a reset to the seed. */
export type MarginWrite = { key: string; op: 'set'; value: ShopDefault } | { key: string; op: 'reset' };

/** The record is the shipped set exactly — "Restore the shipped margins", or "Reset to defaults". */
function isShipped(want: MarginSettings): boolean {
  return want.source === 'default' && SETTING_FIELDS.every((f) => want[f] === seedOf(f));
}

/**
 * The writes that make the section say what `want` says.
 *
 *   - A number that differs from the section's is written `chosen`, dated, with `note`.
 *   - A `'user'` record whose boundary margin would still read as a seed gets it written `chosen` at
 *     its value (see the module doc), so it reads back as `'user'`.
 *   - The shipped set (`isShipped`) resets every margin the section holds by hand back to its seed.
 *   - A MIGRATION (`migrate`) moves only what the old copy says DIFFERENTLY from the shipped set — any
 *     number off its seed, the copied pair included whatever the copy's `source` (#447 review: a
 *     `default` record off its seed keeps its Z tolerance) — and never resets.
 *   - With `asOf` (an old copy's time, or a pending edit's), a key the section holds by hand with a
 *     newer `setAt` is skipped: a later shop edit is never replayed over (#447 review).
 *   - `measuredThicknessTolerance` absent is no opinion (a record from before #447, or Restore).
 */
export function marginWrites(
  want: MarginSettings,
  defaults: ShopDefaults | null,
  now: string,
  opts: { migrate: boolean; note?: string | null; asOf?: string | null } = { migrate: false },
): MarginWrite[] {
  const writes: MarginWrite[] = [];
  const note = opts.note ?? null;
  const shipped = !opts.migrate && isShipped(want);
  const chosen = (v: number): ShopDefault => ({ value: v, source: 'chosen', setAt: now, unit: 'mm', note });
  const asOf = opts.asOf ? Date.parse(opts.asOf) : NaN;
  let boundaryByHand = false;
  for (const field of ALL_FIELDS) {
    const key = MARGIN_KEYS[field];
    const v = want[field];
    if (v === undefined) continue;
    const cur = readDefault(defaults, key);
    const byHand = setByHand(cur.source);
    // A key set by hand after `asOf` (an old copy's time, or a pending edit's) is newer: kept.
    const setAt = defaults?.[key]?.setAt;
    if (byHand && Number.isFinite(asOf) && setAt != null && Date.parse(setAt) > asOf) {
      if (field === 'boundaryMargin') boundaryByHand = true;
      continue;
    }
    if (shipped) {
      if (byHand && field !== 'measuredThicknessTolerance') writes.push({ key, op: 'reset' });
      continue;
    }
    const write = opts.migrate ? v !== seedOf(field) && v !== cur.value : v !== cur.value;
    if (write) writes.push({ key, op: 'set', value: chosen(v) });
    if (field === 'boundaryMargin' && (write || byHand)) boundaryByHand = true;
  }
  // A `'user'` record whose boundary margin would still be a seed: pin it — `source` decides only the
  // boundary (`houseBoundaryMargin`) — so the projection reads `'user'` back.
  if (!shipped && want.source === 'user' && !boundaryByHand) {
    writes.push({ key: MARGIN_KEYS.boundaryMargin, op: 'set', value: chosen(want.boundaryMargin) });
  }
  return writes;
}

/** Where the margins that move into the section come from (#447's migration). */
export type LegacyMargins = {
  margins: MarginSettings;
  from: 'record' | 'browser';
  /** The copy's own time — a shop key set by hand after it is not replayed over (`marginWrites`). */
  asOf: string | null;
};

/**
 * The old copy to migrate, or null when there is nothing to move.
 *
 *   1. The machine record's `margins` — the location wins, as #412 decided — unless #439's stored
 *      base for the same machine shows this window changed its margins and never got the write in;
 *      then that unsent edit is the newer intent.
 *   2. With no machine record at all, this browser's own margins, once per browser (`migrated`) and
 *      only while the shop holds no margin of its own: a second browser's stale copy does not get to
 *      overwrite what the first one already moved.
 *   3. A record whose `margins` is already null has moved: a browser copy is not brought back.
 */
export function legacyMargins(input: {
  record: { id: string; margins: MarginSettings | null; updatedAt: string } | null;
  local: MarginSettings;
  storedBase: { id: string; margins: MarginSettings | null; updatedAt: string } | null;
  migrated: boolean;
  defaults: ShopDefaults | null;
  same: (a: unknown, b: unknown) => boolean;
}): LegacyMargins | null {
  const { record, local, storedBase, migrated, defaults, same } = input;
  if (record !== null && record.margins !== null) {
    // An unsent edit needs a base that HELD margins: a base from after the move (null) says nothing
    // about this window's cache, which would otherwise always read as "changed".
    const unsent =
      storedBase !== null && storedBase.id === record.id && storedBase.margins !== null && !same(local, storedBase.margins);
    // An unsent edit was made after its base; a shop key set by hand after the base wins over it,
    // as the location does.
    return unsent
      ? { margins: local, from: 'browser', asOf: storedBase.updatedAt }
      : { margins: record.margins, from: 'record', asOf: record.updatedAt };
  }
  if (record === null && !migrated && !shopHasOwnMargins(defaults)) return { margins: local, from: 'browser', asOf: null };
  return null;
}

/** The note a migrated value carries, so the section says where it came from. */
export function migrationNote(from: LegacyMargins['from']): string {
  return from === 'record'
    ? "moved from the machine record's depth margins (#447)"
    : "moved from this browser's saved depth margins (#447)";
}

/** Per browser: this browser's margins have been moved into this location (the value is its id). */
export const MARGINS_MOVED_KEY = 'casemaker.margins.home.v1';

export function marginsMovedFor(locationId: string): boolean {
  if (typeof localStorage === 'undefined') return false;
  try {
    return localStorage.getItem(MARGINS_MOVED_KEY) === locationId;
  } catch {
    return false;
  }
}

export function markMarginsMoved(locationId: string): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(MARGINS_MOVED_KEY, locationId);
  } catch {
    // Storage blocked: the record's null `margins` still says the location has moved.
  }
}

/**
 * A margins edit the shop did not take yet (#447 review, the #439 way): kept in this browser so it
 * survives a restart, and written on the next connect — unless a shop key was set by hand after it.
 */
export const MARGINS_PENDING_KEY = 'casemaker.margins.pending.v1';

export interface PendingMargins {
  locationId: string;
  margins: MarginSettings;
  at: string;
}

export function pendingMargins(locationId: string): PendingMargins | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(MARGINS_PENDING_KEY);
    if (raw === null) return null;
    const p = JSON.parse(raw) as Partial<PendingMargins>;
    if (p.locationId !== locationId || typeof p.at !== 'string' || typeof p.margins !== 'object' || p.margins === null) return null;
    return p as PendingMargins;
  } catch {
    return null;
  }
}

export function setPendingMargins(p: PendingMargins | null): void {
  if (typeof localStorage === 'undefined') return;
  try {
    if (p === null) localStorage.removeItem(MARGINS_PENDING_KEY);
    else localStorage.setItem(MARGINS_PENDING_KEY, JSON.stringify(p));
  } catch {
    // Storage blocked: the edit lives in this window only, as before.
  }
}
