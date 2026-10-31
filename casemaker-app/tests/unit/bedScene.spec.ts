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
    // #779 — the drawn base runs 180 mm past the fixed face, its Y runs 8 mm past the bar each
    // way, and the clamping screw's end reaches 15 mm past the base's right end; the jaw top is
    // the measured −50. The moving jaw is parked at the provisional 60 mm opening.
    expect(s.bbox.min).toEqual([-200, -200, BED_TOP_Z - BED_PLATE_THICKNESS]);
    expect(s.bbox.max).toEqual([195, 108, -50]);
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

  it('#779 puts the fixed jaw face exactly on a measured fixedJawFaceX', () => {
    const p = profile({
      datums: { surfaceTopZ: null, viseJawTopZ: { value: -56.82, measuredAt: NOW, by: 'wired-probe', at: null }, bracketSeatZ: null, rotaryAxis: null },
      placements: [
        {
          id: 'pl-vise',
          fixture: 'fx-vise-1',
          where: { kind: 'pins', pins: 'vise', anchor: null },
          count: null,
          frame: { fixedJawFaceX: -180.375, jawStartY: -202.75 },
          provenance: { fixedJawFaceX: 'measured:2026-10-24', jawStartY: 'typed' },
        },
      ],
    });
    const s = scene([VISE_FIXTURE], p);
    const jaw = s.boxes.find((b) => b.id === 'pl-vise-fixed-jaw')!;
    expect(jaw.max[0]).toBe(-180.375);
    expect(jaw.min[0]).toBe(-180.375 - 10);
    expect(jaw.max[2]).toBe(-56.82);
    expect(jaw.kind).toBe('solid');
    // The base is the same drawn model: 200 mm across, its left end 10 mm past the jaw's outer
    // face, and it is still labelled provisional because its own plate has never been measured.
    const base = s.boxes.find((b) => b.id === 'pl-vise-base')!;
    expect(base.max[0] - base.min[0]).toBe(200);
    expect(base.kind).toBe('dashed');
    expect(base.label).toBe('provisional');
    // The moving jaw is parked, and says so.
    const moving = s.boxes.find((b) => b.id === 'pl-vise-moving-jaw')!;
    expect(moving.kind).toBe('dashed');
    expect(moving.label).toBe('provisional opening');
  });

  it('#779 without a measurement places the vise from the pins and flags it provisional', () => {
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
    const jaw = s.boxes.find((b) => b.id === 'pl-vise-fixed-jaw')!;
    // The left pin (−195) plus the drawn base's own 15 mm: the face is at −180.
    expect(jaw.max[0]).toBe(-180);
    expect(jaw.kind).toBe('dashed');
    expect(jaw.label).toBe('from the pins, not measured');
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

// #782 — the 4th-axis module drawn as it is, placed at the machine's own axis reading.
const ROTARY_FIXTURE: FixtureRecord = FixtureRecordSchema.parse({
  id: 'fx-rotary',
  kind: 'rotary-module',
  product: 'makera-4th-axis',
  variant: null,
  constants: {},
  unit: {},
  provenance: {},
});

function rotaryProfile(axis: Record<string, unknown> | null): BedProfile {
  return profile({
    datums: { surfaceTopZ: null, viseJawTopZ: null, bracketSeatZ: null, rotaryAxis: axis },
    placements: [
      {
        id: 'pl-rotary',
        fixture: 'fx-rotary',
        where: { kind: 'pins', pins: 'rotary', anchor: null },
        count: null,
        frame: null,
        provenance: {},
      },
    ],
  });
}

describe('#782 the 4th-axis module on the bed', () => {
  it('puts the axis line at the measured datum and the chuck face at the datum XY', () => {
    const s = scene([ROTARY_FIXTURE], rotaryProfile({ value: -40, measuredAt: NOW, by: 'wired-probe', at: [-155, -135] }));
    const axis = s.boxes.find((b) => b.id === 'pl-rotary-axis')!;
    // A 4 mm bar centred on the measured axis height, drawn solid: the height is a reading.
    expect(axis.min[2]).toBe(-42);
    expect(axis.max[2]).toBe(-38);
    expect(axis.kind).toBe('solid');
    // The chuck's face is the recorded datum's X; the body runs +X from it.
    const chuck = s.boxes.find((b) => b.id === 'pl-rotary-chuck')!;
    expect(chuck.min[0]).toBe(-155);
    expect(chuck.max[0]).toBe(-155 + 25);
    // The headstock is behind the chuck face, and its geometry is uncalipered: dashed.
    const head = s.boxes.find((b) => b.id === 'pl-rotary-headstock')!;
    expect(head.max[0]).toBeLessThan(-155);
    expect(head.kind).toBe('dashed');
  });

  it('draws four jaws and a parked tailstock when nothing is measured', () => {
    const s = scene([ROTARY_FIXTURE], rotaryProfile(null));
    expect(s.boxes.filter((b) => b.id.startsWith('pl-rotary-jaw-'))).toHaveLength(4);
    // The tailstock parks at the base's right end, cone facing −X.
    const tail = s.boxes.find((b) => b.id === 'pl-rotary-tailstock')!;
    const base = s.boxes.find((b) => b.id === 'pl-rotary-base')!;
    expect(tail.max[0]).toBe(base.max[0]);
    // Nothing measured: the axis line is provisional too.
    expect(s.boxes.find((b) => b.id === 'pl-rotary-axis')!.kind).toBe('dashed');
  });
});
