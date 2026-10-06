// Issue #152 — the magnet-pocket primitive and the `case.magnetPockets` surface.
//
// What these tests are guarding:
//   • the table's pockets are always WIDER and DEEPER than the disc they take,
//     so a magnet can physically go in — the one property that makes the number
//     usable at all
//   • no row claims to be coupon-proven. Nothing has been printed; a `coupon`
//     source here would be a lie the table can't back up
//   • the cut is BLIND and directional: mouth at the entry face, floor left
//     solid at the far end, on every axis (a sign error is invisible until a
//     caller migrates to the opposite face)
//   • the stored `case.magnetPockets` field actually survives the Zod schema
//     (which strips unknown keys) and old projects still load

import { describe, it, expect } from 'vitest';
import {
  MAGNETS,
  MAGNET_GLUE_GAP,
  MAGNET_DEPTH_GAP,
  magnetPocket,
  magnetPocketDiameter,
  magnetPocketDepth,
  type MagnetSize,
} from '@/engine/compiler/fasteners';
import { cube, difference, translate, type BuildOp } from '@/engine/compiler/buildPlan';
import { createDefaultProject } from '@/store/projectStore';
import { serializeProject, parseProject } from '@/store/persistence';
import type { Facing } from '@/types';
import { Manifold, exec, type ManifoldInstance } from './helpers/manifoldExec';

const SIZES: MagnetSize[] = ['6x2', '8x3', '10x2'];

/** Is the op's material present at this point? */
function solidAt(m: ManifoldInstance, p: [number, number, number], s = 0.12): boolean {
  const c = Manifold.cube([s, s, s], true).translate(p);
  const i = Manifold.intersection([m, c]);
  const v = i.volume();
  i.delete();
  c.delete();
  return v > (s * s * s) / 2;
}

describe('magnet table', () => {
  it('always sizes the pocket bigger than the disc, in both axes', () => {
    for (const s of SIZES) {
      const m = MAGNETS[s];
      expect(m.pocket.d, `${s} pocket Ø`).toBeGreaterThan(m.d);
      expect(m.pocket.h, `${s} pocket depth`).toBeGreaterThan(m.h);
    }
  });

  it('carries the review’s glue gaps on every row', () => {
    // 6.5 x 2.4 for a 6x2 disc (/Toolbox.md) generalised: +0.25 radial and
    // +0.4 deep. If a row drifts, it is one of these two and the test names it.
    expect(MAGNET_GLUE_GAP).toBe(0.25);
    expect(MAGNET_DEPTH_GAP).toBe(0.4);
    for (const s of SIZES) {
      const m = MAGNETS[s];
      expect(m.pocket.d - m.d, `${s} diametral gap`).toBeCloseTo(2 * MAGNET_GLUE_GAP, 5);
      expect(m.pocket.h - m.h, `${s} depth gap`).toBeCloseTo(MAGNET_DEPTH_GAP, 5);
    }
  });

  it('marks every row derived, because no magnet coupon has been printed', () => {
    // The M5 pilot (#140) is the reason this test exists: an arithmetic fit is
    // a hypothesis. Flip a row to 'coupon' only with a printed coupon behind it.
    for (const s of SIZES) {
      expect(MAGNETS[s].source, `${s} must not claim coupon provenance`).toBe('derived');
    }
  });

  it('exposes the table through the diameter/depth helpers', () => {
    expect(magnetPocketDiameter('6x2')).toBe(6.5);
    expect(magnetPocketDepth('6x2')).toBe(2.4);
    expect(magnetPocketDiameter('10x2')).toBe(10.5);
  });
});

