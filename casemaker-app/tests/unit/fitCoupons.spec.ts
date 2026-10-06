// Issue #157 — fit coupons, and the magnet coupon #152 needs.
//
// What these tests guard:
//   • the magnet ladder BRACKETS the shipped glue fit: odd length, symmetric,
//     shipped in the middle, and each rung's pocket diameter is disc + clearance
//   • the magnet coupon actually cuts a blind pocket per rung, in BOTH print
//     orientations, at the ladder diameter — the geometry, not the intent
//   • the board-snap coupon lifts the compiler's own clip (one body) and prints
//     the mating gauge as a SEPARATE body, because a fit coupon tests a fit
//   • nothing claims to be coupon-proven — printing the coupon is what would
//     flip a `derived` number, and the tests pin the PROVISIONAL note

import { describe, it, expect } from 'vitest';
import {
  MAGNET_FIT_STEPS,
  INSERT_FIT_STEPS,
  INSERT_CHAMFER_STEPS,
  INSERT_COUPON_TOOL_D,
  FIT_COUPONS,
  buildFitCoupon,
  buildMagnetCoupon,
  buildBoardSnapClipCoupon,
  buildInsertPocketCoupon,
  insertChamferLadder,
  insertClearanceLadder,
  insertCouponLayout,
  magnetCouponLayout,
  magnetFitLadder,
  magnetPocketDiameterFor,
  shippedInsertChamfer,
  shippedInsertClearance,
  shippedMagnetClearance,
  type FitCouponBuild,
} from '@/engine/compiler/fitCoupons';
import { MAGNETS } from '@/engine/compiler/fasteners';
import type { MagnetSize } from '@/types';
import { Manifold, exec, type ManifoldInstance } from './helpers/manifoldExec';

const SIZES: MagnetSize[] = ['6x2', '8x3', '10x2'];

function solidAt(m: ManifoldInstance, p: [number, number, number], s = 0.2): boolean {
  const c = Manifold.cube([s, s, s], true).translate(p);
  const i = Manifold.intersection([m, c]);
  const v = i.volume();
  i.delete();
  c.delete();
  return v > (s * s * s) / 2;
}

describe('magnet fit ladder', () => {
  it('is odd, shipped-centred, and steps monotonically', () => {
    expect(MAGNET_FIT_STEPS % 2).toBe(1);
    for (const s of SIZES) {
      const ladder = magnetFitLadder(s);
      expect(ladder.length).toBe(MAGNET_FIT_STEPS);
      const mid = (MAGNET_FIT_STEPS - 1) / 2;
      expect(ladder[mid], `${s} shipped is the middle rung`).toBeCloseTo(
        shippedMagnetClearance(),
        5,
      );
      for (let i = 1; i < ladder.length; i++) {
        expect(ladder[i]!, `${s} rung ${i} > rung ${i - 1}`).toBeGreaterThan(ladder[i - 1]!);
      }
      // It must reach BOTH a press (interference, < 0) and a loose (> shipped).
      expect(ladder[0]!).toBeLessThan(0);
      expect(ladder[ladder.length - 1]!).toBeGreaterThan(shippedMagnetClearance());
    }
  });

  it('pocket diameter is disc + clearance, and the shipped rung is the table', () => {
    expect(shippedMagnetClearance()).toBe(0.5);
    for (const s of SIZES) {
      expect(magnetPocketDiameterFor(s, shippedMagnetClearance()), `${s} shipped Ø`).toBe(
        MAGNETS[s].pocket.d,
      );
      expect(magnetPocketDiameterFor('6x2', -0.25)).toBe(5.75); // press, smaller than the disc
    }
  });
});

