// Issue #157 — fit coupons, and the magnet coupon #152 needs.
//
// What these tests guard:
//   • the magnet ladder BRACKETS the shipped glue fit: odd length, symmetric,
//     shipped in the middle, and each rung's pocket diameter is disc + clearance
//   • the magnet coupon actually cuts a blind pocket per rung, in BOTH print
//     orientations, at the ladder diameter — the geometry, not the intent
//   • the three #153-laddered coupons carry a REAL ladder: the socket, jaw or
//     ledge that mates the shared half moves by exactly `fitRelief(fit)` from the
//     shipped rung, MEASURED off the meshed coupon — the printed part, not the
//     intent — and the shared half prints as its own body
//   • nothing claims to be coupon-proven — printing the coupon is what would
//     flip a `derived` number, and the tests pin the PROVISIONAL note
//
// The ladder's *relief* reaching each compiler cut is `fitVariants.spec.ts`'s
// job; these tests are about the coupon: that the rung a user presses a tab or
// slides a board into is the rung its label names, on the part that gets
// printed. That is why every ladder here is walked with the coupon's own plan —
// the offsets the builder used, not re-derived ones.

import { describe, it, expect } from 'vitest';
import {
  MAGNET_FIT_STEPS,
  INSERT_FIT_STEPS,
  INSERT_CHAMFER_STEPS,
  INSERT_COUPON_TOOL_D,
  FIT_COUPONS,
  boardSnapCouponPlan,
  buildFitCoupon,
  buildMagnetCoupon,
  buildBoardSnapClipCoupon,
  buildInsertPocketCoupon,
  buildRackTabCoupon,
  buildSnapCatchCoupon,
  insertChamferLadder,
  insertClearanceLadder,
  insertCouponLayout,
  magnetCouponLayout,
  magnetFitLadder,
  magnetPocketDiameterFor,
  rackTabCouponPlan,
  shippedInsertChamfer,
  shippedInsertClearance,
  shippedMagnetClearance,
  snapCatchCouponPlan,
  type FitCouponBuild,
} from '@/engine/compiler/fitCoupons';
import { MAGNETS } from '@/engine/compiler/fasteners';
import { CLIP_FIT } from '@/engine/compiler/boardSnap';
import { SIDE_T, TAB_SLACK, TAB_T } from '@/engine/compiler/rack';
import { FIT_VARIANTS, fitRelief } from '@/types/snap';
import type { MagnetSize, Vec3 } from '@/types';
import { Manifold, exec, type ManifoldInstance } from './helpers/manifoldExec';

const SIZES: MagnetSize[] = ['6x2', '8x3', '10x2'];

/** Probe side, mm — small enough to resolve a relieved wall (the narrowest
 *  ladder step is 0.10), big enough that the result is not a rounding accident. */
const PROBE = 0.02;

function solidAt(m: ManifoldInstance, p: [number, number, number], s = 0.2): boolean {
  const c = Manifold.cube([s, s, s], true).translate(p);
  const i = Manifold.intersection([m, c]);
  const v = i.volume();
  i.delete();
  c.delete();
  return v > (s * s * s) / 2;
}

/** Walk from `p` along `dir` to the first point that reads `want`. Returns that
 *  distance, or NaN if it never does. This is the caliper: a face is found by
 *  walking to it on the mesh, not by reading the number the builder used. */
function scanTo(
  m: ManifoldInstance,
  p: Vec3,
  dir: Vec3,
  want: 'solid' | 'void',
  max = 4,
): number {
  for (let d = 0; d <= max; d += 0.01) {
    const at: [number, number, number] = [
      p[0] + dir[0] * d,
      p[1] + dir[1] * d,
      p[2] + dir[2] * d,
    ];
    if (solidAt(m, at, PROBE) === (want === 'solid')) return d;
  }
  return NaN;
}

const axis = (which: 0 | 1, v: number): Vec3 =>
  which === 0 ? [v, 0, 0] : [0, v, 0];

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

