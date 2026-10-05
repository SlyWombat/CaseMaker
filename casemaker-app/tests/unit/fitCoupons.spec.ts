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
  FIT_COUPONS,
  buildFitCoupon,
  buildMagnetCoupon,
  buildBoardSnapClipCoupon,
  magnetCouponLayout,
  magnetFitLadder,
  magnetPocketDiameterFor,
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

describe('registry', () => {
  it('lists every magnet size and the board-snap coupon', () => {
    const ids = FIT_COUPONS.map((c) => c.id);
    expect(ids).toEqual(['magnet-6x2', 'magnet-8x3', 'magnet-10x2', 'board-snap']);
  });

  it('buildFitCoupon resolves by id and rejects an unknown one', () => {
    expect(buildFitCoupon('magnet-8x3').columns.length).toBe(MAGNET_FIT_STEPS);
    expect(() => buildFitCoupon('nope')).toThrow(/unknown fit coupon/);
  });
});
