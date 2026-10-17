// The location contract (#412): ONE document, TWO implementations, as `houseContract.spec.ts` is for
// the house. The specimen is `fixtures/location-doc.json`, which `house.rs`'s
// `the_shared_location_fixture_round_trips_through_export_and_import` imports, serves and exports.
// This side asserts that the client's schemas accept the same document — the machine's sections
// through the very parsers the "my machine" import uses — and that a document broken in the ways
// the client must refuse is refused.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  LOCATION_KIND,
  LocationDocSchema,
  LocationViewSchema,
  checkLocationImport,
} from '@/platform/locationClient';
import { parseFixturesStrict, parseMarginsStrict } from '@/store/settingsStore';
import { parseMachineCalibration } from '@/engine/cnc/calibration';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, 'fixtures', 'location-doc.json');

type Doc = Record<string, unknown> & { machines: Array<Record<string, unknown>>; tools: unknown[] };

function doc(): Doc {
  return JSON.parse(readFileSync(FIXTURE, 'utf8')) as Doc;
}

describe('the location contract (#412)', () => {
  it('parses the whole document the service exports, tool tiers and machine sections included', () => {
    const parsed = LocationDocSchema.safeParse(doc());
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    const loc = parsed.data!;
    expect(loc.kind).toBe(LOCATION_KIND);
    expect(loc.tools.map((t) => t.key)).toEqual(['user:1a2b3c4d5e', 'user:6f7a8b9c0d']);
    expect(loc.inventory[0]?.codes[0]?.value).toBe('C1-BIT-BALL-NOSE-1-4');
    const m = loc.machines[0]!;
    expect(m.serial).toBeNull();
    expect(m.fixtures?.vise?.source).toBe('measured');
    expect(m.calibration?.machineId).toBe('Z1');
    expect(m.margins?.source).toBe('user');
    // #450 slice 5: the fixture carries the feeds table the service seeds, every row labelled
    // seeded and the V row among them — not a separate specimen that could drift.
    expect(loc.feeds).toHaveLength(12);
    expect(loc.feeds.every((row) => row.source === 'seeded')).toBe(true);
    expect(loc.feeds.some((row) => row.edge === 'v')).toBe(true);
  });

  it('holds each machine section to the strict parser the "my machine" import uses', () => {
    const m = doc().machines[0]!;
    expect(parseFixturesStrict(m.fixtures).ok).toBe(true);
    expect(parseMarginsStrict(m.margins).ok).toBe(true);
    expect(parseMachineCalibration(m.calibration).ok).toBe(true);
  });

  it('parses the served body, which is the document without its tool tiers', () => {
    const { tools: _t, inventory: _i, ...view } = doc();
    const parsed = LocationViewSchema.safeParse(view);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it.each<[string, (d: Doc) => void]>([
    ['a margins section with no source', (d) => delete (d.machines[0]!.margins as Record<string, unknown>).source],
    ['a vise missing a jaw', (d) => delete ((d.machines[0]!.fixtures as { vise: Record<string, unknown> }).vise.jawLength)],
    ['a calibration with no date', (d) => delete (d.machines[0]!.calibration as Record<string, unknown>).measuredAt],
    ['one machine twice', (d) => d.machines.push({ ...d.machines[0]! })],
    ['a future version', (d) => (d.schemaVersion = 2)],
    ['a duplicate tool key', (d) => ((d.tools[1] as { key: string }).key = (d.tools[0] as { key: string }).key)],
  ])('refuses %s, and an import of it is refused before it is sent', (_why, breakIt) => {
    const d = doc();
    breakIt(d);
    expect(LocationDocSchema.safeParse(d).success).toBe(false);
    const check = checkLocationImport(JSON.stringify(d));
    expect(check.kind).toBe('refused');
  });

  it('reads the served machines one at a time: a malformed one is set aside, not the whole location (#412 review)', () => {
    const { tools: _t, inventory: _i, ...view } = doc();
    const bad = { ...view.machines[0]!, id: 'machine-bad', margins: { source: 'guessed' } };
    const parsed = LocationViewSchema.safeParse({ ...view, machines: [view.machines[0], bad] });
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    expect(parsed.data!.machines.map((m) => m.id)).toEqual(['machine-1a2b3c']);
    expect(parsed.data!.unreadableMachines).toHaveLength(1);
    expect(parsed.data!.unreadableMachines[0]!.id).toBe('machine-bad');
    expect(parsed.data!.unreadableMachines[0]!.reason).toContain('margins');
  });

  it('reads a location from before the shelf (no `stock` key) with an empty one (#413 review)', () => {
    const { stock: _s, ...older } = doc() as Doc & { stock?: unknown };
    const parsed = LocationDocSchema.safeParse(older);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    expect(parsed.data!.stock).toEqual([]);
  });

  it('carries the feeds table (#450): absent reads empty, present is held to the whole-table rule', () => {
    const { feeds: _f, ...older } = doc() as Doc & { feeds?: unknown };
    const absent = LocationDocSchema.safeParse(older);
    expect(absent.success, JSON.stringify(absent.error?.issues)).toBe(true);
    expect(absent.data!.feeds).toEqual([]);

    const good = (
      JSON.parse(readFileSync(join(HERE, 'fixtures', 'feed-table.json'), 'utf8')) as { good: unknown[] }
    ).good;
    const present = LocationDocSchema.safeParse({ ...older, feeds: good });
    expect(present.success, JSON.stringify(present.error?.issues)).toBe(true);
    expect(present.data!.feeds).toHaveLength(12);

    // The cross-row rule travels with the document through the same `superRefine`.
    const overlap = [
      good[0],
      { ...(good[1] as Record<string, unknown>), id: 'feed-overlap', minDiameter: 1.0 },
    ];
    expect(LocationDocSchema.safeParse({ ...older, feeds: overlap }).success).toBe(false);
  });

  it('leaves a house file, and anything else, to the service to judge', () => {
    expect(checkLocationImport('{"kind":"casemaker-house","schemaVersion":1}').kind).toBe('other');
    expect(checkLocationImport('not json').kind).toBe('other');
    expect(checkLocationImport(readFileSync(FIXTURE, 'utf8')).kind).toBe('location');
  });
});