describe('magnet coupon geometry', () => {
  it('builds one body and marks the shipped rung', () => {
    const built = buildMagnetCoupon('6x2');
    expect(built.bodies).toBe(1);
    expect(built.columns.length).toBe(MAGNET_FIT_STEPS);
    const shippedCols = built.columns.filter((c) => c.shipped);
    expect(shippedCols.length, 'exactly one shipped rung').toBe(1);
    expect(shippedCols[0]!.value).toBeCloseTo(shippedMagnetClearance(), 5);
    // Labels are the pocket Ø to 0.1 mm, digits only.
    expect(shippedCols[0]!.label).toBe('65');
  });

  it('cuts a blind pocket per rung, top face and front face, at the ladder Ø', () => {
    const built = buildMagnetCoupon('6x2');
    expect(built.provenance).toMatch(/PROVISIONAL/);
    const m = exec(built.op);
    try {
      expect(m.decompose().length, 'one printed body').toBe(1);
      expect(m.genus(), 'blind pockets are dimples, not handles').toBe(0);
      const L = magnetCouponLayout('6x2');
      const BAR_Z = built.dims.z; // 13
      const pocketDepth = MAGNETS['6x2'].pocket.h; // 2.4
      for (const col of built.columns) {
        const r = magnetPocketDiameterFor('6x2', col.value) / 2;
        const zTop = BAR_Z - pocketDepth / 2;
        // Top row: void inside the ladder Ø, material in the wall between holes.
        expect(solidAt(m, [col.x, L.vertY, zTop]), `${col.label} top void`).toBe(false);
        expect(solidAt(m, [col.x + Math.max(r + 0.6, 3.6), L.vertY, zTop]), `${col.label} wall`).toBe(
          true,
        );
        // Floor below every pocket stays solid.
        expect(solidAt(m, [col.x, L.vertY, BAR_Z - pocketDepth - 0.6]), `${col.label} floor`).toBe(
          true,
        );
        // Front row: void just inside the mouth, material past the pocket depth.
        expect(solidAt(m, [col.x, pocketDepth / 2, L.horizZ]), `${col.label} front void`).toBe(false);
        expect(solidAt(m, [col.x, pocketDepth + 1.2, L.horizZ]), `${col.label} front floor`).toBe(true);
      }
    } finally {
      m.delete();
    }
  });

  it('engraves a label per rung when a labeler is supplied', () => {
    const calls: string[] = [];
    const spy = (text: string) => {
      calls.push(text);
      return [];
    };
    buildMagnetCoupon('10x2', spy);
    expect(calls.length).toBe(MAGNET_FIT_STEPS);
    expect(calls).toContain('105'); // shipped 10.5 -> "105"
  });
});

describe('board-snap clip coupon', () => {
  it('prints the compiler’s clip and the gauge as two separate bodies', () => {
    const built: FitCouponBuild = buildBoardSnapClipCoupon();
    expect(built.bodies).toBe(2);
    expect(built.settles).toMatch(/clip/);
    const m = exec(built.op);
    try {
      expect(m.decompose().length, 'clip body + gauge body').toBe(2);
    } finally {
      m.delete();
    }
  });
});

