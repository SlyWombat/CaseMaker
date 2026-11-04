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
import type { GoalHeightfield } from '@/engine/cnc/engrave/goalHeightfield';
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
  /**
   * A design footprint that explains removal near other items but is not graded itself (a drilled
   * hole: its disc from the job's own hole centres and radius). Without it, a hole beside a label
   * reads as that label's "too far".
   */
  allowOnly?: true;
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

  // "Too far" is removal no design item cut at least this deep accounts for. Every item's allowance
  // (its design grown by its own r + band) is built once; a graded item is then compared against the
  // union of its own and every other allowance that reaches its depth and its local box, so a
  // neighbouring item, a deeper pocket or a drilled hole is never charged to it.
  const usable = items.filter((it) => it.design.length > 0 && it.depth > 0);
  const allowances = usable.map((it) => {
    const cs = CS.ofPolygons(it.design);
    try {
      const grownAll = cs.offset(it.r + band, 'Round', 2, segmentsForRadius(Math.max(it.r, it.r + band)));
      return { item: it, grown: grownAll, box: bboxOf(grownAll) };
    } finally {
      cs.delete();
    }
  });
  const overlaps = (a: OracleBbox, b: OracleBbox): boolean =>
    a.min[0] <= b.max[0] && b.min[0] <= a.max[0] && a.min[1] <= b.max[1] && b.min[1] <= a.max[1];

  try {
    for (const item of usable) {
      if (item.allowOnly === true) continue;
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
          const others = allowances
            .filter((a) => a.item !== item && a.item.depth >= item.depth - 1e-6 && overlaps(a.box, localBox))
            .map((a) => a.grown);
          try {
            tooFarCS = CS.difference([localSlice, grown, ...others]);
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
  } finally {
    for (const a of allowances) a.grown.delete();
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

/**
 * #948 — THE PASS LINE's LABELLED FALLBACK: the share of the goal's top surface that must stand
 * within the 0.1 mm band (the first leftover band) for the run to pass. It is the demo page's own
 * rule — "zero cut-into AND top-surface coverage ≥ 95 %" — and the shop owns it as
 * `goal.passCoverage` (seeded 0.95); this is the number a caller with no location reads, labelled
 * as a fallback.
 */
export const GOAL_PASS_COVERAGE_FALLBACK = 0.95;

export interface GoalCutIntoOptions {
  /** Overrides {@link GOAL_CUT_INTO_FLOOR_MM}. */
  cutIntoFloorMm?: number;
  /**
   * #948 — the sampler the LEFTOVER bands and the pass line are read with. The page judges them
   * from the swept top at each goal cell's centre (its own stamp); a caller that can reproduce
   * that read for the same program hands it here, and `sweptTop` stays the cut-into judge. Absent:
   * `sweptTop` answers both (the pre-#948 reading).
   */
  leftoverTop?: ResultTop;
  /**
   * #948 — the top-surface coverage the run must reach to pass, 0–1: the share of the goal's
   * covered cells standing within {@link GOAL_LEFTOVER_BANDS_MM}[0] of the goal. The shop's
   * `goal.passCoverage`; absent → {@link GOAL_PASS_COVERAGE_FALLBACK}.
   */
  passCoverage?: number;
  /**
   * #955/V2-2 — THE EDGE-BREAK ALLOWANCE, as GATE parameters (A's R3): the V bit's cutting reach
   * of a design edge and the cone's own leg, computed by the caller from the job's `edgeBreak`
   * field capped by the chamfer Tool record — never from the CAM's plan. Absent = no allowance and
   * the pre-V2-2 reading exactly, so a job with no edge break keeps every existing pin.
   */
  edgeBreak?: { reachMm: number; legMm: number };
  /**
   * #955 — the largest cutting tool's radius, mm, for the wall-shadow exclusion. Absent = the
   * shadow class is reported as 0 (a caller with no tool set); the edge-break band still runs.
   */
  wallShadowRadiusMm?: number;
}

export interface GoalCutIntoReport {
  ok: boolean;
  /**
   * #948 — FALSE when the comparison could not run at all (no swept top to sample: a rotary or
   * exact-engine sweep the caller could get no flat top from). The numeric fields are then zero
   * and `ok` stays TRUE — an unchecked goal is a stated gap, not a pass and not a failure — and
   * {@link reason} says why. Every report a comparison produced has this true.
   */
  ran: boolean;
  /** Why the comparison did not run; null when {@link ran} is true. */
  reason: string | null;
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
  /**
   * #948 — WHERE the deepest cut-into cell is, in the work frame (the goal cell's own sample
   * point), so the Cut card can say "Cuts 0.42 mm into the design at 41.2, 25.3" rather than only
   * how deep. Null when nothing was cut into — and null on an unchecked report, where there is no
   * cell to name.
   */
  maxCutIntoAt: { x: number; y: number } | null;
  /** Share of covered cells left standing more than each of {@link GOAL_LEFTOVER_BANDS_MM} above the goal, 0-1, same order. */
  leftoverFractions: number[];
  leftoverVolumeMm3: number;
  maxLeftoverMm: number;
  /** Share of covered cells within the cut-into floor on both sides — the coverage % the acceptance asks for. */
  coverageFraction: number;
  /**
   * #948 — the TOP-SURFACE coverage the pass line was judged at, 0–1: the share of covered cells
   * standing within {@link GOAL_LEFTOVER_BANDS_MM}[0] (0.1 mm) of the goal — the demo page's
   * `coveragePct` = 100 − 100 × `leftoverFractions[0]`. NOT the same band as
   * {@link coverageFraction}. The report states the number it judged against so a reader never has
   * to know the constant; the measured value is `1 − leftoverFractions[0]`.
   */
  passCoverage: number;
  /** #955/V2-2 — share of covered cells excluded as EDGE BREAK (a V bit within its reach of a design edge, no deeper than its leg), 0-1. */
  edgeBreakFraction: number;
  /** #955 — share excluded as WALL CELLS (a cell straddling a wall step), 0-1. */
  wallNotScoredFraction: number;
  /** #955 — share excluded as WALL SHADOW (behind a wall, beyond the sweep's reach), 0-1. */
  shadowNotScoredFraction: number;
  /** #955 — the 0.1 mm-floor share AFTER the exclusions: the pass line's judged number, 0-1. */
  adjudicatedFraction: number;
  medianDeltaMm: number;
  sentence: string;
}

/**
 * #955/V2-2 — THE DESIGN EDGES a heightfield can see: a step deeper than 0.2 mm between
 * neighbouring goal cells (a wall), or the model's silhouette (a covered cell beside an uncovered
 * one). Both sides of a step are marked, as E's `goal_check.py` does.
 */
const GOAL_EDGE_STEP_MM = 0.2;

function designEdgeCells(goal: GoalHeightfield): Uint8Array {
  const { nx, ny, covered, z } = goal;
  const wall = new Uint8Array(nx * ny);
  // An uncovered cell reads as the stock below the goal: any covered neighbour then differs by far
  // more than the step, which is the silhouette edge (#955's rim).
  const outside = goal.minZ - 1;
  const at = (k: number): number => (covered[k] === 1 ? (z[k] as number) : outside);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      if (i + 1 < nx && Math.abs(at(k) - at(k + 1)) > GOAL_EDGE_STEP_MM) {
        wall[k] = 1;
        wall[k + 1] = 1;
      }
      if (j + 1 < ny && Math.abs(at(k) - at(k + nx)) > GOAL_EDGE_STEP_MM) {
        wall[k] = 1;
        wall[k + nx] = 1;
      }
    }
  }
  return wall;
}

/** Every cell within `radiusMm` of a set cell (the disk dilation `goal_check.py` uses). */
function dilateCells(mask: Uint8Array, nx: number, ny: number, pitch: number, radiusMm: number): Uint8Array {
  const out = new Uint8Array(nx * ny);
  const r = Math.ceil(radiusMm / pitch);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      if (mask[j * nx + i] !== 1) continue;
      for (let dj = -r; dj <= r; dj++) {
        const jj = j + dj;
        if (jj < 0 || jj >= ny) continue;
        for (let di = -r; di <= r; di++) {
          const ii = i + di;
          if (ii < 0 || ii >= nx) continue;
          if (Math.hypot(di * pitch, dj * pitch) > radiusMm + 1e-9) continue;
          out[jj * nx + ii] = 1;
        }
      }
    }
  }
  return out;
}

