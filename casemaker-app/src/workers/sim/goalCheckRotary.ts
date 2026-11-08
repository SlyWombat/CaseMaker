/**
 * #1083 — THE GOAL CHECK ON THE ROTARY MAP.
 *
 * A rotary relief's material is not a heightfield over (X, Y): the sweep keeps it as a column grid
 * in the MAP frame — `u` is work X, `v` is the stock's angle θ in degrees, `h` is the remaining
 * RADIUS from the axis (`ColumnGrid`) — and the CAM cut the program from the goal's own radial
 * field (`GoalRadialField`: the same (X, arc) map, its cells holding the goal's radius less the
 * design radius, or "stock" where no ray hit). The flat comparison (`checkGoalCutInto`) cannot
 * read either, which is why every rotary goal reported "not run" (#1059's readiness run).
 *
 * This module compares the two where they live. Per goal-map cell:
 *
 *   - the goal's radius is `radius + z` where a ray hit, else the stock's own surface at that
 *     angle (`sectionRadiusAt`: a block's flats are inside the envelope by design, and a cell the
 *     relief does not cut keeps them);
 *   - the cut's radius is the column grid's `h` at that (X, θ), the same number the sweep wrote;
 *   - the difference keeps the flat check's sign convention: positive is material standing above
 *     the goal (the leftover bands and coverage), negative is cut-into.
 *
 * No edge-break, wall or shadow exclusions run here: those are heightfield classes about steps in
 * a flat surface, and the map frame has no such steps. The report states them as zero, and the
 * sentence names the frame so a reader never compares it with a plate's.
 */

import type { RotarySection } from '@/engine/cnc/rotary/wrap';
import type { GoalRadialField } from '@/engine/cnc/rotary/radialField';
import type { ColumnGrid } from '@/workers/geometry/columnEngine';
import {
  GOAL_CUT_INTO_FLOOR_MM,
  GOAL_LEFTOVER_BANDS_MM,
  GOAL_PASS_COVERAGE_FALLBACK,
  type GoalCutIntoOptions,
  type GoalCutIntoReport,
} from '@/engine/cnc/engrave/designCheck';

/** The report's own words for one percentage (one decimal, as the flat sentence prints it). */
const pct = (v: number): string => `${(v * 100).toFixed(2)} %`;
const mm3 = (v: number): string => String(Math.round(v * 1000) / 1000);

/**
 * The swept radius at one map point, mm: the grid's own `h`, read the conservative way the flat
 * check reads its top — the HIGHEST of the columns bracketing the point (one column lenient, blind
 * to a gouge narrower than a cell). Null outside the grid's own X span or angle range.
 */
function gridRadiusAt(grid: ColumnGrid, radius: number, x: number, arcMm: number): number | null {
  if (grid.kind !== 'rotary') return null;
  const fi = (x - grid.u0) / grid.du;
  // A cell centre exactly on the last column is a float hair past it (`24 × 0.2 / 0.2` reads
  // 24.000000000000004): the tolerance is the read's own epsilon, never a wider span.
  if (fi < -1e-6 || fi > grid.nu - 1 + 1e-6) return null;
  const deg = (arcMm / radius) * (180 / Math.PI);
  // The grid's v is the program's A, unwound (the relief starts wherever the map's seam falls), so
  // bring the point into the grid's own revolution first, then read it as a fraction of a turn:
  // the map wraps at 360°, and the goal's own row grid (an exact 2πR turn) and the sweep's column
  // count (360°/nv) differ by a sub-cell phase at the seam — the bracket wraps with them.
  let f = ((deg - grid.v0) % 360 + 360) % 360;
  f = (f / grid.dv) % grid.nv;
  const i0 = Math.max(0, Math.min(grid.nu - 2, Math.floor(fi)));
  const j0 = Math.floor(f);
  const j1 = (j0 + 1) % grid.nv;
  const at = (i: number, jj: number): number => grid.h[jj * grid.nu + i]!;
  return Math.max(at(i0, j0), at(i0 + 1, j0), at(i0, j1), at(i0 + 1, j1));
}

/**
 * The run's own map tolerance, so the check judges by the resolution the grid actually has — the
 * same two terms the rotary PREDICTION oracle carries (`computeRotaryOracle`): a cell's
 * half-diagonal in map millimetres, and the cutter's facet rise at the cell's own radius (a ball's
 * sphere-cap edge, a V's cone edge; zero for a flat). Without it, every steep feature's column
 * model reads a few tenths below the design and the check would call the model's own
 * discretisation "cut-into" — the #1059 readiness run read 66 % that way.
 */