describe('tool-insert pocket coupon (#158 / #262 item 5)', () => {
  it('the clearance ladder is non-negative, monotonic, and shipped lands on one rung', () => {
    const ladder = insertClearanceLadder();
    expect(ladder.length).toBe(INSERT_FIT_STEPS);
    for (let i = 0; i < ladder.length; i++) {
      // A tool has to come back OUT: unlike the magnet ladder this one may not
      // step into interference, which `insertProblem` would reject anyway.
      expect(ladder[i]!, `rung ${i} is non-negative`).toBeGreaterThanOrEqual(0);
      if (i > 0) expect(ladder[i]!, `rung ${i} > rung ${i - 1}`).toBeGreaterThan(ladder[i - 1]!);
    }
    expect(ladder.filter((c) => c === shippedInsertClearance()).length).toBe(1);
    // Pilot shape, not bracket: the shipped guess is unmeasured and the reviewed
    // generators use a larger clearance, so more rungs sit above it than below.
    const at = ladder.indexOf(shippedInsertClearance());
    expect(ladder.length - 1 - at, 'more rungs above shipped than below').toBeGreaterThan(at);
  });

  it('the chamfer ladder is anchored at a hard edge, with shipped on rung 4', () => {
    const ladder = insertChamferLadder();
    expect(ladder.length).toBe(INSERT_CHAMFER_STEPS);
    expect(ladder[0], 'rung 0 is a hard edge, the control').toBe(0);
    for (let i = 1; i < ladder.length; i++) {
      expect(ladder[i]!).toBeGreaterThan(ladder[i - 1]!);
    }
    // The ladder is anchored at 0 rather than centred, so the shipped value has
    // to be found at a fixed rung — and this assertion is what catches
    // `defaultInsert().chamfer` moving out from under the layout.
    expect(ladder[4]).toBeCloseTo(shippedInsertChamfer(), 5);
  });

  it('cuts one blind pocket per rung of each ladder, at the ladder diameter', () => {
    const built = buildInsertPocketCoupon();
    expect(built.bodies).toBe(1);
    expect(built.columns.length, 'columns describe the clearance ladder').toBe(INSERT_FIT_STEPS);
    expect(built.columns.filter((c) => c.shipped).length, 'one shipped rung').toBe(1);

    const L = insertCouponLayout();
    const m = exec(built.op);
    try {
      expect(m.decompose().length, 'one printed body').toBe(1);
      expect(m.genus(), 'blind pockets are dimples, not handles').toBe(0);
      const midZ = L.barZ - L.pocketDepth / 2;
      const shippedR = (INSERT_COUPON_TOOL_D + shippedInsertClearance()) / 2;

      // Upper row — the bore is the ladder diameter, the floor under it is solid.
      for (const col of built.columns) {
        const r = (INSERT_COUPON_TOOL_D + col.value) / 2;
        expect(solidAt(m, [col.x, L.clearanceY, midZ]), `${col.label} bore is void`).toBe(false);
        expect(
          solidAt(m, [col.x + r + 1, L.clearanceY, midZ]),
          `${col.label} wall outside the bore`,
        ).toBe(true);
        expect(
          solidAt(m, [col.x, L.clearanceY, L.barZ - L.pocketDepth - 1.5]),
          `${col.label} floor`,
        ).toBe(true);
      }

      // Lower row — the same bore for every rung, only the entry flare changes.
      // Probe the two ENDS of the ladder 0.5 mm outside the bore and a hair
      // below the top face: a hard edge leaves material there, the widest flare
      // (1.2 mm) has opened well past it. The middle rungs sit within half a
      // 0.2 mm step of each other, which is finer than a mesh probe can resolve
      // — those are read off the printed part, not off the mesh.
      insertChamferLadder().forEach((chamfer, i) => {
        const x = L.x0 + i * L.col;
        expect(solidAt(m, [x, L.chamferY, midZ]), `chamfer ${chamfer} bore is void`).toBe(false);
        expect(
          solidAt(m, [x, L.chamferY, L.barZ - L.pocketDepth - 1.5]),
          `chamfer ${chamfer} floor`,
        ).toBe(true);
      });
      const probeOut = shippedR + 0.5;
      const mouthZ = L.barZ - 0.1;
      expect(
        solidAt(m, [L.x0 + probeOut, L.chamferY, mouthZ], 0.1),
        'a hard edge leaves material 0.5 mm outside the bore',
      ).toBe(true);
      const widestX = L.x0 + (INSERT_CHAMFER_STEPS - 1) * L.col;
      expect(
        solidAt(m, [widestX + probeOut, L.chamferY, mouthZ], 0.1),
        'the widest flare has cut past that point',
      ).toBe(false);
    } finally {
      m.delete();
    }
  });

  it('engraves a label per rung of BOTH rows, in different number systems', () => {
    const calls: string[] = [];
    const spy = (text: string) => {
      calls.push(text);
      return [];
    };
    buildInsertPocketCoupon(spy);
    expect(calls.length).toBe(INSERT_FIT_STEPS + INSERT_CHAMFER_STEPS);
    // Upper row labels the clearance ×100; lower row the chamfer ×100.
    expect(calls).toContain('25'); // shipped clearance 0.25
    expect(calls).toContain('80'); // shipped chamfer 0.8
    expect(calls).toContain('0'); // the hard edge
  });

  it('keeps the bar on a small bed and the label rows clear of the bores', () => {
    const L = insertCouponLayout();
    expect(L.barX).toBeLessThan(180);
    expect(L.barY).toBeLessThan(80);
    // Labels are 7 mm tall from their baseline; they must not run into the row
    // of bores above them, nor off the bar.
    const r = (INSERT_COUPON_TOOL_D + shippedInsertClearance()) / 2;
    expect(L.clearanceLabelY + 7).toBeLessThan(L.clearanceY - r);
    expect(L.clearanceLabelY).toBeGreaterThan(L.chamferY + r);
    expect(L.chamferLabelY + 7).toBeLessThan(L.chamferY - r);
    expect(L.chamferLabelY).toBeGreaterThanOrEqual(0);
  });
});

describe('registry', () => {
  it('lists every magnet size, the board-snap coupon and the insert coupon', () => {
    const ids = FIT_COUPONS.map((c) => c.id);
    expect(ids).toEqual([
      'magnet-6x2',
      'magnet-8x3',
      'magnet-10x2',
      'board-snap',
      'insert-pocket',
    ]);
  });

  it('buildFitCoupon resolves by id and rejects an unknown one', () => {
    expect(buildFitCoupon('magnet-8x3').columns.length).toBe(MAGNET_FIT_STEPS);
    expect(buildFitCoupon('insert-pocket').columns.length).toBe(INSERT_FIT_STEPS);
    expect(() => buildFitCoupon('nope')).toThrow(/unknown fit coupon/);
  });
});