/**
 * The 3D analogue of {@link checkDesignReach}: compares the ACTUAL swept surface with the GOAL
 * heightfield, not with the app's own cut plan — closing the gap #909 named ("the app's own check
 * passes, because it compares the simulation with the app's plan, not with the goal"). Ported
 * numerically from the bench's `docs/bench/2026-10-28-z1-real-jobs/tools/goal_check.py` (`d =
 * sweptTop - goalTop` over covered goal cells; `d < -CUT_INTO` is cut INTO the part, `d` above the
 * leftover bands is material left standing) so the app can read the same verdict in-app, for
 * #945/#946's pass criteria, rather than only the demo page's external tool.
 *
 * #955/V2-2 — THE EDGE-BREAK ALLOWANCE (E's `goal_check.py` rule, ported): a cell cut into by a V
 * bit within that bit's reach of a design edge, and no deeper below the goal than the bit's leg, is
 * EDGE BREAK and not cut-into. The bit's reach/leg are GATE parameters handed in by the caller from
 * the job's `edgeBreak` field and the chamfer Tool record (A's R3); this function reads no CAM plan.
 * Wall cells and the wall shadow are reported as unadjudicable shares beside the verdict, exactly
 * as E reports them. With no `edgeBreak` option the pre-V2-2 reading is returned to the bit.
 */
