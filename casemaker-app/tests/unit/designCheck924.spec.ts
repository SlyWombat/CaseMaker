/**
 * #924 — the independent design-side oracle (`src/engine/cnc/engrave/designCheck.ts`).
 *
 * GATE: every check here is validated against something that is NOT the function under test —
 * a numerical quadrature for the two volume closed forms, the documented real #741 measurements
 * for the regression fixture, and a hand-built simulated region (never the design's own eroded
 * shape reused as if it were independent) for the 2D reach check — the whole point of #924 being
 * that these do not share math with `oracle.ts`/`engraveGenerate.ts`.
 */
import { describe, expect, it } from 'vitest';

import { tl } from './helpers/manifoldExec';
import {
  checkDesignReach,
  checkGoalCutInto,
  checkVolumeAgreement,
  flatCapsuleVolumeMm3,
  vGrooveVolumeMm3,
  type DesignCheckItem,
} from '@/engine/cnc/engrave/designCheck';
import type { GoalHeightfield } from '@/engine/cnc/cam/surface3d';
import { ORACLE_AREA_FLOOR } from '@/engine/cnc/engrave/oracle';

const CS = tl.CrossSection;

/** A flat cutter of radius `r`, as `designCutterOf` reads one. */
const flat = (r: number) => ({ tipRadius: r, tanHalf: 0, maxRadius: r });

/** A `nx x ny` square outline, CCW, centred on the origin — the raw "design" for the fixtures below. */
function square(nx: number, ny: number) {
  return [[[-nx / 2, -ny / 2], [nx / 2, -ny / 2], [nx / 2, ny / 2], [-nx / 2, ny / 2]] as [number, number][]];
}

describe('checkDesignReach — gate statement 5, against a hand-built simulated region', () => {
  it('passes when the simulation removed exactly the design’s own reachable region', () => {
    const r = 1;
    const item: DesignCheckItem = { itemId: 'pocket', design: square(20, 10), depth: 2, cutter: flat(r) };
    const design = CS.ofPolygons(item.design);
    const reachable = design.offset(-r, 'Round', 2, 64);
    try {
      const report = checkDesignReach(tl, [item], (z) => (z <= -2 + 0.01 ? reachable.offset(0, 'Round', 2, 64) : null), {});
      expect(report.ok).toBe(true);
      expect(report.worst.unreached).toBeLessThanOrEqual(ORACLE_AREA_FLOOR);
      expect(report.worst.tooFar).toBeLessThanOrEqual(ORACLE_AREA_FLOOR);
    } finally {
      design.delete();
      reachable.delete();
    }
  });

  it('catches a reachable design area the simulation left uncut', () => {
    const r = 1;
    const item: DesignCheckItem = { itemId: 'pocket', design: square(20, 10), depth: 2, cutter: flat(r) };
    const design = CS.ofPolygons(item.design);
    // The simulation only removed the LEFT half of the reachable region — a real under-cut.
    const half = CS.ofPolygons([[[-10, -5], [0, -5], [0, 5], [-10, 5]]]);
    const reachable = design.offset(-r, 'Round', 2, 64);
    const simulated = CS.intersection([reachable, half]);
    try {
      const report = checkDesignReach(tl, [item], (z) => (z <= -2 + 0.01 ? simulated.offset(0, 'Round', 2, 64) : null), {});
      expect(report.ok).toBe(false);
      expect(report.worst.unreached).toBeGreaterThan(ORACLE_AREA_FLOOR);
      expect(report.worst.unreachedAt?.itemId).toBe('pocket');
    } finally {
      design.delete();
      half.delete();
      reachable.delete();
      simulated.delete();
    }
  });

  // #741's own numbers: a 90° ⌀3.175 chamfer bit (tip 0.1 mm, cone 1.54 mm tall) 5.1 mm deep. The
  // real bit's flank stops at its body; the engine's bug kept the cone widening to the top face.
  // The floor's tip trace is the same either way, so only a level above the cone can tell them apart.
  const V90 = { tipRadius: 0.05, tanHalf: 1, maxRadius: 3.175 / 2 };
  const trace: DesignCheckItem = { itemId: 'v-trace', design: [[[-15, -0.05], [15, -0.05], [15, 0.05], [-15, 0.05]]], depth: 5.1, cutter: V90 };
  /** The removal at level z: the trace grown by the flank's widening there, capped at the body or not. */
  const sweptAt = (capped: boolean) => (z: number) => {
    const h = z + 5.1;
    if (h < 0) return null;
    const widen = capped ? Math.min(h, V90.maxRadius - V90.tipRadius) : h;
    const slot = CS.ofPolygons(trace.design);
    try {
      return slot.offset(widen, 'Round', 2, 64);
    } finally {
      slot.delete();
    }
  };

  it('#741: the real bit, its flank stopped at the body, passes at every level', () => {
    const report = checkDesignReach(tl, [trace], sweptAt(true), {});
    expect(report.ok, report.sentence).toBe(true);
  });

  it('#741: the flank widened past the body is caught above the cone, not at the floor', () => {
    const report = checkDesignReach(tl, [trace], sweptAt(false), {});
    expect(report.ok).toBe(false);
    expect(report.worst.tooFarAt?.itemId).toBe('v-trace');
    const failing = report.levels.filter((l) => l.tooFar > ORACLE_AREA_FLOOR);
    // Nothing at the floor: the defect lives only where the real cone has ended.
    expect(failing.every((l) => l.z > -5.1 + 1.5375)).toBe(true);
    expect(report.levels.find((l) => l.z < -5)!.tooFar).toBe(0);
    expect(report.sentence).toContain('v-trace is cut');
  });
});

