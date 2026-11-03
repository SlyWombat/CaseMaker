/**
 * #924 — the independent, DESIGN-SIDE oracle (gate statements 5 and 6 of
 * `docs/reviews/2026-11-02-cnc-review/03-simulation-gate.md` §2.3(e)).
 *
 * `oracle.ts`'s `computeOracle` is the CAM grading its own homework: the flat floor it predicts is
 * `offset(offset(design, -planeRadius), tipRadius)` (#584, `engraveGenerate.ts`) and the V groove
 * it predicts shares `grooveRadiusAt`'s cone with the engine that sweeps it (`oracle.ts:100-125`).
 * A bug that is consistent with itself on both sides of that shared math is invisible to it — #741
 * (the V flank widened past the shank, 20-60 % excess volume) was found only by an EXTERNAL sweep
 * (`tools/render.py`), because the oracle's own groove prediction used the same uncapped cone the
 * engine swept with.
 *
 * This module checks the simulation against the RAW DESIGN instead, with its own math:
 *
 *   - {@link checkDesignReach} — `Simulation.md` §7's point-in-polygon check. A design point at
 *     least `r` from the design's own outline (a wall the cutter of that radius cannot enter) must
 *     be inside the simulated removed region; no simulated point may lie more than `r + band` from
 *     the design. Built with `CrossSection.offset` directly on the raw design polygons — a single
 *     erosion/growth by the cutter's own radius, never the CAM's two-stage
 *     `offset(offset(design, -planeRadius), tipRadius)` and never `grooveRadiusAt`.
 *   - {@link flatCapsuleVolumeMm3} / {@link vGrooveVolumeMm3} — closed-form removed-volume formulas
 *     derived directly from the swept solid's geometry (a flat-ended cylinder or a cone, integrated
 *     along a straight run), not from the engine's own union/sweep code.
 *   - {@link checkGoalCutInto} — the 3D half (#924's scope note, #909): a cut-into-the-goal /
 *     leftover-above-the-goal comparison against a {@link GoalHeightfield}, ported numerically from
 *     the bench's `tools/goal_check.py` (`d = sweptTop - goalTop`; `d < -CUT_INTO` is cut-into,
 *     `d > leftover thresholds` is leftover material) so the app itself can read the same verdict
 *     the demo page's external tool does, not only a human looking at the page.
 */

import { ARC_CHORD_TOLERANCE_MM, SWEEP_SIMPLIFY_EPS_MM, segmentsForRadius } from '@/engine/compiler/arcResolution';
import type { ManifoldToplevel } from '@/workers/geometry/evaluateOp';
import {
  bboxOf,
  ORACLE_AREA_FLOOR,
  type OracleBbox,
  type OraclePolygon,
  type OracleSliceAt,
} from '@/engine/cnc/engrave/oracle';
import type { GoalHeightfield } from '@/engine/cnc/cam/surface3d';
import { goalTopAt, type ResultTop } from '@/engine/cnc/engrave/goalCoverage';

type CrossSectionInstance = InstanceType<ManifoldToplevel['CrossSection']>;

// ---------------------------------------------------------------------------------------------
// Part 1 — the 2D/area design check (gate statement 5).
// ---------------------------------------------------------------------------------------------

/** One item's raw design outline(s) — the INPUT geometry, before any CAM offset, plus the depth it is cut to. */
export interface DesignCheckItem {
  /** #667 — matches `OraclePredicted.itemId` so a report can name the item that failed. */
  itemId?: string;
  /** Outer contours CCW and holes CW, same convention as {@link OraclePolygon} — the raw design, not an offset of it. */
  design: OraclePolygon[];
  /** This item's target depth below the work top face, mm (positive), same convention as `OraclePredicted.depth`. */
  depth: number;
  /** This item's own cutter effective radius at that depth, mm — the wall a cutter of this size cannot enter. Per-item, since one job can mix tools. */
  r: number;
}

/**
 * #924 activation finding — extra padding, beyond an item's own `r + band`, the "too far" clip
 * keeps around its `grown` bbox before comparing against the whole program's slice. Generous
 * compared to ordinary feature sizes (so a genuine over-cut right at the item's own edge is never
 * clipped away) while almost never reaching a neighbouring document item (text/shapes are placed
 * with real gaps between them; see `checkDesignReach`'s own note on why this clip exists at all).
 */
const LOCAL_SLICE_PAD_MM = 1;

