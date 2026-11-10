// @vitest-environment jsdom
// #509 — THE BRACKET'S SEAT COMES FROM THE BED PROFILE.
//
// The seat beside the bracket used to be the lone shop default `bracket.seatMachineZ` (#427); a bed
// profile has carried `datums.bracketSeatZ` (and, as its design fallback, `surfaceTopZ`) since #510,
// and the tap has mirrored both since #607. This pins the precedence the engine reads:
//
//   the profile's bracket seat → the profile's surface top → the legacy shop default (kept for one
//   release, removed in 1.1) → refused, naming the bed profile's seat.
//
// The probe rule is the one every datum has had since #611/#632: a datum is a raw reading taken
// through a particular probe, so a different probe checked out cannot anchor this plan on it.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { LocationViewSchema, type BedProfile, type MachineRecord } from '@/platform/locationClient';
import { resetLocationStore, useLocationStore } from '@/store/locationStore';
import { bracketPlacementSeedFor, bracketSeatDatumFor } from '@/engine/cnc/registration/mountContext';
import { gridSeeds } from '@/engine/cnc/registration/placing';
import {
  bracketExpectedSurface,
  bracketSeat,
  type BracketSeatDatum,
} from '@/engine/cnc/mounts/bracket';
import type { ShopDefaults } from '@/platform/defaultsClient';
import { withBracketPlacementSeed } from '@/platform/bedProfiles';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const HERE = dirname(fileURLToPath(import.meta.url));
const VIEW = LocationViewSchema.parse(JSON.parse(readFileSync(join(HERE, 'fixtures', 'location-doc.json'), 'utf8')));
const MACHINE = VIEW.machines[0]!;
const BASE_PROFILE = MACHINE.bedProfiles![0]!;

const datum = (value: number, by = 'fx-probe-1', measuredAt = '2026-10-18T10:00:00.000Z') => ({
  value,
  measuredAt,
  by,
  at: [10, -20] as [number, number],
});

/** The fixture machine with its one profile's datums replaced. */
function machineWith(datums: Partial<BedProfile['datums']>): MachineRecord {
  const profile: BedProfile = { ...BASE_PROFILE, datums: { ...BASE_PROFILE.datums, ...datums } };
  return { ...MACHINE, bedProfiles: [profile], activeBedProfileId: profile.id };
}

const EMPTY_DEFAULTS = {} as ShopDefaults;

beforeEach(() => resetLocationStore());
afterEach(() => resetLocationStore());

describe('#509 the bracket seat comes from the bed profile', () => {
  it('prefers the profile’s bracket seat, and falls back to its surface top', () => {
    useLocationStore.setState({ status: 'present', location: VIEW, etag: '"e1"' });
    const both = bracketSeatDatumFor(
      machineWith({
        surfaceTopZ: datum(-112.3, 'fx-probe-1', '2026-10-17T09:00:00.000Z'),
        bracketSeatZ: datum(-70.5),
      }),
    );
    // #1189 — the probe reference travels with the datum (null on a legacy reading without one).
    expect(both).toEqual({ value: -70.5, what: 'bracket seat', measuredAt: '2026-10-18T10:00:00.000Z', probeRefZ: null });

    const surfaceOnly = bracketSeatDatumFor(machineWith({ surfaceTopZ: datum(-112.3), bracketSeatZ: null }));
    expect(surfaceOnly).toMatchObject({ value: -112.3, what: 'surface top' });

    expect(bracketSeatDatumFor(machineWith({ surfaceTopZ: null, bracketSeatZ: null }))).toBeNull();
  });

  it('a datum taken through ANOTHER probe cannot anchor this plan (#611/#632)', () => {
    // The fixture checks out `fx-probe-1`; a seat recorded by another probe is skipped, and the
    // surface top recorded by the checked-out probe is what remains.
    useLocationStore.setState({ status: 'present', location: VIEW, etag: '"e1"' });
    const mixed = bracketSeatDatumFor(
      machineWith({ bracketSeatZ: datum(-70.5, 'fx-probe-3d'), surfaceTopZ: datum(-112.3, 'fx-probe-1') }),
    );
    expect(mixed).toMatchObject({ value: -112.3, what: 'surface top' });
    expect(bracketSeatDatumFor(machineWith({ bracketSeatZ: datum(-70.5, 'fx-probe-3d'), surfaceTopZ: null }))).toBeNull();
  });

  it('the plan’s expected surface names the bed datum it read, with its date', () => {
    const seat: BracketSeatDatum = { value: -70.2, what: 'bracket seat', measuredAt: '2026-10-18T10:00:00.000Z' };
    const e = bracketExpectedSurface(EMPTY_DEFAULTS, 5, 2, seat);
    expect(e).toMatchObject({ ok: true, expectedSurface: { machineZ: -63.2 } });
    if (e.ok) {
      expect(e.expectedSurface.from).toContain('the bed profile’s bracket seat');
      expect(e.expectedSurface.from).toContain('2026-10-18');
    }
    // The tap's own read resolves the same seat, so the plan and the tap cannot disagree.
    expect(bracketSeat(EMPTY_DEFAULTS, seat)).toMatchObject({ value: -70.2, source: 'the bed profile’s bracket seat' });
  });

  it('with no datum, the legacy shop default still answers — and with neither, the refusal names the bed profile', () => {
    const legacy = {
      ...EMPTY_DEFAULTS,
      'bracket.seatMachineZ': { value: -70.2, source: 'measured' as const, setAt: '2026-10-16T10:00:00.000Z', unit: 'mm', note: 'one touch' },
    } as unknown as ShopDefaults;
    const e = bracketExpectedSurface(legacy, 5, 2, null);
    expect(e).toMatchObject({ ok: true, expectedSurface: { machineZ: -63.2 } });

    const refused = bracketExpectedSurface(EMPTY_DEFAULTS, 5, 0, null);
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.reason).toContain('the bed profile’s bracket seat');
      expect(refused.reason).toContain('touch the surface beside the bracket once with the probe');
    }
  });
});