describe('flatCapsuleVolumeMm3 / vGrooveVolumeMm3 — gate statement 6, against independent numerical quadrature', () => {
  /** Volume of {x: dist(x,segment)<=r, 0<=z<=d}, by brute-force grid quadrature — never the closed form's own algebra, and never `capsuleArea`/`capsuleContours` (`workers/geometry/sweep.ts`). */
  function quadratureFlatCapsule(length: number, r: number, d: number, cells = 400): number {
    const xMin = -r - 0.5, xMax = length + r + 0.5, yMin = -r - 0.5, yMax = r + 0.5;
    const dx = (xMax - xMin) / cells, dy = (yMax - yMin) / cells;
    let area = 0;
    for (let i = 0; i < cells; i++) {
      const x = xMin + (i + 0.5) * dx;
      const cx = Math.max(0, Math.min(length, x));
      for (let j = 0; j < cells; j++) {
        const y = yMin + (j + 0.5) * dy;
        if (Math.hypot(x - cx, y) <= r) area += dx * dy;
      }
    }
    return area * d;
  }

  /** Volume of a straight V stroke (uncapped cone) by quadrature over (x, z): at each z the footprint is a capsule of radius z*tan(a). */
  function quadratureVGroove(length: number, halfAngleDeg: number, d: number, zSteps = 300, cells = 200): number {
    const t = Math.tan((halfAngleDeg * Math.PI) / 180);
    const dz = d / zSteps;
    let volume = 0;
    for (let s = 0; s < zSteps; s++) {
      const z = (s + 0.5) * dz;
      const r = z * t;
      if (r <= 0) continue;
      volume += quadratureFlatCapsule(length, r, dz, cells);
    }
    return volume;
  }

  it('flat capsule: a point trace (L=0) reduces to a plain cylinder, exactly', () => {
    const r = 1.5875, d = 2;
    expect(flatCapsuleVolumeMm3(0, r, d)).toBeCloseTo(Math.PI * r * r * d, 9);
  });

  it('flat capsule: agrees with independent quadrature for a real trace (the badge’s 0.3 mm V, treated as a flat stand-in at its tip radius)', () => {
    const closed = flatCapsuleVolumeMm3(20, 0.15, 1);
    const quad = quadratureFlatCapsule(20, 0.15, 1);
    expect(closed).toBeCloseTo(quad, 1);
    expect(Math.abs(closed - quad) / closed).toBeLessThan(0.01);
  });

  it('V groove: agrees with independent quadrature for the #741 inlay stroke (30 deg half-angle, 30 mm run)', () => {
    const closed = vGrooveVolumeMm3(30, 15, 4.99);
    const quad = quadratureVGroove(30, 15, 4.99);
    expect(Math.abs(closed - quad) / closed).toBeLessThan(0.02);
  });

  it('V groove: agrees with independent quadrature for the bench’s 90 deg chamfer stroke', () => {
    const closed = vGrooveVolumeMm3(30, 45, 1.5375);
    const quad = quadratureVGroove(30, 45, 1.5375);
    expect(Math.abs(closed - quad) / closed).toBeLessThan(0.02);
  });
});