export function checkGoalCutInto(goal: GoalHeightfield, sweptTop: ResultTop, opts: GoalCutIntoOptions = {}): GoalCutIntoReport {
  const cutIntoFloorMm = opts.cutIntoFloorMm ?? GOAL_CUT_INTO_FLOOR_MM;
  const passCoverage = opts.passCoverage ?? GOAL_PASS_COVERAGE_FALLBACK;
  const cellArea = goal.pitch * goal.pitch;
  const nx = goal.nx;
  const ny = goal.ny;
  const cells = nx * ny;
  const dOf = new Float64Array(cells);
  const sampled = new Uint8Array(cells);
  const deltas: number[] = [];
  const leftoverCounts = GOAL_LEFTOVER_BANDS_MM.map(() => 0);
  let leftoverVolumeMm3 = 0;
  let maxLeftover = 0;
  let withinBoth = 0;
  let covered = 0;

  const leftoverTop = opts.leftoverTop ?? sweptTop;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      if (goal.covered[k] !== 1) continue;
      const x = goal.x0 + i * goal.pitch;
      const y = goal.y0 + j * goal.pitch;
      const top = sweptTop(x, y);
      if (top === null) continue;
      covered++;
      const goalTop = goal.z[k] as number;
      const d = top - goalTop; // + leftover, - cut-into, same sign convention as goal_check.py
      dOf[k] = d;
      sampled[k] = 1;
      deltas.push(d);
      // #948 — the leftover bands and the pass line read the page's own point of the sweep; the
      // cut-into figures stay on the conservative read.
      const dLeft = (leftoverTop(x, y) ?? top) - goalTop;
      for (let b = 0; b < GOAL_LEFTOVER_BANDS_MM.length; b++) {
        if (dLeft > GOAL_LEFTOVER_BANDS_MM[b]!) leftoverCounts[b]! += 1;
      }
      if (dLeft > GOAL_LEFTOVER_BANDS_MM[0]!) {
        leftoverVolumeMm3 += dLeft * cellArea;
        maxLeftover = Math.max(maxLeftover, dLeft);
      }
      if (Math.abs(d) <= cutIntoFloorMm) withinBoth++;
    }
  }

  const n = Math.max(covered, 1);
  // THE RAW CUT (before any exclusion) — the figure the report has always carried.
  let rawCutCells = 0;
  for (let k = 0; k < cells; k++) {
    if (sampled[k] === 1 && dOf[k]! < -cutIntoFloorMm) rawCutCells++;
  }

  // #955/V2-2 — the allowance, only when the job states an edge break (no option = no exclusions).
  let excluded: Uint8Array | null = null;
  let edgeBreakCells = 0;
  let wallNotScoredCells = 0;
  let shadowNotScoredCells = 0;
  const allowance = opts.edgeBreak;
  if (allowance !== undefined && allowance.reachMm > 0 && allowance.legMm > 0) {
    const wall = designEdgeCells(goal);
    const band = dilateCells(wall, nx, ny, goal.pitch, allowance.reachMm);
    const shadowRadius = opts.wallShadowRadiusMm;
    const shadow =
      shadowRadius !== undefined && shadowRadius > 0
        ? dilateCells(wall, nx, ny, goal.pitch, shadowRadius)
        : null;
    excluded = new Uint8Array(cells);
    for (let k = 0; k < cells; k++) {
      if (sampled[k] !== 1 || dOf[k]! >= -cutIntoFloorMm) continue;
      const depth = -dOf[k]!;
      if (band[k] === 1 && depth <= allowance.legMm + 1e-9) {
        excluded[k] = 1;
        edgeBreakCells++;
        continue;
      }
      if (wall[k] === 1) {
        excluded[k] = 1;
        wallNotScoredCells++;
        continue;
      }
      if (shadow !== null && shadow[k] === 1 && wall[k] !== 1) {
        excluded[k] = 1;
        shadowNotScoredCells++;
      }
    }
  }

  // THE ADJUDICATED SET — what the pass and the sentence judge.
  let cutIntoCells = 0;
  let cutIntoVolumeMm3 = 0;
  let maxCutInto = 0;
  let maxCutIntoAt: { x: number; y: number } | null = null;
  let adjudicated0p1Cells = 0;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      if (sampled[k] !== 1) continue;
      if (dOf[k]! >= -cutIntoFloorMm) continue;
      if (excluded !== null && excluded[k] === 1) continue;
      cutIntoCells++;
      const depth = -dOf[k]!;
      cutIntoVolumeMm3 += depth * cellArea;
      if (depth > maxCutInto) {
        maxCutInto = depth;
        maxCutIntoAt = { x: goal.x0 + i * goal.pitch, y: goal.y0 + j * goal.pitch };
      }
      if (depth > 0.1) adjudicated0p1Cells++;
    }
  }

  deltas.sort((a, b) => a - b);
  const medianDeltaMm = deltas.length === 0 ? 0 : deltas[Math.floor(deltas.length / 2)]!;
  const cutIntoFraction = rawCutCells / n;
  const adjudicatedFraction = adjudicated0p1Cells / n;
  const edgeBreakFraction = edgeBreakCells / n;
  const wallNotScoredFraction = wallNotScoredCells / n;
  const shadowNotScoredFraction = shadowNotScoredCells / n;
  const leftoverFractions = leftoverCounts.map((c) => c / n);
  const coverageFraction = withinBoth / n;
  // #948 — THE PASS LINE. The page's rule is zero cut-into AND top-surface coverage ≥ the pass
  // line, where coverage is the share standing within the FIRST leftover band (0.1 mm) of the
  // goal — `1 − leftoverFractions[0]`, never `coverageFraction` (a different band). A run that
  // cut nothing into the goal but left 16 % of it standing above the goal is the page's
  // "Deviates", so it is not this check's pass either.
  const surfaceCoverage = 1 - (leftoverFractions[0] ?? 0);
  const passPct = Number((passCoverage * 100).toFixed(2));
  const surfacePct = Number((surfaceCoverage * 100).toFixed(2));
  const coverageOk = surfaceCoverage + 1e-9 >= passCoverage;
  // #955/V2-2 — WITH AN EDGE BREAK THE PASS IS THE PAGE'S LINE: zero at the 0.1 mm floor after the
  // three exclusions (E's `cutInto0p1Pct`; F's scorer line 2). Without one the pre-V2-2 reading
  // stands exactly: zero at the check's own floor (0.01 mm by default). The 0.01 residue a V bit
  // leaves inside the 0.1 band is the advisory figure, never the verdict.
  const allowanceActive = allowance !== undefined && allowance.reachMm > 0 && allowance.legMm > 0;
  const judgedCells = allowanceActive ? adjudicated0p1Cells : cutIntoCells;
  const judgedFloor = allowanceActive ? 0.1 : cutIntoFloorMm;
  const ok = judgedCells === 0 && coverageOk;
  const excludedNote =
    edgeBreakCells + wallNotScoredCells + shadowNotScoredCells > 0
      ? ` (the rim edge break${edgeBreakCells > 0 ? `, ${(edgeBreakFraction * 100).toFixed(2)} % of the goal,` : ''} and ${(wallNotScoredFraction * 100 + shadowNotScoredFraction * 100).toFixed(2)} % of cells the heightfield cannot adjudicate are not counted)`
      : '';
  const adjudicatedCutFraction = cutIntoCells / n;
  const sentence =
    judgedCells > 0
      ? `goal check: ${(adjudicatedCutFraction * 100).toFixed(2)} % of the goal (${cutIntoAreaMm2(cutIntoCells, cellArea).toFixed(1)} mm²) cut into by up to ${maxCutInto.toFixed(3)} mm — ${cutIntoVolumeMm3.toFixed(1)} mm³ over-cut.`
      : coverageOk
        ? `goal check: no cell cut more than ${judgedFloor} mm into the goal${excludedNote} (${(coverageFraction * 100).toFixed(1)} % of the goal within ${cutIntoFloorMm} mm).`
        : `goal check: coverage ${surfacePct} % of the goal's top surface — the pass line asks ${passPct} % (${((1 - surfaceCoverage) * 100).toFixed(2)} % stands more than ${GOAL_LEFTOVER_BANDS_MM[0]} mm above the goal).`;

  return {
    ok,
    ran: true,
    reason: null,
    goalCells: covered,
    pitchMm: goal.pitch,
    cutIntoFloorMm,
    cutIntoFraction,
    cutIntoAreaMm2: cutIntoAreaMm2(cutIntoCells, cellArea),
    cutIntoVolumeMm3,
    maxCutIntoMm: maxCutInto,
    maxCutIntoAt,
    leftoverFractions,
    leftoverVolumeMm3,
    maxLeftoverMm: maxLeftover,
    coverageFraction,
    passCoverage,
    medianDeltaMm,
    edgeBreakFraction,
    wallNotScoredFraction,
    shadowNotScoredFraction,
    adjudicatedFraction,
    sentence,
  };
}

