// #511 — the bed scene's geometry, pinned: the bbox per placement, and the surface's solid/dashed
// reading. Pure, like `bedProfiles.spec.ts` / `cncFixture.spec.ts`: no React, no stores.

import { describe, expect, it } from 'vitest';
import { Z1 } from '@/engine/cnc/machine';
import {
  bedScene,
  BED_PLATE_THICKNESS,
  BED_TOP_Z,
  type BedSceneInput,
} from '@/engine/cnc/bedScene';
import {
  BedProfileSchema,
  FixtureRecordSchema,
  type BedProfile,
  type FixtureRecord,
} from '@/platform/locationClient';

const NOW = '2026-10-19T12:00:00.000Z';

/** The measured vise fixture the migrated record carries (its unit body dims still unmeasured). */
const VISE_FIXTURE: FixtureRecord = FixtureRecordSchema.parse({
  id: 'fx-vise-1',
  kind: 'vise',
  product: 'makera-z1-low-profile-vise',
  variant: null,
  constants: { jawBarWidth: 10, jawLength: 100, ledgeStep: 3.1, ledgeWidth: 1.9 },
  unit: { jawBarHeight: null, bodyHeight: null, maxOpening: null },
  provenance: { jawBarWidth: 'measured', jawLength: 'measured' },
});

function profile(overrides: Record<string, unknown> = {}): BedProfile {
  return BedProfileSchema.parse({
    id: 'bp-test',
    name: 'Test bed',
    createdAt: NOW,
    basedOn: null,
    surface: { kind: 'bare-bed' },
    datums: { surfaceTopZ: null, viseJawTopZ: null, bracketSeatZ: null, rotaryAxis: null },
    placements: [],
    ...overrides,
  });
}

function scene(fixtures: FixtureRecord[], p: BedProfile): ReturnType<typeof bedScene> {
  return bedScene({ mill: Z1, fixtures, profile: p } satisfies BedSceneInput);
}

describe('#511 the bed scene bbox is pinned per placement', () => {
  it('the bare bed with no placements is the 200×200 plate plus the provisional pin pair', () => {
    const s = scene([], profile());
    // The plate: X/Y [-200, 0], Z from BED_TOP_Z - thickness to BED_TOP_Z.
    // The pins stand `PIN_DIAMETER * 2.75` (11 mm) above the bed top, so they set the top of the box.
    expect(s.bbox.min).toEqual([-200, -200, BED_TOP_Z - BED_PLATE_THICKNESS]);
    expect(s.bbox.max).toEqual([0, 0, BED_TOP_Z + 4 * 2.75]);
  });

  it('adding a measured vise placement pins the bbox to the vise (X, Y and Z grow)', () => {
    const p = profile({
      datums: { surfaceTopZ: null, viseJawTopZ: { value: -50, measuredAt: NOW, by: 'wired-probe', at: null }, bracketSeatZ: null, rotaryAxis: null },
      placements: [
        {
          id: 'pl-vise',
          fixture: 'fx-vise-1',
          where: { kind: 'pins', pins: 'vise', anchor: null },
          count: null,
          frame: { fixedJawFaceX: 0, jawStartY: 0 },
          provenance: { fixedJawFaceX: 'measured', jawStartY: 'typed' },
        },
      ],
    });
    const s = scene([VISE_FIXTURE], p);
    // The jaws span X to the moving jaw + its 10 mm bar (opening 60) and the body's 5 mm margin →
    // 75; Y to jawStartY + jawLength (100); Z up to the measured jaw top (-50).
    expect(s.bbox.min).toEqual([-200, -200, BED_TOP_Z - BED_PLATE_THICKNESS]);
    expect(s.bbox.max).toEqual([75, 100, -50]);
  });

  it('a provisional (unmeasured) vise still contributes boxes, drawn dashed', () => {
    const p = profile({
      placements: [
        {
          id: 'pl-vise',
          fixture: 'fx-vise-1',
          where: { kind: 'pins', pins: 'vise', anchor: null },
          count: null,
          frame: null,
          provenance: {},
        },
      ],
    });
    const s = scene([VISE_FIXTURE], p);
    const jaws = s.boxes.filter((b) => b.id.startsWith('pl-vise'));
    expect(jaws.length).toBeGreaterThan(0);
    // Nothing measured → the fixed jaw is dashed "provisional".
    expect(jaws.every((b) => b.kind === 'dashed')).toBe(true);
    expect(jaws.some((b) => b.label === 'provisional')).toBe(true);
  });
});

describe('#511 the surface slab', () => {
  const boardSurface = {
    kind: 'wasteboard',
    material: 'MDF',
    length: 200,
    width: 200,
    thickness: 10,
    position: { frontLeft: [-200, -200], frame: 'machine' },
    provenance: { thickness: 'measured' },
  };

  it('is solid at its measured top', () => {
    const p = profile({
      surface: boardSurface,
      datums: { surfaceTopZ: { value: -70, measuredAt: NOW, by: 'wired-probe', at: null }, viseJawTopZ: null, bracketSeatZ: null, rotaryAxis: null },
    });
    const s = scene([], p);
    const slab = s.boxes.find((b) => b.id === 'surface')!;
    expect(slab.kind).toBe('solid');
    expect(slab.min[2]).toBe(-80); // top - thickness
    expect(slab.max[2]).toBe(-70); // the measured top
  });

  it('is dashed "top: no reading" when the top has no datum', () => {
    const p = profile({ surface: boardSurface });
    const s = scene([], p);
    const slab = s.boxes.find((b) => b.id === 'surface')!;
    expect(slab.kind).toBe('dashed');
    expect(slab.label).toBe('top: no reading');
    // The nominal top: BED_TOP_Z + thickness.
    expect(slab.max[2]).toBe(BED_TOP_Z + 10);
  });

  it('the bare bed draws no separate slab (the plate is the surface, open question E)', () => {
    const s = scene([], profile());
    expect(s.boxes.some((b) => b.id === 'surface')).toBe(false);
    expect(s.boxes.some((b) => b.id === 'bed-plate')).toBe(true);
  });
});