/** `box` grown by `pad` on every side. */
function padBbox(box: OracleBbox, pad: number): OracleBbox {
  return { min: [box.min[0] - pad, box.min[1] - pad], max: [box.max[0] + pad, box.max[1] + pad] };
}

/** A single CCW rectangle contour spanning `box`. */
function rectPolygon(box: OracleBbox): OraclePolygon[] {
  return [
    [
      [box.min[0], box.min[1]],
      [box.max[0], box.min[1]],
      [box.max[0], box.max[1]],
      [box.min[0], box.max[1]],
    ],
  ];
}

export interface DesignCheckOptions {
  /**
   * Extra tolerance beyond each item's own `r` for the "no simulated point lies too far out" side,
   * mm. Derived like `oracleBand` when omitted: the same two tolerances (simplify epsilon,
   * arc-chord) the simulated side itself carries.
   */
  band?: number;
}

/** One item's design-check result at its own depth. */
export interface DesignCheckLevel {
  itemId?: string;
  z: number;
  /** Area of the design's own reachable region (eroded by `r`), mm² — the denominator for a reader. */
  reachableArea: number;
  /** Reachable design area the simulation FAILED to remove, mm² (gate statement 5, side 1). */
  unreached: number;
  /** Simulated area more than `r + band` from the design, mm² (gate statement 5, side 2). */
  tooFar: number;
  unreachedBbox?: OracleBbox | null;
  tooFarBbox?: OracleBbox | null;
}

export interface DesignCheckReport {
  ok: boolean;
  /** The extra tolerance beyond each item's own `r`, mm — printed beside the verdict per the acceptance. */
  band: number;
  /** The sample/comparison grid's own resolution note, for the same acceptance line ("a 0.1 mm grid"). */
  gridNote?: string;
  levels: DesignCheckLevel[];
  worst: {
    unreached: number;
    tooFar: number;
    unreachedAt?: { itemId?: string; z: number; bbox: OracleBbox } | null;
    tooFarAt?: { itemId?: string; z: number; bbox: OracleBbox } | null;
  };
  areaFloor: number;
}

/**
 * `Simulation.md` §7's check, against the raw design. One level per item (unlike `computeOracle`,
 * items here are not unioned across levels — each item's own design stands on its own, so a bug
 * that only shows on one item is not averaged away by a neighbour that is fine).
 */