function cutIntoAreaMm2(cells: number, cellArea: number): number {
  return cells * cellArea;
}

/**
 * #948 — a goal whose swept top the caller could not sample, STATED rather than skipped. The
 * report carries `ran: false` and the reason, and `ok` is true: the run is not failed for a check
 * that could not run, and it is never reported as a pass either (the sentence says what was not
 * compared). A caller that can sample the swept top calls {@link checkGoalCutInto} instead.
 */
export function goalCutIntoUnchecked(reason: string, passCoverage: number = GOAL_PASS_COVERAGE_FALLBACK): GoalCutIntoReport {
  return {
    ok: true,
    ran: false,
    reason,
    goalCells: 0,
    pitchMm: 0,
    cutIntoFloorMm: GOAL_CUT_INTO_FLOOR_MM,
    cutIntoFraction: 0,
    cutIntoAreaMm2: 0,
    cutIntoVolumeMm3: 0,
    maxCutIntoMm: 0,
    maxCutIntoAt: null,
    leftoverFractions: GOAL_LEFTOVER_BANDS_MM.map(() => 0),
    leftoverVolumeMm3: 0,
    maxLeftoverMm: 0,
    coverageFraction: 0,
    passCoverage,
    medianDeltaMm: 0,
    edgeBreakFraction: 0,
    wallNotScoredFraction: 0,
    shadowNotScoredFraction: 0,
    adjudicatedFraction: 0,
    sentence: `goal check: not run — ${reason}. Nothing was compared against the goal here, so this is not a pass.`,
  };
}

export { goalTopAt };
