// #510 — the bed model's four migrations, pinned.
//
// One test per source the design names (`docs/design/bed-profiles.md` §2):
//   wasteboard → surface · fixtures.vise → the vise fixture's unit · bracket.seatMachineZ → a datum
//   · a registration's measured jaw faces → the vise placement's frame.
// Then the rules around them: the migrated profile's name and active id, nothing deleted, the
// marker that stops a second run, a bare bed where there is no wasteboard, and the output still
// parsing under the same `MachineRecordSchema` the service's records are read with.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  bedFromLegacy,
  bedMigrationDue,
  changedBedProfile,
  newestViseRegistration,
  switchActiveProfile,
  type RegistrationSource,
} from '@/platform/bedProfiles';
import type { ShopDefaults } from '@/platform/defaultsClient';
import { MachineRecordSchema, type MachineRecord } from '@/platform/locationClient';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, 'fixtures', 'location-doc.json');
const NOW = '2026-10-15T12:00:00.000Z';

/** The shared fixture's machine without the bed keys: a machine from before #510. */
function legacyMachine(overrides: Record<string, unknown> = {}): MachineRecord {
  const raw = (JSON.parse(readFileSync(FIXTURE, 'utf8')) as {
    machines: Array<Record<string, unknown>>;
  }).machines[0]!;
  const { bedFixtures: _f, bedProfiles: _p, activeBedProfileId: _a, ...legacy } = raw;
  const parsed = MachineRecordSchema.safeParse({ ...legacy, ...overrides });
  expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  return parsed.data!;
}

const MEASURED_SEAT: ShopDefaults = {
  'bracket.seatMachineZ': {
    value: -70.2,
    source: 'measured',
    setAt: '2026-10-16T10:00:00.000Z',
    unit: 'mm',
    note: 'one touch beside the bracket',
  },
};