describe('board-snap clip coupon (laddered by #153)', () => {
  it('prints one clip per rung plus the shared gauge, as separate bodies', () => {
    const built: FitCouponBuild = buildBoardSnapClipCoupon();
    const plan = boardSnapCouponPlan();
    expect(built.bodies).toBe(FIT_VARIANTS.length + 1);
    expect(built.columns.map((c) => c.label), 'the rungs are the reliefs').toEqual([
      '0',
      '10',
      '25',
    ]);
    expect(built.columns.filter((c) => c.shipped).length, 'one shipped rung').toBe(1);
    expect(built.settles).toMatch(/clip/);
    expect(built.provenance).toMatch(/PROVISIONAL/);
    const m = exec(built.op);
    try {
      expect(m.decompose().length, 'three clips + one gauge').toBe(FIT_VARIANTS.length + 1);
      // The gauge is a body of its own — printed beside the last clip, cut to the
      // board's stated thickness, so it can be lifted out and tried in each jaw.
      const g = plan.gaugeOrigin;
      const inGauge: [number, number, number] = [g[0] + 4, g[1] + 4, g[2] + plan.gaugeSize[2] / 2];
      expect(solidAt(m, inGauge, 0.4), 'the gauge is printed').toBe(true);
      expect(
        solidAt(m, [inGauge[0], inGauge[1], g[2] + plan.gaugeSize[2] + 2], 0.4),
        'air above the gauge',
      ).toBe(false);
      expect(
        solidAt(m, [g[0] - 3, inGauge[1], g[2] + plan.gaugeSize[2] + 1], 0.4),
        'a gap between the last clip and the gauge',
      ).toBe(false);
    } finally {
      m.delete();
    }
  });

  it('opens each jaw by exactly fitRelief past the PCB edge, against the one gauge', () => {
    const built = buildBoardSnapClipCoupon();
    const plan = boardSnapCouponPlan();
    const m = exec(built.op);
    try {
      // The jaw opening is between the shelf (the board's underside) and the
      // finger, so the probe sits at the PCB edge at mid-thickness — in the void
      // the board itself occupies, at the -y wall the coupon slabs to.
      const p = plan.jawProbe;
      let shippedGap = NaN;
      FIT_VARIANTS.forEach((fit, i) => {
        const s = plan.shift(i);
        const edge: [number, number, number] = [p[0] + s[0], p[1] + s[1], p[2] + s[2]];
        expect(solidAt(m, edge, PROBE), `${fit}: the PCB edge sits in open jaw`).toBe(false);
        const gap = scanTo(m, edge, [0, -1, 0], 'solid');
        expect(Number.isFinite(gap), `${fit}: the spine stands outboard of the edge`).toBe(true);
        // What the caliper reads is the printed gap: CLIP_FIT + the rung's relief.
        const want = CLIP_FIT + fitRelief(fit);
        expect(Math.abs(gap - want), `${fit}: jaw gap reads ${gap.toFixed(2)}, want ${want}`)
          .toBeLessThan(0.04);
        // Past that face is the spine itself — the scan hit a wall, not the edge
        // of the part.
        expect(
          solidAt(m, [edge[0], edge[1] - gap - 0.5, edge[2]], PROBE),
          `${fit}: spine material behind the gap`,
        ).toBe(true);
        if (fit === 'tight') shippedGap = gap;
        else {
          // The ladder is measured against the SHIPPED rung, which is the one the
          // compiler emits today: each rung opens by its relief from that.
          expect(
            Math.abs(gap - shippedGap - fitRelief(fit)),
            `${fit}: opens ${(gap - shippedGap).toFixed(2)} past the shipped jaw`,
          ).toBeLessThan(0.04);
        }
      });
    } finally {
      m.delete();
    }
  });
});