export function checkDesignReach(
  tl: ManifoldToplevel,
  items: readonly DesignCheckItem[],
  sliceAt: OracleSliceAt,
  opts: DesignCheckOptions,
  gridNote?: string,
): DesignCheckReport {
  const CS = tl.CrossSection;
  const band = opts.band ?? SWEEP_SIMPLIFY_EPS_MM + 2 * ARC_CHORD_TOLERANCE_MM;

  const levels: DesignCheckLevel[] = [];
  let worstUnreached = 0;
  let worstTooFar = 0;
  let worstUnreachedAt: { itemId?: string; z: number; bbox: OracleBbox } | null = null;
  let worstTooFarAt: { itemId?: string; z: number; bbox: OracleBbox } | null = null;

  for (const item of items) {
    if (item.design.length === 0 || item.depth <= 0) continue;
    const z = -item.depth;
    let designCS: CrossSectionInstance | null = null;
    let reachable: CrossSectionInstance | null = null;
    let grown: CrossSectionInstance | null = null;
    let sliceCS: CrossSectionInstance | null = null;
    let unreachedCS: CrossSectionInstance | null = null;
    let tooFarCS: CrossSectionInstance | null = null;
    try {
      const segments = segmentsForRadius(Math.max(item.r, item.r + band));
      designCS = CS.ofPolygons(item.design);
      // Side 1: a point the tool can physically enter (>= r from the design's own outline) must be
      // inside the simulated region. A single erosion by the cutter's RAW radius — not the CAM's
      // `offset(offset(design, -planeRadius), tipRadius)` (#584) two-stage reach.
      reachable = designCS.offset(-item.r, 'Round', 2, segments);
      // Side 2: nothing simulated may stand more than r + band from the design.
      grown = designCS.offset(item.r + band, 'Round', 2, segments);
      sliceCS = sliceAt(z + 0.001);

      const reachableArea = Math.max(0, reachable.area());
      let unreached: number;
      let tooFar: number;
      let unreachedBbox: OracleBbox | null = null;
      let tooFarBbox: OracleBbox | null = null;
      if (sliceCS === null) {
        unreached = reachableArea;
        tooFar = 0;
        if (unreached > 0) unreachedBbox = bboxOf(reachable);
      } else {
        unreachedCS = CS.difference([reachable, sliceCS]);
        // #924 activation finding — `sliceAt` is the WHOLE PROGRAM's cut at this Z (`gridSliceAt`/
        // `removalSliceAt`, never scoped to one item), so on a multi-item job with two items cut to
        // similar depths (ordinary V-carved text: a neighbouring letter's groove is still open at
        // THIS item's shallower z, same cone geometry), comparing it directly against this item's
        // own `grown` reads every OTHER item's material as this one's over-cut. Clipped to a pad
        // around THIS item's own bbox before the difference — generous enough that a genuine
        // over-cut near this item's own boundary still shows, but a neighbour's letter metres away
        // does not. Confirmed against the real badge job (#924 activation): unclipped, an ordinary
        // passing item read 71 mm² of "too far" that was entirely "br"'s own strokes.
        const localPad = item.r + band + LOCAL_SLICE_PAD_MM;
        const localBox = padBbox(bboxOf(grown), localPad);
        const localCS = CS.ofPolygons(rectPolygon(localBox));
        const localSlice = sliceCS.intersect(localCS);
        localCS.delete();
        try {
          tooFarCS = CS.difference([localSlice, grown]);
        } finally {
          localSlice.delete();
        }
        unreached = Math.max(0, unreachedCS.area());
        tooFar = Math.max(0, tooFarCS.area());
        if (unreached > 0) unreachedBbox = bboxOf(unreachedCS);
        if (tooFar > 0) tooFarBbox = bboxOf(tooFarCS);
      }

      levels.push({ itemId: item.itemId, z, reachableArea, unreached, tooFar, unreachedBbox, tooFarBbox });
      if (unreached > worstUnreached) {
        worstUnreached = unreached;
        worstUnreachedAt = unreachedBbox === null ? null : { itemId: item.itemId, z, bbox: unreachedBbox };
      }
      if (tooFar > worstTooFar) {
        worstTooFar = tooFar;
        worstTooFarAt = tooFarBbox === null ? null : { itemId: item.itemId, z, bbox: tooFarBbox };
      }
    } finally {
      designCS?.delete();
      reachable?.delete();
      grown?.delete();
      sliceCS?.delete();
      unreachedCS?.delete();
      tooFarCS?.delete();
    }
  }

  const areaFloor = ORACLE_AREA_FLOOR;
  const ok = worstUnreached <= areaFloor && worstTooFar <= areaFloor;
  return {
    ok,
    band,
    gridNote,
    levels,
    worst: { unreached: worstUnreached, tooFar: worstTooFar, unreachedAt: worstUnreachedAt, tooFarAt: worstTooFarAt },
    areaFloor,
  };
}

// ---------------------------------------------------------------------------------------------
// Part 2 — analytic volumes, a second implementation (gate statement 6).
// ---------------------------------------------------------------------------------------------

/**
 * The volume a FLAT-bottomed round tool of radius `r` removes tracing a straight run of length `L`
 * (centre-to-centre) to a constant depth `d` — a prism the length of the run plus a half-cylinder
 * cap at each end, i.e. the capsule footprint times the depth:
 *
 *   V = (2 r L + pi r^2) * d
 *
 * Derived directly from the swept solid's own shape (a capsule prism), never from the engine's
 * `capsuleArea`/`capsuleContours` (`workers/geometry/sweep.ts`) — this is a second, independent
 * implementation of the same number, not a caller of the first one.
 */
export function flatCapsuleVolumeMm3(lengthMm: number, radiusMm: number, depthMm: number): number {
  if (lengthMm < 0 || radiusMm <= 0 || depthMm <= 0) return 0;
  return (2 * radiusMm * lengthMm + Math.PI * radiusMm * radiusMm) * depthMm;
}

/**
 * The volume a V cutter of half-angle `halfAngleDeg` removes tracing a straight run of length `L`
 * to tip depth `d`, body uncapped (the stroke is shallower than the cutter's cone-to-body
 * transition — #741's own condition for the bug: this formula is only valid while the cut stays
 * on the cone, which is the caller's job to confirm against the tool's own `outerRadius`/`maxGrow`,
 * never this function's).
 *
 * At a horizontal slice `z` below the tip (0 <= z <= d) the cone's radius is `z * tan(halfAngle)`,
 * so the slice's own footprint is a capsule of that radius along the same run — same shape as
 * {@link flatCapsuleVolumeMm3}, but the radius now varies with depth. Integrating
 * `2*L*z*tan(a) + pi*z^2*tan(a)^2` from 0 to d gives the closed form:
 *
 *   V = L * tan(a) * d^2 + (pi/3) * tan(a)^2 * d^3
 *
 * (the first term is the straight wedge the full length runs; the second is one full cone — the
 * two half-cone ends of the stroke, capsule-style, add up to exactly one). Independent of
 * `grooveRadiusAt`/`VCone` (`engine/cnc/vProfile.ts`) — this integrates the cone's own geometry
 * directly, never calling the engine's cone-sweep code.
 */
