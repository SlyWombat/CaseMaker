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

  it('carries the bed model (#510): accessories, the migrated profile and its active id', () => {
    const parsed = LocationDocSchema.safeParse(doc());
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    const m = parsed.data!.machines[0]!;
    const vise = parsed.data!.accessories?.find((a) => a.id === 'fx-vise-1');
    expect(vise).toMatchObject({
      id: 'fx-vise-1',
      kind: 'vise',
      product: 'makera-z1-low-profile-vise',
      whereabouts: { kind: 'machine', machineId: m.id },
    });
    expect(vise?.constants).toMatchObject({ jawBarWidth: 10, ledgeStep: 3.1 });
    // #601 — the two owned probes, under their product names: the wired one checked out to the
    // machine with its measured tip/rim unit, the 3D one in its box, unmeasured.
    const probe = parsed.data!.accessories?.find((a) => a.id === 'fx-probe-1');
    expect(probe).toMatchObject({
      product: 'Makera Wired Probe V2',
      variant: 'wired-touch',
      whereabouts: { kind: 'machine', machineId: m.id },
    });
    expect(probe?.unit).toMatchObject({ tipDiameterMm: 2.0, rimOffsetMm: 0.7, rimOffsetUncertaintyMm: 0.25 });
    const probe3d = parsed.data!.accessories?.find((a) => a.id === 'fx-probe-3d');
    expect(probe3d).toMatchObject({
      product: 'Makera 3D Wired Probe',
      variant: '3d',
      whereabouts: { kind: 'box' },
    });
    expect(probe3d?.unit).toMatchObject({ tipDiameterMm: null, rimOffsetMm: null, rimOffsetUncertaintyMm: null });
    // #601 — the jaw-top datum was tapped by the wired probe accessory, so `by` is its id.
    expect(m.bedProfiles?.[0]?.datums.viseJawTopZ).toMatchObject({ by: 'fx-probe-1' });
    expect(m.bedProfiles?.[0]).toMatchObject({
      id: 'bp-migrated-2026-10-15',
      name: 'Current bed (migrated 2026-10-15)',
      surface: { kind: 'wasteboard', thickness: 10 },
    });
    expect(m.bedProfiles?.[0]?.datums.bracketSeatZ).toMatchObject({
      value: -70.2,
      by: 'wired-probe',
    });
    expect(m.activeBedProfileId).toBe(m.bedProfiles?.[0]?.id);
  });

  it('round-trips a machine from before the bed without gaining its keys (#510)', () => {
    const d = doc();
    const m = d.machines[0]!;
    delete d.accessories;
    delete m.bedProfiles;
    delete m.activeBedProfileId;
    const parsed = LocationDocSchema.safeParse(d);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    const text = JSON.stringify(parsed.data);
    // The keys are `.optional()`, not defaulted: an old document must not gain them on the way
    // through this build (the issue's byte-for-byte rule).
    expect(text).not.toContain('accessories');
    expect(text).not.toContain('bedProfiles');
    expect(text).not.toContain('activeBedProfileId');
    // The legacy section that shares the design's word "fixtures" is still there.
    expect(parsed.data!.machines[0]!.fixtures?.vise?.source).toBe('measured');
  });

  it.each<[string, (d: Doc) => void]>([
    ['a margins section with no source', (d) => delete (d.machines[0]!.margins as Record<string, unknown>).source],
    ['a vise missing a jaw', (d) => delete ((d.machines[0]!.fixtures as { vise: Record<string, unknown> }).vise.jawLength)],
    ['a calibration with no date', (d) => delete (d.machines[0]!.calibration as Record<string, unknown>).measuredAt],
    ['one machine twice', (d) => d.machines.push({ ...d.machines[0]! })],
    ['a future version', (d) => (d.schemaVersion = 2)],
    ['a duplicate tool key', (d) => ((d.tools[1] as { key: string }).key = (d.tools[0] as { key: string }).key)],
    [
      'a datum typed by hand',
      (d) => {
        const profile = (d.machines[0]!.bedProfiles as Array<Record<string, unknown>>)[0]!;
        const datums = profile.datums as { bracketSeatZ: { by: string } };
        datums.bracketSeatZ.by = 'typed';
      },
    ],
    ['an active bed profile the machine does not have', (d) => (d.machines[0]!.activeBedProfileId = 'bp-elsewhere')],
    [
      'a placement of a fixture the machine does not own',
      (d) => {
        const profile = (d.machines[0]!.bedProfiles as Array<{ placements: Array<Record<string, unknown>> }>)[0]!;
        profile.placements[0]!.fixture = 'fx-elsewhere';
      },
    ],
    [
      'the vise and the rotary module on the shared pins',
      (d) => {
        const m = d.machines[0]!;
        const fixtures = d.accessories as Array<Record<string, unknown>>;
        fixtures.push({ ...fixtures[0]!, id: 'fx-rotary', kind: 'rotary-module' });
        const profile = (m.bedProfiles as Array<{ placements: Array<Record<string, unknown>> }>)[0]!;
        profile.placements.push({
          id: 'pl-rotary',
          fixture: 'fx-rotary',
          where: { kind: 'pins', pins: 'rotary', anchor: null },
          count: null,
          frame: null,
          provenance: {},
        });
      },
    ],
    [
      'an unknown key in a bed profile',
      (d) => {
        const profile = (d.machines[0]!.bedProfiles as Array<Record<string, unknown>>)[0]!;
        profile.surprise = true;
      },
    ],
    [
      'a bare bed that still carries a thickness',
      (d) => {
        const profile = (d.machines[0]!.bedProfiles as Array<{ surface: Record<string, unknown> }>)[0]!;
        profile.surface.kind = 'bare-bed';
      },
    ],
    [
      'a wasteboard with no thickness',
      (d) => {
        const profile = (d.machines[0]!.bedProfiles as Array<{ surface: Record<string, unknown> }>)[0]!;
        profile.surface.thickness = null;
      },
    ],
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