export interface RotaryGoalAllowance {
  /** The cell's half-diagonal in map millimetres (`hypot(du, arc(dv))/2`). */
  cellMm: number;
  /** The facet rise at a tip radius, mm (0 for a flat, a ball's edge, a V's cone edge). */
  facetAt: (tipRadiusMm: number) => number;
}

export function checkGoalCutIntoRotary(
  goal: GoalRadialField,
  grid: ColumnGrid,
  section: RotarySection | null,
  opts: GoalCutIntoOptions = {},
  allowance?: RotaryGoalAllowance,
  /**
   * #1086 — THE EXACT STAMP on the goal's own grid (`stampRotarySweptField`): when present it is
   * the VERDICT's read — the cell's remaining radius is what the posted program left there, not
   * the column grid's max-of-four bracket — and the column read is kept as the stated diagnostic
   * `columnCutInto`. The stamp needs no cell/facet allowance (it resolves finer than the grid):
   * only the cut-into floor applies to it.
   */
  exact?: Float32Array | null,
): GoalCutIntoReport {
  const cutIntoFloorMm = opts.cutIntoFloorMm ?? GOAL_CUT_INTO_FLOOR_MM;
  const passCoverage = opts.passCoverage ?? GOAL_PASS_COVERAGE_FALLBACK;
  const cellMm = allowance?.cellMm ?? 0;
  const facetAt = allowance?.facetAt ?? ((): number => 0);
  const toleranceAt = (designR: number): number => cutIntoFloorMm + cellMm + facetAt(designR);
  const stamped = exact !== null && exact !== undefined && exact.length === goal.nx * goal.ny ? exact : null;
  const radius = goal.radius;
  const cellArea = goal.pitch * goal.pitch;
  const cells = goal.nx * goal.ny;
  const dOf = new Float64Array(cells);
  const sampled = new Uint8Array(cells);
  // #1086 — the column read beside the stamp: every covered cell the column grid can answer for.
  const colDOf = stamped === null ? null : new Float64Array(cells);
  const colSampled = stamped === null ? null : new Uint8Array(cells);
  const deltas: number[] = [];
  const leftoverCounts = GOAL_LEFTOVER_BANDS_MM.map(() => 0);
  let leftoverVolumeMm3 = 0;
  let maxLeftover = 0;
  let withinBoth = 0;
  let covered = 0;

  for (let j = 0; j < goal.ny; j++) {
    const arcMm = goal.y0 + j * goal.pitch;
    for (let i = 0; i < goal.nx; i++) {
      const k = j * goal.nx + i;
      if (goal.covered[k] !== 1) continue;
      const x = goal.x0 + i * goal.pitch;
      const colR = gridRadiusAt(grid, radius, x, arcMm);
      // #1086 — with the stamp every covered cell is compared (the field is defined everywhere);
      // without it, a cell outside the swept map is not compared and never counted as a pass.
      if (stamped === null && colR === null) continue;
      const cutR = stamped === null ? (colR as number) : stamped[k]!;
      covered++;
      const designR = radius + goal.z[k]!;
      if (colDOf !== null && colSampled !== null && colR !== null) {
        colDOf[k] = colR - designR;
        colSampled[k] = 1;
      }
      const d = cutR - designR; // + leftover, - cut-into: the flat check's own sign convention
      dOf[k] = d;
      sampled[k] = 1;
      deltas.push(d);
      for (let b = 0; b < GOAL_LEFTOVER_BANDS_MM.length; b++) {
        if (d > GOAL_LEFTOVER_BANDS_MM[b]!) leftoverCounts[b]! += 1;
      }
      if (d > GOAL_LEFTOVER_BANDS_MM[0]!) {
        leftoverVolumeMm3 += d * cellArea;
        maxLeftover = Math.max(maxLeftover, d);
      }
      if (Math.abs(d) <= toleranceAt(designR)) withinBoth++;
    }
  }

  const n = Math.max(covered, 1);
  let cutCells = 0;
  let cutVolumeMm3 = 0;
  let maxCutIntoMm = 0;
  let maxCutIntoAt: { x: number; y: number } | null = null;
  for (let j = 0; j < goal.ny; j++) {
    for (let i = 0; i < goal.nx; i++) {
      const k = j * goal.nx + i;
      // #1083 — a cell is cut into only BEYOND the run's own map tolerance (the cell half-diagonal
      // plus the cutter's facet rise at that radius), the same band the prediction oracle judges by.
      const designRk = radius + goal.z[k]!;
      // #1086 — the stamp is judged by the floor alone; the column read keeps the run's tolerance.
      const verdictTolerance = stamped === null ? toleranceAt(designRk) : cutIntoFloorMm;
      if (sampled[k] !== 1 || dOf[k]! >= -verdictTolerance) continue;
      cutCells++;
      const depth = -dOf[k]!;
      cutVolumeMm3 += depth * cellArea;
      if (depth > maxCutIntoMm) {
        maxCutIntoMm = depth;
        // The map's own coordinates: X mm along the axis, θ in degrees around it.
        maxCutIntoAt = { x: goal.x0 + i * goal.pitch, y: ((goal.y0 + j * goal.pitch) / radius) * (180 / Math.PI) };
      }
    }
  }

  // #1086 — the column read's own cut-into, with the run's tolerance exactly as the pre-stamp
  // verdict counted it: stated beside the stamp, never the verdict.
  let columnCells = 0;
  let columnMax = 0;
  let columnAt: { x: number; y: number } | null = null;
  if (colDOf !== null && colSampled !== null) {
    for (let j = 0; j < goal.ny; j++) {
      for (let i = 0; i < goal.nx; i++) {
        const k = j * goal.nx + i;
        const designRk = radius + goal.z[k]!;
        if (colSampled[k] !== 1 || colDOf[k]! >= -toleranceAt(designRk)) continue;
        columnCells++;
        const depth = -colDOf[k]!;
        if (depth > columnMax) {
          columnMax = depth;
          columnAt = { x: goal.x0 + i * goal.pitch, y: ((goal.y0 + j * goal.pitch) / radius) * (180 / Math.PI) };
        }
      }
    }
  }

  deltas.sort((a, b) => a - b);
  const medianDeltaMm = deltas.length === 0 ? 0 : deltas[Math.floor(deltas.length / 2)]!;
  const leftoverFractions = leftoverCounts.map((c) => c / n);
  const coverageFraction = withinBoth / n;
  const cutIntoFraction = cutCells / n;
  const coverage = 1 - (leftoverFractions[0] ?? 0);

  // The sentence states the frame and the plate's own caveat: a cell the relief does not cut keeps
  // the stock's surface (a block's flats are inside the envelope by design), and a map cell is
  // resolved at the field's pitch. Never the flat check's wording.
  const sectionWords =
    section === null || section.kind === 'round'
      ? ''
      : ` The stock's own ${Number(section.width.toFixed(2))} × ${Number(section.height.toFixed(2))} mm section surface sits inside the ⌀${Number((2 * radius).toFixed(3))} envelope, so a covered cell the relief never cuts reads the stock's radius and counts as standing.`;
  const sentence =
    `goal check on the rotary map: coverage ${pct(coverage)} of the goal's surface — the pass line asks ${pct(passCoverage)} ` +
    `(${pct(leftoverFractions[0] ?? 0)} stands more than ${GOAL_LEFTOVER_BANDS_MM[0]} mm above the goal)` +
    (cutCells === 0 ? '; nothing is cut into the goal' : `; ${pct(cutIntoFraction)} is cut into the goal, up to ${mm3(maxCutIntoMm)} mm`) +
    (stamped === null
      ? `. The comparison is cell by cell on the map's (X, θ) grid at ${Number(goal.pitch.toFixed(3))} mm.`
      : `. The comparison is the posted program stamped onto the map's (X, θ) grid at ${Number(goal.pitch.toFixed(3))} mm; the column grid's read is stated beside it.`) +
    sectionWords;

  return {
    ok: true,
    ran: true,
    reason: null,
    goalCells: covered,
    pitchMm: goal.pitch,
    cutIntoFloorMm,
    cutIntoFraction,
    cutIntoAreaMm2: cutCells * cellArea,
    cutIntoVolumeMm3: cutVolumeMm3,
    maxCutIntoMm,
    maxCutIntoAt,
    leftoverFractions,
    leftoverVolumeMm3,
    maxLeftoverMm: maxLeftover,
    coverageFraction,
    passCoverage,
    edgeBreakFraction: 0,
    wallNotScoredFraction: 0,
    shadowNotScoredFraction: 0,
    straddlingNotScoredCells: 0,
    straddlingMaxStepMm: 0,
    ...(colDOf === null ? {} : { columnCutInto: { fraction: columnCells / n, maxMm: columnMax, at: columnAt } }),
    adjudicatedFraction: coverageFraction,
    adjudicatedMaxMm: maxCutIntoMm,
    adjudicatedMaxAt: maxCutIntoAt,
    medianDeltaMm,
    sentence,
  };
}