export function vGrooveVolumeMm3(lengthMm: number, halfAngleDeg: number, depthMm: number): number {
  if (lengthMm < 0 || halfAngleDeg <= 0 || halfAngleDeg >= 90 || depthMm <= 0) return 0;
  const t = Math.tan((halfAngleDeg * Math.PI) / 180);
  return lengthMm * t * depthMm * depthMm + (Math.PI / 3) * t * t * depthMm * depthMm * depthMm;
}

export interface VolumeAgreementOptions {
  /** Relative tolerance band, as a fraction of the analytic figure. Defaults to 2% — well inside the #741 gap (20-60%), well outside ordinary float/approximation drift. */
  toleranceFraction?: number;
}

export interface VolumeAgreementReport {
  ok: boolean;
  analyticMm3: number;
  simulatedMm3: number;
  /** `(simulated - analytic) / analytic`, signed — positive means the simulation removed MORE than the independent figure predicts (#741's direction). */
  excessFraction: number;
  toleranceFraction: number;
  sentence: string;
}

/** Compares a simulated/measured removed volume against one of the closed forms above, gate statement 6. */
export function checkVolumeAgreement(
  itemLabel: string,
  simulatedMm3: number,
  analyticMm3: number,
  opts: VolumeAgreementOptions = {},
): VolumeAgreementReport {
  const toleranceFraction = opts.toleranceFraction ?? 0.02;
  const excessFraction = analyticMm3 > 0 ? (simulatedMm3 - analyticMm3) / analyticMm3 : simulatedMm3 > 0 ? Infinity : 0;
  const ok = Math.abs(excessFraction) <= toleranceFraction;
  const pct = (excessFraction * 100).toFixed(1);
  const sentence = ok
    ? `${itemLabel}: removed volume agrees with the analytic figure (${pct} %, within ${(toleranceFraction * 100).toFixed(0)} %).`
    : `${itemLabel}: removed volume disagrees with the analytic figure by ${pct} % (simulated ${simulatedMm3.toFixed(1)} mm³ vs analytic ${analyticMm3.toFixed(1)} mm³) — outside the ${(toleranceFraction * 100).toFixed(0)} % tolerance.`;
  return { ok, analyticMm3, simulatedMm3, excessFraction, toleranceFraction, sentence };
}

// ---------------------------------------------------------------------------------------------
// Part 3 — the 3D half (#924's scope note, #909): swept surface vs the goal heightfield.
// ---------------------------------------------------------------------------------------------

/** 0.01 mm — the same floor `tools/goal_check.py`'s `CUT_INTO` constant uses before a dip counts as cut-into rather than float/grid noise. */
export const GOAL_CUT_INTO_FLOOR_MM = 0.01;

/** The leftover-material reporting bands `goal_check.py` prints (0.1 / 0.3 / 1 mm), kept here so the app's sentence matches the bench tool's. */
export const GOAL_LEFTOVER_BANDS_MM = [0.1, 0.3, 1] as const;

export interface GoalCutIntoOptions {
  /** Overrides {@link GOAL_CUT_INTO_FLOOR_MM}. */
  cutIntoFloorMm?: number;
}

export interface GoalCutIntoReport {
  ok: boolean;
  /** Covered goal cells the comparison ran over. */
  goalCells: number;
  pitchMm: number;
  cutIntoFloorMm: number;
  /** Share of covered cells cut more than the floor below the goal, 0-1. */
  cutIntoFraction: number;
  cutIntoAreaMm2: number;
  /** `sum(max(0, goalTop - sweptTop)) * cellArea` over cut-into cells — volume over-cut into the part, mm³. */
  cutIntoVolumeMm3: number;
  maxCutIntoMm: number;
  /** Share of covered cells left standing more than each of {@link GOAL_LEFTOVER_BANDS_MM} above the goal, 0-1, same order. */
  leftoverFractions: number[];
  leftoverVolumeMm3: number;
  maxLeftoverMm: number;
  /** Share of covered cells within the cut-into floor on both sides — the coverage % the acceptance asks for. */
  coverageFraction: number;
  medianDeltaMm: number;
  sentence: string;
}