describe('snap-catch coupon (laddered by #153)', () => {
  it('prints the wall bar and the tab as two separate bodies', () => {
    const built = buildSnapCatchCoupon();
    expect(built.bodies).toBe(2);
    expect(built.settles).toMatch(/relief/);
    expect(built.provenance).toMatch(/PROVISIONAL/);
    const m = exec(built.op);
    try {
      expect(m.decompose().length, 'socket bar + tab').toBe(2);
    } finally {
      m.delete();
    }
  });

  it('deepens each socket by exactly fitRelief, against the one tab', () => {
    const built = buildSnapCatchCoupon();
    const plan = snapCatchCouponPlan();
    const m = exec(built.op);
    try {
      // The bar prints at the coupon's own origin, so the plan's bar corner is
      // the world→printed offset; the mesh's own bounds confirm it.
      const bb = m.boundingBox();
      expect(bb.min[0], 'the bar is printed at the coupon origin').toBeCloseTo(0, 6);
      expect(bb.min[1]).toBeCloseTo(0, 6);
      expect(bb.min[2]).toBeCloseTo(0, 6);
      const toCoupon = (n: number, u: number, z: number): [number, number, number] => {
        const q = [0, 0, 0];
        q[plan.nIdx] = n - plan.barMin[plan.nIdx]!;
        q[plan.tIdx] = u - plan.barMin[plan.tIdx]!;
        q[2] = z - plan.barMin[2]!;
        return q as [number, number, number];
      };
      const out: Vec3 = axis(plan.nIdx, plan.outSign);
      const zMid = (plan.cutZ[0] + plan.cutZ[1]) / 2;
      let shippedDepth = NaN;
      FIT_VARIANTS.forEach((fit, i) => {
        const u = plan.columnU[i]!;
        const face = toCoupon(plan.wallInner, u, zMid);
        expect(solidAt(m, face, PROBE), `${fit}: the socket is open at the wall face`).toBe(false);
        const depth = scanTo(m, face, out, 'solid');
        expect(Number.isFinite(depth), `${fit}: the pocket has a floor`).toBe(true);
        // A pocket, not a slot: the wall behind the floor is whole, and below the
        // socket there is the sill the tab's tip lands on.
        expect(
          solidAt(m, [face[0] + out[0] * (depth + 0.5), face[1] + out[1] * (depth + 0.5), face[2]], PROBE),
          `${fit}: material behind the pocket floor`,
        ).toBe(true);
        expect(depth, `${fit}: the pocket does not reach through the wall`).toBeLessThan(
          plan.wallInner - plan.wallOuter,
        );
        if (fit === 'tight') shippedDepth = depth;
        else {
          expect(
            Math.abs(depth - shippedDepth - fitRelief(fit)),
            `${fit}: socket is ${(depth - shippedDepth).toFixed(2)} deeper than the shipped one`,
          ).toBeLessThan(0.04);
        }
        // Sill below and roof above: probe at the pocket's own depth, where the
        // socket is void at zMid — solid above and below it.
        const midDepth = Math.max(depth / 2, 0.05);
        expect(
          solidAt(m, toCoupon(plan.wallInner - midDepth, u, plan.cutZ[0] + 0.4), 0.15),
          `${fit}: sill below the socket`,
        ).toBe(true);
        expect(
          solidAt(m, toCoupon(plan.wallInner - midDepth, u, plan.cutZ[1] - 0.6), 0.15),
          `${fit}: roof above the socket`,
        ).toBe(true);
      });
    } finally {
      m.delete();
    }
  });

  it('engraves each rung on the backing, clear of the sockets', () => {
    const calls: string[] = [];
    const spy = (text: string) => {
      calls.push(text);
      return [];
    };
    buildSnapCatchCoupon(spy);
    expect(calls).toEqual(['0', '10', '25']);
  });
});