describe('the bed migrations (#510)', () => {
  it('moves the wasteboard into the surface, keeping its scars and dates', () => {
    const machine = legacyMachine();
    const migrated = bedFromLegacy(machine, MEASURED_SEAT, null, NOW)!;
    const surface = migrated.bedProfiles[0]!.surface;

    expect(surface.kind).toBe('wasteboard');
    expect(surface.thickness).toBe(10.0);
    expect(surface.provenance.thickness).toBe('measured:2026-10-15T07:00:00.000Z');
    expect(surface.lastResurfacedAt).toBeNull();
    expect(surface.scars).toEqual(machine.wasteboard!.scars);
    // A copy, not the legacy array: editing one must not change the other.
    expect(surface.scars).not.toBe(machine.wasteboard!.scars);
  });

  it('moves the vise settings into the vise accessory record, provenance included', () => {
    const migrated = bedFromLegacy(legacyMachine(), MEASURED_SEAT, null, NOW)!;
    const fixture = migrated.accessories[0]!;

    expect(fixture).toMatchObject({
      id: 'fx-vise-1',
      kind: 'vise',
      product: 'makera-z1-low-profile-vise',
      variant: null,
    });
    // The product constants are #208's measured figures, not new claims.
    expect(fixture.constants).toMatchObject({
      jawBarWidth: 10,
      jawLength: 100,
      ledgeStep: 3.1,
      ledgeWidth: 1.9,
    });
    // Everything the legacy settings record carried is in the unit map, so nothing is lost.
    expect(fixture.unit).toMatchObject({
      stockProud: 1.5,
      fixedJawThickness: 10,
      movingJawThickness: 10,
      jawLength: 100,
      jawStartY: -10,
      uncertainty: 0.1,
    });
    expect(fixture.provenance.fixedJawThickness).toBe('measured:2026-10-13T12:00:00.000Z');
    // The body dimensions no one has measured are present as unmeasured, never guessed.
    expect(fixture.unit.jawBarHeight).toBeNull();
    expect(fixture.provenance.jawBarHeight).toBe('unmeasured');
  });

  it('carries a MEASURED bracket seat into datums.bracketSeatZ; a chosen one is not a datum', () => {
    const machine = legacyMachine();
    const migrated = bedFromLegacy(machine, MEASURED_SEAT, null, NOW)!;
    expect(migrated.bedProfiles[0]!.datums.bracketSeatZ).toEqual({
      value: -70.2,
      measuredAt: '2026-10-16T10:00:00.000Z',
      by: 'wired-probe',
      at: null,
    });

    const chosen: ShopDefaults = {
      'bracket.seatMachineZ': { ...MEASURED_SEAT['bracket.seatMachineZ']!, source: 'chosen' },
    };
    expect(bedFromLegacy(machine, chosen, null, NOW)!.bedProfiles[0]!.datums.bracketSeatZ).toBeNull();
    // A measured value with no date cannot become a dated datum.
    const undated: ShopDefaults = {
      'bracket.seatMachineZ': { ...MEASURED_SEAT['bracket.seatMachineZ']!, setAt: null },
    };
    expect(bedFromLegacy(machine, undated, null, NOW)!.bedProfiles[0]!.datums.bracketSeatZ).toBeNull();
  });

  it("places the vise frame from the registration outcome's measured jaw faces", () => {
    const machine = legacyMachine();
    const migrated = bedFromLegacy(
      machine,
      MEASURED_SEAT,
      { measuredAt: '2026-10-16T09:00:00.000Z', correctedG54: { x: -0.1, y: 0.0 } },
      NOW,
    )!;
    const placement = migrated.bedProfiles[0]!.placements[0]!;

    expect(placement).toMatchObject({
      id: 'pl-vise',
      fixture: 'fx-vise-1',
      where: { kind: 'pins', pins: 'vise' },
    });
    // The corrected G54 is the stock's front-left corner in machine XY: X against the fixed jaw
    // face, Y the front edge. The bar starts `jawStartY` (-10) from that edge.
    expect(placement.frame).toEqual({ fixedJawFaceX: -0.1, jawStartY: -10.0 });
    expect(placement.provenance).toEqual({
      fixedJawFaceX: 'measured:2026-10-16T09:00:00.000Z',
      jawStartY: 'typed',
    });

    // No registration: the placement still exists (the vise is on the bed), without a frame.
    const unplaced = bedFromLegacy(machine, MEASURED_SEAT, null, NOW)!;
    expect(unplaced.bedProfiles[0]!.placements[0]!.frame).toBeNull();
  });

  it('names the migrated profile and makes it the active one', () => {
    const migrated = bedFromLegacy(legacyMachine(), MEASURED_SEAT, null, NOW)!;
    expect(migrated.activeBedProfileId).toBe('bp-migrated-2026-10-15');
    expect(migrated.bedProfiles).toHaveLength(1);
    expect(migrated.bedProfiles[0]).toMatchObject({
      id: 'bp-migrated-2026-10-15',
      name: 'Current bed (migrated 2026-10-15)',
      createdAt: NOW,
      basedOn: null,
    });
    expect(migrated.bedProfiles[0]!.history[0]!.what).toContain('migrating');
  });

  it('is in place: nothing is deleted from the legacy machine', () => {
    const machine = legacyMachine();
    const before = structuredClone(machine);
    bedFromLegacy(machine, MEASURED_SEAT, null, NOW);
    expect(machine).toEqual(before);
    expect(machine.wasteboard).not.toBeNull();
    expect(machine.fixtures?.vise).toBeDefined();
  });

  it('describes a bare bed when there is no wasteboard (open question E)', () => {
    const machine = legacyMachine({ wasteboard: null });
    const surface = bedFromLegacy(machine, MEASURED_SEAT, null, NOW)!.bedProfiles[0]!.surface;
    expect(surface).toEqual({
      kind: 'bare-bed',
      material: null,
      length: null,
      width: null,
      thickness: null,
      position: null,
      provenance: {},
      scars: [],
      lastResurfacedAt: null,
    });
  });

  it('does nothing when there is nothing to migrate, or when the bed is already described', () => {
    const empty = legacyMachine({ wasteboard: null, fixtures: null });
    expect(bedFromLegacy(empty, null, null, NOW)).toBeNull();

    // `[]` is a deliberately emptied description, not "not described": the marker is the KEY.
    const described = legacyMachine({ bedProfiles: [], bedFixtures: [] });
    expect(bedMigrationDue(described)).toBe(false);
    expect(bedFromLegacy(described, MEASURED_SEAT, null, NOW)).toBeNull();
  });

  it('produces a record the same schema accepts', () => {
    const machine = legacyMachine();
    const migrated = bedFromLegacy(
      machine,
      MEASURED_SEAT,
      { measuredAt: '2026-10-16T09:00:00.000Z', correctedG54: { x: -0.1, y: 2.0 } },
      NOW,
    )!;
    const parsed = MachineRecordSchema.safeParse({ ...machine, ...migrated });
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });
});