/**
 * The 3D analogue of {@link checkDesignReach}: compares the ACTUAL swept surface with the GOAL
 * heightfield, not with the app's own cut plan — closing the gap #909 named ("the app's own check
 * passes, because it compares the simulation with the app's plan, not with the goal"). Ported
 * numerically from the bench's `docs/bench/2026-10-28-z1-real-jobs/tools/goal_check.py` (`d =
 * sweptTop - goalTop` over covered goal cells; `d < -CUT_INTO` is cut INTO the part, `d` above the
 * leftover bands is material left standing) so the app can read the same verdict in-app, for
 * #945/#946's pass criteria, rather than only the demo page's external tool.
 */
export function checkGoalCutInto(goal: GoalHeightfield, sweptTop: ResultTop, opts: GoalCutIntoOptions = {}): GoalCutIntoReport {
  const cutIntoFloorMm = opts.cutIntoFloorMm ?? GOAL_CUT_INTO_FLOOR_MM;
  const cellArea = goal.pitch * goal.pitch;
  const deltas: number[] = [];
  let cutIntoCells = 0;
  let cutIntoVolumeMm3 = 0;
  let maxCutInto = 0;
  const leftoverCounts = GOAL_LEFTOVER_BANDS_MM.map(() => 0);
  let leftoverVolumeMm3 = 0;
  let maxLeftover = 0;
  let withinBoth = 0;
  let covered = 0;

  for (let j = 0; j < goal.ny; j++) {
    for (let i = 0; i < goal.nx; i++) {
      const k = j * goal.nx + i;
      if (goal.covered[k] !== 1) continue;
      const x = goal.x0 + i * goal.pitch;
      const y = goal.y0 + j * goal.pitch;
      const top = sweptTop(x, y);
      if (top === null) continue;
      covered++;
      const goalTop = goal.z[k] as number;
      const d = top - goalTop; // + leftover, - cut-into, same sign convention as goal_check.py
      deltas.push(d);
      if (d < -cutIntoFloorMm) {
        cutIntoCells++;
        cutIntoVolumeMm3 += -d * cellArea;
        maxCutInto = Math.max(maxCutInto, -d);
      }
      for (let b = 0; b < GOAL_LEFTOVER_BANDS_MM.length; b++) {
        if (d > GOAL_LEFTOVER_BANDS_MM[b]!) leftoverCounts[b]! += 1;
      }
      if (d > GOAL_LEFTOVER_BANDS_MM[0]!) {
        leftoverVolumeMm3 += d * cellArea;
        maxLeftover = Math.max(maxLeftover, d);
      }
      if (Math.abs(d) <= cutIntoFloorMm) withinBoth++;
    }
  }

  const n = Math.max(covered, 1);
  deltas.sort((a, b) => a - b);
  const medianDeltaMm = deltas.length === 0 ? 0 : deltas[Math.floor(deltas.length / 2)]!;
  const cutIntoFraction = cutIntoCells / n;
  const leftoverFractions = leftoverCounts.map((c) => c / n);
  const coverageFraction = withinBoth / n;
  const ok = cutIntoCells === 0;
  const sentence = ok
    ? `goal check: no cell cut more than ${cutIntoFloorMm} mm into the goal (${(coverageFraction * 100).toFixed(1)} % of the goal within ${cutIntoFloorMm} mm).`
    : `goal check: ${(cutIntoFraction * 100).toFixed(2)} % of the goal (${cutIntoAreaMm2(cutIntoCells, cellArea).toFixed(1)} mm²) cut into by up to ${maxCutInto.toFixed(3)} mm — ${cutIntoVolumeMm3.toFixed(1)} mm³ over-cut.`;

  return {
    ok,
    goalCells: covered,
    pitchMm: goal.pitch,
    cutIntoFloorMm,
    cutIntoFraction,
    cutIntoAreaMm2: cutIntoAreaMm2(cutIntoCells, cellArea),
    cutIntoVolumeMm3,
    maxCutIntoMm: maxCutInto,
    leftoverFractions,
    leftoverVolumeMm3,
    maxLeftoverMm: maxLeftover,
    coverageFraction,
    medianDeltaMm,
    sentence,
  };
}

function cutIntoAreaMm2(cells: number, cellArea: number): number {
  return cells * cellArea;
}

export { goalTopAt };