describe('rack plate-tab coupon (laddered by #153)', () => {
  it('prints one ledge slice per rung plus the plate tab, as separate bodies', () => {
    const built = buildRackTabCoupon();
    expect(built.bodies).toBe(FIT_VARIANTS.length + 1);
    expect(built.columns.map((c) => c.label)).toEqual(['0', '10', '25']);
    expect(built.provenance).toMatch(/PROVISIONAL/);
    const m = exec(built.op);
    try {
      expect(m.decompose().length, 'three ledge slices + the tab').toBe(FIT_VARIANTS.length + 1);
    } finally {
      m.delete();
    }
  });

  it('ladders the ledge floor and the slot walls by exactly fitRelief, against the one tab', () => {
    const built = buildRackTabCoupon();
    const plan = rackTabCouponPlan();
    const m = exec(built.op);
    try {
      // The ledge slice prints in assembly orientation; the tab is flipped, so a
      // world point (x, y, z) prints at (x, -y, -z) + tabShift. x is the flip
      // axis, so both are measured on the same world x and the numbers compare.
      const ledgeAt = (shift: Vec3, x: number, y: number, z: number): [number, number, number] =>
        [x + shift[0], y + shift[1], z + shift[2]];
      const tabAt = (x: number, y: number, z: number): [number, number, number] =>
        [x + plan.tabShift[0], -y + plan.tabShift[1], -z + plan.tabShift[2]];

      const zBand = plan.plateZ + TAB_T / 2; // inside the ledge notch (and the tab)
      // The tab's outboard face: walk +x from outside the tab's own band. The
      // ledge floor is the same walk on each ledge slice.
      const tabFace = 0.05 + scanTo(m, tabAt(0.05, plan.tabY, zBand), [1, 0, 0], 'solid');
      expect(Number.isFinite(tabFace), 'the tab is printed').toBe(true);
      // Its side face, for the y ladder: the tab's own low-y face at the tab line.
      // The flip mirrors y, so walking world +y is coupon −y.
      const yLo = plan.tabY - 14;
      const tabYFace = yLo + scanTo(m, tabAt(10, yLo, zBand), [0, -1, 0], 'solid');

      let shippedFloor = NaN;
      let shippedWall = NaN;
      FIT_VARIANTS.forEach((fit, i) => {
        const shift = plan.ledgeShift(i);
        // Floor: walk +x along the notch's centre line; the first void is the
        // ledge floor — the face the plate tab lands on.
        const floor = 0.05 + scanTo(m, ledgeAt(shift, 0.05, plan.tabY, zBand), [1, 0, 0], 'void');
        // Wall: walk +y from the slice's window edge; the first void is the slot's
        // near wall.
        const wall = yLo + 0.05 + scanTo(m, ledgeAt(shift, 6, yLo + 0.05, zBand), [0, 1, 0], 'void');
        expect(Number.isFinite(floor) && Number.isFinite(wall), `${fit}: found the notch`).toBe(true);
        // Still a notch, not a cut-through: the rail outboard of the floor, and
        // the material above and below the ledge band.
        expect(solidAt(m, ledgeAt(shift, 1, plan.tabY, zBand), 0.3), `${fit}: rail outboard`).toBe(true);
        // Halfway up the 2 mm the slice keeps above the notch (RACK_COUPON_PAD),
        // which is where the real rail also stands: the ledge is a notch, not the
        // top of the piece.
        expect(
          solidAt(m, ledgeAt(shift, SIDE_T / 2, plan.tabY, plan.plateZ + TAB_T + 1), 0.4),
          `${fit}: rail above the ledge`,
        ).toBe(true);
        // On the panel's outer skin, clear of the Ø10.8 driver-access bore that
        // the same loop cuts through the foot under the screw axis.
        expect(
          solidAt(m, ledgeAt(shift, 1.5, plan.tabY, plan.plateZ - 1), 0.4),
          `${fit}: foot below the ledge`,
        ).toBe(true);
        if (fit === 'tight') {
          shippedFloor = floor;
          shippedWall = wall;
        } else {
          expect(
            Math.abs(tabFace - floor - (TAB_SLACK + fitRelief(fit))),
            `${fit}: tab-to-floor gap reads ${(tabFace - floor).toFixed(2)}`,
          ).toBeLessThan(0.05);
          expect(
            Math.abs(tabYFace - wall - (TAB_SLACK + fitRelief(fit))),
            `${fit}: tab-to-wall gap reads ${(tabYFace - wall).toFixed(2)}`,
          ).toBeLessThan(0.05);
          expect(
            Math.abs(floor - shippedFloor + fitRelief(fit)),
            `${fit}: the ledge floor opens ${(shippedFloor - floor).toFixed(2)} past the shipped one`,
          ).toBeLessThan(0.04);
          expect(
            Math.abs(shippedWall - wall - fitRelief(fit)),
            `${fit}: the slot wall opens ${(shippedWall - wall).toFixed(2)}`,
          ).toBeLessThan(0.04);
        }
      });
      // One tab, three ledges: the shipped rung's gap is TAB_SLACK by definition.
      expect(
        Math.abs(tabFace - shippedFloor - TAB_SLACK),
        `shipped rung gap reads ${(tabFace - shippedFloor).toFixed(2)}`,
      ).toBeLessThan(0.05);
    } finally {
      m.delete();
    }
  });

  it('prints the plate tab counterbore-up, as the real bottom plate does', () => {
    const built = buildRackTabCoupon();
    const plan = rackTabCouponPlan();
    const m = exec(built.op);
    try {
      const tabAt = (x: number, y: number, z: number): [number, number, number] =>
        [x + plan.tabShift[0], -y + plan.tabShift[1], -z + plan.tabShift[2]];
      // The flip puts the tab's SEAT face — the one whose counterbore the screw
      // head enters, on the real plate's underside — at the coupon's top. So
      // "world z = plateZ + d" is coupon z = TAB_T - d.
      const zTop = plan.plateZ + 0.5; // near that face
      const zBed = plan.plateZ + TAB_T - 0.5; // near the bed
      const face = 0.05 + scanTo(m, tabAt(0.05, plan.tabY, zTop), [1, 0, 0], 'solid');
      expect(Number.isFinite(face), 'the tab is printed').toBe(true);
      // Walk into the tab: the first void is the counterbore. It opens in the top
      // face — printed the other way it would open onto the bed, and its floor
      // would be an unsupported ceiling for the screw head to bear on.
      const bore = face + 0.05 + scanTo(m, tabAt(face + 0.05, plan.tabY, zTop), [1, 0, 0], 'void');
      expect(Number.isFinite(bore), 'the counterbore breaks the tab’s top face').toBe(true);
      const floor = scanTo(m, tabAt(bore + 0.2, plan.tabY, zTop), [0, 0, -1], 'solid');
      expect(Number.isFinite(floor), 'the counterbore has a floor').toBe(true);
      expect(floor, 'the counterbore is a pocket, not a through slot').toBeLessThan(TAB_T);
      expect(
        solidAt(m, tabAt(bore + 0.2, plan.tabY, zBed), 0.2),
        'material under the counterbore, on the bed',
      ).toBe(true);
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
  it('lists every magnet size, the three laddered interfaces, and the insert coupon', () => {
    const ids = FIT_COUPONS.map((c) => c.id);
    expect(ids).toEqual([
      'magnet-6x2',
      'magnet-8x3',
      'magnet-10x2',
      'board-snap',
      'snap-catch',
      'rack-tab',
      'insert-pocket',
    ]);
  });

  it('buildFitCoupon resolves by id and rejects an unknown one', () => {
    expect(buildFitCoupon('magnet-8x3').columns.length).toBe(MAGNET_FIT_STEPS);
    expect(buildFitCoupon('insert-pocket').columns.length).toBe(INSERT_FIT_STEPS);
    expect(() => buildFitCoupon('nope')).toThrow(/unknown fit coupon/);
  });
});
