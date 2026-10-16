// The house depth margins as shop defaults (#447, `store/shopMargins.ts`): the seeds, the projection
// into `MarginSettings`, the writes an edit makes, and which old copy a migration moves.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  MARGIN_DEFAULTS,
  MEASURED_THICKNESS_TOLERANCE_MM,
  recommendMargins,
  zBudgetInputsFor,
  type MarginSettings,
} from '@/engine/cnc/engrave/depthBounds';
import { WIRED_PROBE_Z_RESIDUAL_MM } from '@/engine/cnc/probePlan';
import { KNOWN_DEFAULTS, ShopDefaultsSchema, type ShopDefaults } from '@/platform/defaultsClient';
import {
  MARGIN_KEYS,
  legacyMargins,
  marginWrites,
  marginsFromDefaults,
  shopHasOwnMargins,
} from '@/store/shopMargins';
import { stableJson } from '@/store/locationStore';
import { parseMargins, parseMarginsStrict } from '@/store/settingsStore';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = JSON.parse(readFileSync(join(HERE, 'fixtures', 'location-doc.json'), 'utf8')) as { defaults: unknown };
const SEEDED: ShopDefaults = ShopDefaultsSchema.parse(FIXTURE.defaults);
const NOW = '2026-10-16T12:00:00.000Z';
const same = (a: unknown, b: unknown) => stableJson(a) === stableJson(b);

function chosen(map: ShopDefaults, key: string, value: number): ShopDefaults {
  return { ...map, [key]: { value, source: 'chosen', setAt: NOW, unit: 'mm', note: null } };
}

describe('the margins.* seeds (#447)', () => {
  it('each fallback is the constant it replaces, and the fixture seeds each at that value', () => {
    const want: Record<keyof typeof MARGIN_KEYS, number> = {
      boundaryMargin: MARGIN_DEFAULTS.boundaryMargin,
      zTolerance: MARGIN_DEFAULTS.zTolerance,
      minFloor: MARGIN_DEFAULTS.minFloor,
      edgeMargin: MARGIN_DEFAULTS.edgeMargin,
      jawClearance: MARGIN_DEFAULTS.jawClearance,
      breakthrough: MARGIN_DEFAULTS.breakthrough,
      measuredThicknessTolerance: MEASURED_THICKNESS_TOLERANCE_MM,
    };
    for (const [field, key] of Object.entries(MARGIN_KEYS) as [keyof typeof MARGIN_KEYS, string][]) {
      expect(KNOWN_DEFAULTS[key]?.fallback, key).toBe(want[field]);
      expect(SEEDED[key]?.value, key).toBe(want[field]);
      expect(SEEDED[key]?.source, key).toBe('seeded');
    }
  });

  it('admits every value the old setting accepted — 0 included — so a saved number migrates', () => {
    for (const key of Object.values(MARGIN_KEYS)) {
      expect(ShopDefaultsSchema.safeParse(chosen({}, key, 0)).success, key).toBe(true);
      expect(ShopDefaultsSchema.safeParse(chosen({}, key, 5)).success, key).toBe(true);
      expect(ShopDefaultsSchema.safeParse(chosen({}, key, -0.1)).success, key).toBe(false);
    }
  });
});

describe('the projection into the house setting', () => {
  it('the seeded section reads as the shipped set, `default`', () => {
    expect(marginsFromDefaults(SEEDED)).toEqual({ ...MARGIN_DEFAULTS, measuredThicknessTolerance: 0.05 });
  });

  it('no section (the web build) is the labelled fallback — the same shipped set', () => {
    expect(marginsFromDefaults(null)).toEqual({ ...MARGIN_DEFAULTS, measuredThicknessTolerance: 0.05 });
  });

  it('is `user` exactly when the boundary margin is set by hand — the one number `source` decides', () => {
    expect(marginsFromDefaults(chosen(SEEDED, 'margins.minFloorMm', 2)).source).toBe('default');
    expect(marginsFromDefaults(chosen(SEEDED, 'margins.minFloorMm', 2)).minFloor).toBe(2);
    // A Z tolerance on its own keeps the boundary following the layer, as a `default` set did.
    expect(marginsFromDefaults(chosen(SEEDED, 'margins.zToleranceMm', 0.1))).toMatchObject({ zTolerance: 0.1, source: 'default' });
    const pinned = marginsFromDefaults(chosen(SEEDED, 'margins.boundaryMarginMm', 0.2));
    expect(pinned).toMatchObject({ boundaryMargin: 0.2, source: 'user' });
  });

  it('a new job is seeded from the projected numbers', () => {
    const margins = marginsFromDefaults(chosen(chosen(SEEDED, 'margins.minFloorMm', 2.5), 'margins.breakthroughMm', 0.4));
    const job = defaultEngraveJob(undefined, margins);
    expect(job.minFloor).toBe(2.5);
    expect(job.breakthrough).toBe(0.4);
  });

  it('the measured-thickness ± comes from the house setting, and the constant only without one', () => {
    const job = { ...defaultEngraveJob(), sources: { stock: { thickness: 'measured' as const } } };
    const inputs = zBudgetInputsFor(job);
    const shop = recommendMargins(job, { ...MARGIN_DEFAULTS, measuredThicknessTolerance: 0.2 }, inputs);
    expect(shop.zTolerance).toBeCloseTo(WIRED_PROBE_Z_RESIDUAL_MM + 0.2, 9);
    const fallback = recommendMargins(job, MARGIN_DEFAULTS, inputs);
    expect(fallback.zTolerance).toBeCloseTo(WIRED_PROBE_Z_RESIDUAL_MM + MEASURED_THICKNESS_TOLERANCE_MM, 9);
    // A modelled thickness adds nothing.
    expect(recommendMargins(defaultEngraveJob(), MARGIN_DEFAULTS, zBudgetInputsFor(defaultEngraveJob())).basis.join(' '))
      .not.toContain('measured thickness');
  });
});