describe('checkVolumeAgreement — the #741 regression: the real measured excess must fail', () => {
  it('the real #741 numbers (j11 star female, 1431 vs 971 mm³, +47 %) are flagged', () => {
    // #741's own documented measurement (`docs/reviews/2026-11-02-cnc-review/03-simulation-gate.md`
    // §2): the uncapped (buggy) simulator removed 1431 mm³ where the capped, correct cone removes
    // 971 mm³ — the independent figure here plays the analytic side, the buggy run plays the
    // "simulated" side, exactly as a live check would see them.
    const report = checkVolumeAgreement('j11 star female pocket', 1431, 971);
    expect(report.ok).toBe(false);
    expect(report.excessFraction).toBeCloseTo(0.4737, 3);
    expect(report.sentence).toContain('j11 star female pocket');
  });

  it('the real #741 numbers (j11 inlay 30°, 5089 vs 3067 mm³, +66 %) are flagged', () => {
    const report = checkVolumeAgreement('j11 inlay 30°', 5089, 3067);
    expect(report.ok).toBe(false);
    expect(report.excessFraction).toBeGreaterThan(0.6);
  });

  it('an in-tolerance run (float/approximation drift only) passes', () => {
    const report = checkVolumeAgreement('badge', 100.3, 100);
    expect(report.ok).toBe(true);
  });
});

describe('checkGoalCutInto — #924’s 3D half, ported from tools/goal_check.py', () => {
  function flatGoal(nx: number, ny: number, pitch: number, z: number): GoalHeightfield {
    const n = nx * ny;
    return {
      nx,
      ny,
      x0: 0,
      y0: 0,
      pitch,
      topZ: 0,
      minZ: z,
      z: new Float32Array(n).fill(z),
      covered: new Uint8Array(n).fill(1),
      coveredCount: n,
      resolutionNote: `${pitch} mm grid`,
    };
  }

  it('a swept surface that exactly matches the goal passes, full coverage', () => {
    const goal = flatGoal(10, 10, 0.5, -2);
    const report = checkGoalCutInto(goal, () => -2);
    expect(report.ok).toBe(true);
    expect(report.coverageFraction).toBe(1);
    expect(report.cutIntoFraction).toBe(0);
  });

  it('a rough pass that cuts into the goal by more than the floor is caught, as the demo page found (#909)', () => {
    const goal = flatGoal(10, 10, 0.5, -2);
    // Half the cells are gouged 0.5 mm below the goal — well past the 0.01 mm floor.
    const report = checkGoalCutInto(goal, (x) => (x < 2.5 ? -2.5 : -2));
    expect(report.ok).toBe(false);
    expect(report.cutIntoFraction).toBeGreaterThan(0);
    expect(report.maxCutIntoMm).toBeCloseTo(0.5, 6);
    expect(report.sentence).toContain('cut into');
  });

  it('material left standing above the goal is reported as leftover, and #948’s pass line fails it', () => {
    const goal = flatGoal(10, 10, 0.5, -2);
    const report = checkGoalCutInto(goal, () => -1.5); // 0.5 mm high everywhere
    expect(report.cutIntoFraction).toBe(0);
    // #948 — the pass line is zero cut-into AND top-surface coverage ≥ 95 %; nothing here is
    // within 0.1 mm of the goal, so a run the page reads as Deviates is not this check's pass.
    expect(report.passCoverage).toBe(0.95);
    expect(report.leftoverFractions[0]).toBe(1);
    expect(report.ok).toBe(false);
    expect(report.sentence).toContain('coverage');
    expect(report.leftoverFractions[1]).toBeGreaterThan(0); // past the 0.3 mm band
    expect(report.maxLeftoverMm).toBeCloseTo(0.5, 6);
  });

  it('a cell outside the resultTop sampler (unreached) is excluded from the denominator, not counted as cut-into', () => {
    const goal = flatGoal(10, 10, 0.5, -2);
    const report = checkGoalCutInto(goal, (x) => (x < 2.5 ? null : -2));
    expect(report.goalCells).toBeLessThan(goal.coveredCount);
    expect(report.ok).toBe(true);
  });
});