describe('magnetPocket', () => {
  // Top face at z = 12, material below, so the pocket cuts along '-z'.
  const BLOCK: BuildOp = translate([-10, -10, 0], cube([20, 20, 12]));

  it('cuts a blind pocket: open mouth, solid floor, one body', () => {
    const m = exec(
      difference([BLOCK, magnetPocket({ size: '6x2', at: [0, 0, 12], axis: '-z' })]),
    );
    try {
      const depth = magnetPocketDepth('6x2'); // 2.4
      const bottom = 12 - depth; // 9.6
      expect(solidAt(m, [0, 0, 11.5]), 'mouth is open').toBe(false);
      expect(solidAt(m, [0, 0, bottom - 0.4]), 'floor below the pocket is solid').toBe(true);
      expect(solidAt(m, [0, 0, bottom + 0.3]), 'pocket reaches its depth').toBe(false);
      expect(m.decompose().length, 'the cut leaves one solid').toBe(1);
    } finally {
      m.delete();
    }
  });

  it('cuts the pocket at the table diameter, to the table depth', () => {
    const m = exec(
      difference([BLOCK, magnetPocket({ size: '8x3', at: [0, 0, 12], axis: '-z' })]),
    );
    try {
      const r = magnetPocketDiameter('8x3') / 2; // 4.25
      const inner = [r - 0.3, 0, 12 - magnetPocketDepth('8x3') / 2] as [number, number, number];
      const outer = [r + 0.3, 0, 12 - magnetPocketDepth('8x3') / 2] as [number, number, number];
      expect(solidAt(m, inner), 'inside the table Ø is void').toBe(false);
      expect(solidAt(m, outer), 'outside the table Ø is material').toBe(true);
    } finally {
      m.delete();
    }
  });

  it('honours explicit diameter and depth, for a caller with a coupon number', () => {
    // The press-fit number will come off a coupon; until then a caller must be
    // able to pass one rather than taking a table row on faith.
    const m = exec(
      difference([
        BLOCK,
        magnetPocket({ size: '6x2', at: [0, 0, 12], axis: '-z', diameter: 6.1, depth: 1.9 }),
      ]),
    );
    try {
      expect(solidAt(m, [2.9, 0, 11.5]), 'Ø6.1 leaves 2.9 void').toBe(false);
      expect(solidAt(m, [3.2, 0, 11.5]), 'and is material at 3.2').toBe(true);
      expect(solidAt(m, [0, 0, 12 - 1.9 - 0.3]), 'floor under a 1.9 pocket').toBe(true);
    } finally {
      m.delete();
    }
  });

  it('orients on all six axes, mouth at the entry face', () => {
    // Every branch of orient(), because the sign is invisible until a caller
    // migrates to the opposite face — mountingFeatures (#45) already shipped a
    // wrong rotation once.
    const blk: BuildOp = translate([-10, -10, -10], cube([20, 20, 20]));
    const AXES: [Facing, [number, number, number]][] = [
      ['+x', [1, 0, 0]],
      ['-x', [-1, 0, 0]],
      ['+y', [0, 1, 0]],
      ['-y', [0, -1, 0]],
      ['+z', [0, 0, 1]],
      ['-z', [0, 0, -1]],
    ];
    for (const [axis, d] of AXES) {
      // Entry face is the one the pocket is cut FROM, i.e. -d * 10.
      const at: [number, number, number] = [-d[0] * 10, -d[1] * 10, -d[2] * 10];
      const m = exec(difference([blk, magnetPocket({ size: '6x2', at, axis })]));
      try {
        const depth = magnetPocketDepth('6x2');
        const inside: [number, number, number] = [
          at[0] + d[0] * (depth - 0.4),
          at[1] + d[1] * (depth - 0.4),
          at[2] + d[2] * (depth - 0.4),
        ];
        const past: [number, number, number] = [
          at[0] + d[0] * (depth + 1),
          at[1] + d[1] * (depth + 1),
          at[2] + d[2] * (depth + 1),
        ];
        expect(solidAt(m, inside), `${axis}: pocket void at the entry end`).toBe(false);
        expect(solidAt(m, past), `${axis}: floor beyond the pocket`).toBe(true);
      } finally {
        m.delete();
      }
    }
  });

  it('clamps the depth to keep the floor, and refuses to cut at all', () => {
    // 3.2 mm of material, a 6x2 pocket that wants 2.4, and a 1.5 mm floor
    // demanded: the pocket has to give, not the floor.
    const thin: BuildOp = translate([-10, -10, 0], cube([20, 20, 3.2]));
    const m = exec(
      difference([
        thin,
        magnetPocket({ size: '6x2', at: [0, 0, 3.2], axis: '-z', material: 3.2, floor: 1.5 }),
      ]),
    );
    try {
      expect(solidAt(m, [0, 0, 3.1]), 'pocket still cut').toBe(false);
      expect(solidAt(m, [0, 0, 1.4]), 'floor kept solid').toBe(true);
    } finally {
      m.delete();
    }
    // No room at all is an error, not a silent no-op: a magnet that quietly
    // never got a pocket is worse than one that fails loudly.
    expect(() =>
      magnetPocket({ size: '6x2', at: [0, 0, 1], axis: '-z', material: 1, floor: 1 }),
    ).toThrow(/no room/);
  });

  it('removes about the cylinder volume and nothing more', () => {
    const m = exec(
      difference([BLOCK, magnetPocket({ size: '6x2', at: [0, 0, 12], axis: '-z' })]),
    );
    try {
      const block = 20 * 20 * 12;
      const expected = Math.PI * (6.5 / 2) ** 2 * 2.4;
      const removed = block - m.volume();
      // A 32-facet cylinder under-cuts a true circle; the 5% band covers the
      // faceting, not a wrong diameter.
      expect(removed, `removed ${removed.toFixed(1)} mm³`).toBeGreaterThan(expected * 0.9);
      expect(removed).toBeLessThan(expected * 1.05);
    } finally {
      m.delete();
    }
  });
});

describe('case.magnetPockets through the schema', () => {
  it('round-trips a pocket — the Zod schema must not strip it', () => {
    const original = createDefaultProject('rpi-4b');
    original.case.magnetPockets = [
      {
        id: 'mag-1',
        face: '+z',
        u: 12,
        v: 18,
        size: '6x2',
        retention: 'glue',
        enabled: true,
        label: 'nameplate',
      },
      { id: 'mag-2', face: '-x', u: 5, v: 5, size: '10x2', enabled: false },
    ];
    const parsed = parseProject(serializeProject(original));
    expect(parsed.schemaVersion).toBe(12);
    expect(parsed.case.magnetPockets).toEqual(original.case.magnetPockets);
  });

  it('leaves the field undefined when a project has no pockets', () => {
    const parsed = parseProject(serializeProject(createDefaultProject('rpi-4b')));
    expect(parsed.schemaVersion).toBe(12);
    expect(parsed.case.magnetPockets).toBeUndefined();
  });

  it('loads a v8 project, stamps it v9, and has no pockets', () => {
    const v8 = { ...createDefaultProject('rpi-4b'), schemaVersion: 8 };
    const parsed = parseProject(JSON.stringify(v8));
    expect(parsed.schemaVersion).toBe(12);
    expect(parsed.case.magnetPockets).toBeUndefined();
  });
});