describe('#511 the Bed block\'s pure actions', () => {
  it('I changed the bed copies the active profile into a new dated one, clearing and listing the datums', () => {
    const migrated = bedFromLegacy(legacyMachine(), MEASURED_SEAT, null, NOW)!;
    const active = migrated.bedProfiles[0]!;
    const { profile, cleared } = changedBedProfile(active, 'bp-new', '2026-10-19T10:00:00.000Z');

    expect(profile.id).toBe('bp-new');
    expect(profile.name).toBe('Bed changed 2026-10-19');
    expect(profile.basedOn).toBe(active.id);
    // Every datum cleared — whatever changed, nothing measured on the old bed still holds.
    expect(profile.datums).toEqual({ surfaceTopZ: null, viseJawTopZ: null, bracketSeatZ: null, rotaryAxis: null });
    // The cleared datums are listed by name, and the surface's scars go with the surface datum.
    expect(cleared).toEqual(['bracket seat', 'surface scars']);
    expect(profile.surface.scars).toEqual([]);
    expect(profile.history.at(-1)!.what).toContain('after the bed changed');
    // The old profile is untouched.
    expect(active.datums.bracketSeatZ).not.toBeNull();
    expect(active.surface.scars.length).toBeGreaterThan(0);
  });

  it('Switch re-names which profile is active, never editing the list', () => {
    const machine = legacyMachine();
    const migrated = bedFromLegacy(machine, MEASURED_SEAT, null, NOW)!;
    const withBed = { ...machine, ...migrated };
    const switched = switchActiveProfile(withBed, 'bp-other', '2026-10-19T10:00:00.000Z');
    expect(switched.activeBedProfileId).toBe('bp-other');
    expect(switched.bedProfiles).toEqual(withBed.bedProfiles);
  });
});

describe('which registration the migration reads (#510)', () => {
  const target = { host: '192.0.2.10', port: 2222 };
  const source = (
    measuredAt: string,
    overrides: Partial<RegistrationSource> = {},
  ): RegistrationSource => ({
    target,
    plan: { mount: 'vise' },
    outcome: { usable: true, correctedG54: { x: 1, y: 2 } },
    measuredAt,
    ...overrides,
  });

  it("takes the newest usable VISE registration on this machine's address", () => {
    const picked = newestViseRegistration(
      [
        source('2026-10-15T08:00:00.000Z'),
        source('2026-10-16T09:00:00.000Z', { outcome: { usable: true, correctedG54: { x: -0.1, y: 0 } } }),
        source('2026-10-17T09:00:00.000Z', { plan: { mount: 'bracket' } }),
        source('2026-10-18T09:00:00.000Z', { outcome: { usable: false, correctedG54: { x: 9, y: 9 } } }),
        source('2026-10-19T09:00:00.000Z', { target: { host: '192.0.2.11', port: 2222 } }),
      ],
      target,
    );
    expect(picked).toEqual({
      measuredAt: '2026-10-16T09:00:00.000Z',
      correctedG54: { x: -0.1, y: 0 },
    });
  });

  it('answers null with no address or no matching readable outcome', () => {
    expect(newestViseRegistration([source('2026-10-16T09:00:00.000Z')], null)).toBeNull();
    expect(newestViseRegistration([], target)).toBeNull();
    expect(newestViseRegistration([source('2026-10-16T09:00:00.000Z', { plan: { mount: 'tape' } })], target)).toBeNull();
  });
});