describe('#1070 (C8) a PLACED bracket’s seed — the bed profile states where it sits', () => {
  const bracketPlacement = (seed: BedProfile['placements'][number]['seed']): BedProfile['placements'][number] => ({
    id: 'pl-bracket',
    fixture: 'fx-bracket-thin',
    where: { kind: 'free' as const, pins: null, anchor: null },
    count: null,
    frame: null,
    seed,
    provenance: {},
  });

  it('the bed’s hole grid admits exactly one bracket position — anchor 1’s own corner', () => {
    const seeds = gridSeeds();
    expect(seeds).toHaveLength(1);
    expect(seeds[0]!.x).toBeCloseTo(-190.89, 2);
    expect(seeds[0]!.y).toBeCloseTo(-193.83, 2);
    expect(seeds[0]!.quarter).toBe(0);
  });

  it('a stated placement seeds a placed job; an unstated profile does not', () => {
    const stated = machineWith({});
    stated.bedProfiles = [{ ...stated.bedProfiles![0]!, placements: [bracketPlacement({ x: -182.0, y: -194.6, by: 'touch', measuredAt: '2026-11-08T00:00:00.000Z', at: [-182.0, -194.6], probe: 'fx-probe-1' })] }];
    expect(bracketPlacementSeedFor(stated)).toMatchObject({ x: -182.0, y: -194.6, by: 'touch' });
    const unstated = machineWith({});
    unstated.bedProfiles = [{ ...unstated.bedProfiles![0]!, placements: [bracketPlacement(null)] }];
    expect(bracketPlacementSeedFor(unstated)).toBeNull();
  });

  it('the writer states it on the active profile — adding the placement, then updating it in place', () => {
    const before = machineWith({});
    const first = withBracketPlacementSeed(before, { x: -190.89, y: -193.829, by: 'grid' }, '2026-11-08T01:00:00.000Z');
    expect(bracketPlacementSeedFor(first)).toMatchObject({ x: -190.89, y: -193.829, by: 'grid', measuredAt: '2026-11-08T01:00:00.000Z' });
    const placements = first.bedProfiles![0]!.placements;
    expect(placements.filter((p) => p.fixture === 'fx-bracket-thin')).toHaveLength(1);

    const second = withBracketPlacementSeed(first, { x: -182.0, y: -194.6, by: 'touch', at: { x: -182.0, y: -194.6 }, probe: 'fx-probe-1' }, '2026-11-08T02:00:00.000Z');
    expect(bracketPlacementSeedFor(second)).toMatchObject({ x: -182.0, y: -194.6, by: 'touch', probe: 'fx-probe-1' });
    expect(second.bedProfiles![0]!.placements.filter((p) => p.fixture === 'fx-bracket-thin')).toHaveLength(1);
  });
});

describe('#1077 a surface top seeds the bracket seat only when it is about the CURRENT surface', () => {
  // The fixture profile: surface thickness measured 2026-10-15T07:00, a vise jaw top recorded
  // 2026-10-23T00:00 (one vise registration).
  const VISE_AT = BASE_PROFILE.datums.viseJawTopZ!.measuredAt;

  it('a reading from the VISE registration never stands in for the bracket seat', () => {
    useLocationStore.setState({ status: 'present', location: VIEW, etag: '"e1"' });
    // The k3 case: the surface top shares its instant with the vise jaw top — it is a vised
    // blank's top, not the surface beside the bracket. The seat must come from the press instead.
    const seat = bracketSeatDatumFor(machineWith({ surfaceTopZ: datum(-55.119, 'fx-probe-1', VISE_AT), bracketSeatZ: null }));
    expect(seat).toBeNull();
  });

  it('a reading OLDER than the profile’s current surface measurement never seeds', () => {
    useLocationStore.setState({ status: 'present', location: VIEW, etag: '"e1"' });
    // Measured 2026-10-10, before the 10 mm board the profile now describes (2026-10-15): it
    // describes a surface that is gone.
    const seat = bracketSeatDatumFor(machineWith({ surfaceTopZ: datum(-112.3, 'fx-probe-1', '2026-10-10T00:00:00.000Z'), bracketSeatZ: null }));
    expect(seat).toBeNull();
  });

  it('a genuine post-measurement reading still answers, and the bracket seat still wins over it', () => {
    useLocationStore.setState({ status: 'present', location: VIEW, etag: '"e1"' });
    const current = machineWith({ surfaceTopZ: datum(-112.3, 'fx-probe-1', '2026-10-18T10:00:00.000Z'), bracketSeatZ: null });
    expect(bracketSeatDatumFor(current)).toMatchObject({ value: -112.3, what: 'surface top' });
    const withSeat = machineWith({
      surfaceTopZ: datum(-112.3, 'fx-probe-1', '2026-10-18T10:00:00.000Z'),
      bracketSeatZ: datum(-70.5, 'fx-probe-1', '2026-10-10T00:00:00.000Z'),
    });
    expect(bracketSeatDatumFor(withSeat)).toMatchObject({ value: -70.5, what: 'bracket seat' });
  });
});