describe('the writes an edit makes', () => {
  it('writes only what changed, `chosen` and dated', () => {
    const want: MarginSettings = { ...marginsFromDefaults(SEEDED), minFloor: 2 };
    expect(marginWrites(want, SEEDED, NOW)).toEqual([
      { key: 'margins.minFloorMm', op: 'set', value: { value: 2, source: 'chosen', setAt: NOW, unit: 'mm', note: null } },
    ]);
  });

  it('a `user` set at the seeds pins the boundary margin, so it stops following the layer', () => {
    const want: MarginSettings = { ...MARGIN_DEFAULTS, source: 'user' };
    const writes = marginWrites(want, SEEDED, NOW);
    expect(writes.map((w) => w.key)).toEqual(['margins.boundaryMarginMm']);
    const after = chosen(SEEDED, 'margins.boundaryMarginMm', 0.2);
    expect(marginsFromDefaults(after).source).toBe('user');
    // And nothing more to write once it reads back as `user`.
    expect(marginWrites(marginsFromDefaults(after), after, NOW)).toEqual([]);
  });

  it('Restore resets every margin set by hand to its seed — the ± is not one of the six', () => {
    let map = chosen(SEEDED, 'margins.boundaryMarginMm', 0.3);
    map = chosen(map, 'margins.edgeMarginMm', 2);
    map = chosen(map, 'margins.measuredThicknessToleranceMm', 0.1);
    expect(marginWrites({ ...MARGIN_DEFAULTS }, map, NOW)).toEqual([
      { key: 'margins.boundaryMarginMm', op: 'reset' },
      { key: 'margins.edgeMarginMm', op: 'reset' },
    ]);
  });

  it('the migration never resets: an old copy of the shipped set has nothing to move', () => {
    const map = chosen(SEEDED, 'margins.edgeMarginMm', 2);
    expect(marginWrites({ ...MARGIN_DEFAULTS }, map, NOW, { migrate: true })).toEqual([]);
  });

  it('a `default` record off its seed keeps its Z tolerance, and keeps following the layer (#447 review)', () => {
    const old: MarginSettings = { ...MARGIN_DEFAULTS, zTolerance: 0.07, source: 'default' };
    const writes = marginWrites(old, SEEDED, NOW, { migrate: true });
    expect(writes.map((w) => w.key)).toEqual(['margins.zToleranceMm']);
    let after = SEEDED;
    for (const w of writes) if (w.op === 'set') after = { ...after, [w.key]: w.value };
    expect(marginsFromDefaults(after)).toMatchObject({ zTolerance: 0.07, source: 'default' });
  });

  it('never replays an old copy over a key the shop set by hand after it (#447 review)', () => {
    const later = { ...SEEDED, 'margins.edgeMarginMm': { value: 3, source: 'chosen' as const, setAt: '2026-10-16T10:00:00.000Z', unit: 'mm', note: null } };
    const old: MarginSettings = { ...MARGIN_DEFAULTS, edgeMargin: 0.5, minFloor: 2, source: 'default' };
    expect(marginWrites(old, later, NOW, { migrate: true, asOf: '2026-10-15T09:00:00.000Z' }).map((w) => w.key)).toEqual([
      'margins.minFloorMm',
    ]);
    // An older shop edit is replaced by the newer copy.
    expect(marginWrites(old, later, NOW, { migrate: true, asOf: '2026-10-16T11:00:00.000Z' }).map((w) => w.key)).toEqual([
      'margins.minFloorMm',
      'margins.edgeMarginMm',
    ]);
  });

  it('the migration moves only what the old copy says off the shipped set', () => {
    const map = chosen(chosen(SEEDED, 'margins.boundaryMarginMm', 0.3), 'margins.minFloorMm', 2);
    // A `default` record's copied pair says nothing; its 4 mm edge margin does.
    const old: MarginSettings = { ...MARGIN_DEFAULTS, edgeMargin: 4, source: 'default' };
    expect(marginWrites(old, map, NOW, { migrate: true }).map((w) => w.key)).toEqual(['margins.edgeMarginMm']);
    // A `user` record at the seeds pins the boundary — when the shop has not already.
    expect(marginWrites({ ...MARGIN_DEFAULTS, source: 'user' }, SEEDED, NOW, { migrate: true }).map((w) => w.key)).toEqual([
      'margins.boundaryMarginMm',
    ]);
    expect(marginWrites({ ...MARGIN_DEFAULTS, source: 'user' }, map, NOW, { migrate: true })).toEqual([]);
  });

  it('an edge value moves in as it was', () => {
    const want: MarginSettings = { ...MARGIN_DEFAULTS, minFloor: 0, breakthrough: 0, source: 'default' };
    const writes = marginWrites(want, SEEDED, NOW, { migrate: true, note: 'moved' });
    expect(writes.map((w) => (w.op === 'set' ? [w.key, w.value.value, w.value.note] : null))).toEqual([
      ['margins.minFloorMm', 0, 'moved'],
      ['margins.breakthroughMm', 0, 'moved'],
    ]);
    for (const w of writes) if (w.op === 'set') expect(ShopDefaultsSchema.safeParse({ [w.key]: w.value }).success).toBe(true);
  });
});

describe('which old copy a migration moves', () => {
  const user: MarginSettings = { ...MARGIN_DEFAULTS, boundaryMargin: 0.3, source: 'user' };
  const other: MarginSettings = { ...MARGIN_DEFAULTS, zTolerance: 0.07, source: 'user' };

  const T = '2026-10-15T09:00:00.000Z';

  it('the machine record’s margins win — the location wins, as #412 decided', () => {
    expect(
      legacyMargins({ record: { id: 'm', margins: other, updatedAt: T }, local: user, storedBase: null, migrated: false, defaults: SEEDED, same }),
    ).toEqual({ margins: other, from: 'record', asOf: T });
  });

  it('…unless #439’s stored base shows an unsent local edit', () => {
    expect(
      legacyMargins({
        record: { id: 'm', margins: other, updatedAt: T },
        local: user,
        storedBase: { id: 'm', margins: other, updatedAt: 'base' },
        migrated: false,
        defaults: SEEDED,
        same,
      }),
    ).toEqual({ margins: user, from: 'browser', asOf: 'base' });
  });

  it('a record whose margins have already moved brings no browser copy back', () => {
    expect(
      legacyMargins({ record: { id: 'm', margins: null, updatedAt: T }, local: user, storedBase: null, migrated: false, defaults: SEEDED, same }),
    ).toBeNull();
  });

  it('with no machine, this browser’s copy moves once, and never over the shop’s own', () => {
    expect(legacyMargins({ record: null, local: user, storedBase: null, migrated: false, defaults: SEEDED, same })).toEqual({
      margins: user,
      from: 'browser',
      asOf: null,
    });
    expect(legacyMargins({ record: null, local: user, storedBase: null, migrated: true, defaults: SEEDED, same })).toBeNull();
    const shops = chosen(SEEDED, 'margins.edgeMarginMm', 2);
    expect(shopHasOwnMargins(shops)).toBe(true);
    expect(legacyMargins({ record: null, local: user, storedBase: null, migrated: false, defaults: shops, same })).toBeNull();
  });
});

describe('a malformed thickness ± (#447 review)', () => {
  it('is dropped alone; the five thresholds beside it are kept', () => {
    const raw = { ...MARGIN_DEFAULTS, minFloor: 2, source: 'user', measuredThicknessTolerance: 'lots' };
    expect(parseMargins(raw)).toEqual({ ...MARGIN_DEFAULTS, minFloor: 2, source: 'user' });
    const strict = parseMarginsStrict(raw);
    expect(strict.ok && strict.margins.minFloor).toBe(2);
    expect(parseMargins({ ...raw, measuredThicknessTolerance: 0.1 }).measuredThicknessTolerance).toBe(0.1);
  });
});
