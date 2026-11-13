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
  ADJUDICATED_FLOOR_MM,
  GOAL_CUT_INTO_FLOOR_MM,
  GOAL_EDGE_STEP_MM,
  GOAL_PASS_COVERAGE_FALLBACK,
  STRADDLING_SLACK_MM,
  wallDistanceField,
  type GoalCutIntoOptions,
  type GoalCutIntoReport,
} from '@/engine/cnc/engrave/designCheck';
import { readDefault } from '@/platform/defaultsClient';

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

/**
 * #1086 — THE DESIGN EDGES OF THE MAP, and the exact distance to them. A radial field is a
 * heightfield too, so it has the flat check's blind class: a cell on a step (the panther's head and
 * trunk walls) whose design radius is the wall's TOP, beside a pass cut at the wall's base. The
 * stamp reads the pass's ball surface there and calls it cut-into, while the tool never reached the
 * top — the class the flat check excuses as WALL CELLS (#955) and, within the cutter's shadow, on
 * the v5 CL proof (#970). The map's rows wrap (the seam is not an edge); its X ends do not, and are
 * the mesh's own silhouette faces (the flat check's border, #964).
 */
interface RotaryDesignEdges {
  wall: Uint8Array;
  border: Uint8Array;
  /** Distance (map mm) from every cell centre to the nearest wall cell centre, rows periodic. */
  wallDist: Float32Array;
}

/** The field object is cached per goal (`rotaryGoalFieldFor`), so the masks are computed once. */
const rotaryEdgesCache = new WeakMap<GoalRadialField, RotaryDesignEdges>();

function rotaryDesignEdges(goal: GoalRadialField): RotaryDesignEdges {
  const cached = rotaryEdgesCache.get(goal);
  if (cached !== undefined) return cached;
  const { nx, ny, covered, z, pitch } = goal;
  const wall = new Uint8Array(nx * ny);
  const border = new Uint8Array(nx * ny);
  // An uncovered cell keeps the STOCK's own surface at the envelope (z = 0): the relief beside it
  // is the part's silhouette, a design edge exactly as the flat field's rim (#955).
  const at = (k: number): number => (covered[k] === 1 ? z[k]! : 0);
  const mark = (a: number, b: number): void => {
    if (Math.abs(at(a) - at(b)) > GOAL_EDGE_STEP_MM) {
      wall[a] = 1;
      wall[b] = 1;
    }
  };
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      if (i + 1 < nx) mark(k, k + 1);
      if (ny > 1) mark(k, ((j + 1) % ny) * nx + i);
    }
  }
  // The mesh's X ends are the map's own border: the stock continues unsampled beyond them, so the
  // boundary column is unadjudicable as the flat field's border is (#964).
  for (let j = 0; j < ny; j++) {
    const left = j * nx;
    if (covered[left] === 1) border[left] = 1;
    if (covered[left + nx - 1] === 1) border[left + nx - 1] = 1;
  }
  // The rows are periodic, so the distance transform runs on three tiled copies and reads the
  // middle one: any wall image within a turn is present, and the shadow radius is far smaller.
  const tiled = new Uint8Array(nx * ny * 3);
  for (let t = 0; t < 3; t++) tiled.set(wall, t * nx * ny);
  const tiledDist = wallDistanceField(tiled, nx, ny * 3, pitch);
  const wallDist = new Float32Array(nx * ny);
  wallDist.set(tiledDist.subarray(nx * ny, 2 * nx * ny));
  const edges = { wall, border, wallDist };
  rotaryEdgesCache.set(goal, edges);
  return edges;
}

/** Mark every cell within `radiusMm` of a wall cell, the row axis wrapping at the seam. */
function dilateMap(mask: Uint8Array, nx: number, ny: number, pitch: number, radiusMm: number): Uint8Array {
  const out = new Uint8Array(nx * ny);
  const r = Math.ceil(radiusMm / pitch);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      if (mask[j * nx + i] !== 1) continue;
      for (let dj = -r; dj <= r; dj++) {
        const jj = ((j + dj) % ny + ny) % ny;
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
  // #1207 — the shop's bands ride the check when the caller states them (the same option the flat
  // check reads); the registry recommendation is only the no-shop default.
  const leftoverBandsMm = opts.leftoverBandsMm ?? [
    readDefault(null, 'acceptance.leftoverBand1Mm').value,
    readDefault(null, 'acceptance.leftoverBand2Mm').value,
    readDefault(null, 'acceptance.leftoverBand3Mm').value,
  ];
  const leftoverCounts = leftoverBandsMm.map(() => 0);
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
      for (let b = 0; b < leftoverBandsMm.length; b++) {
        if (d > leftoverBandsMm[b]!) leftoverCounts[b]! += 1;
      }
      if (d > leftoverBandsMm[0]!) {
        leftoverVolumeMm3 += d * cellArea;
        maxLeftover = Math.max(maxLeftover, d);
      }
      if (Math.abs(d) <= toleranceAt(designR)) withinBoth++;
    }
  }

  const n = Math.max(covered, 1);
  // #1086 — THE MAP FRAME'S UNADJUDICABLE CELLS. The exact stamp is a heightfield read: on a cliff
  // (the panther's head and trunk edges) the cell carries the wall's TOP radius while the stamp
  // holds the neighbouring pass's ball surface, which reads as cut-into though the tool never
  // reached the top. The flat check has three proofs for this class; the map gets the same three,
  // in its own frame: WALL/BORDER cells (#955/#964), the WALL SHADOW on the v5 CL proof (#970),
  // and the #996 straddling proof. The column read keeps its own raw count below, so the two
  // models stay comparable.
  const edges = rotaryDesignEdges(goal);
  const shadowRadius = opts.wallShadowRadiusMm;
  const shadow =
    shadowRadius !== undefined && shadowRadius > 0
      ? dilateMap(edges.wall, goal.nx, goal.ny, goal.pitch, shadowRadius)
      : null;
  const excluded = new Uint8Array(goal.nx * goal.ny);
  const mapAt = (i: number, j: number): { x: number; y: number } => ({
    x: goal.x0 + i * goal.pitch,
    // The map's own coordinates: X mm along the axis, θ in degrees around it.
    y: ((goal.y0 + j * goal.pitch) / radius) * (180 / Math.PI),
  });
  let cutCells = 0;
  let cutVolumeMm3 = 0;
  let maxCutIntoMm = 0;
  let maxCutIntoAt: { x: number; y: number } | null = null;
  let adjudicatedCells = 0;
  let adjudicatedMaxMm = 0;
  let adjudicatedMaxAt: { x: number; y: number } | null = null;
  let wallNotScoredCells = 0;
  let shadowNotScoredCells = 0;
  let straddlingNotScoredCells = 0;
  let straddlingMaxStepMm = 0;
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
        maxCutIntoAt = mapAt(i, j);
      }
      // #955/#964 — A CELL ON A DESIGN STEP IS THE HEIGHTFIELD'S OWN BLIND CLASS: excluded from
      // the adjudicated set, counted and printed, never silently a pass.
      if (edges.wall[k] === 1 || edges.border[k] === 1) {
        excluded[k] = 1;
        wallNotScoredCells++;
        continue;
      }
      // v5 (#970) — within the cutter's shadow of a wall: excused only when the deepest stamp's CL
      // stayed at least the shadow radius from the wall (the disc-stamp artefact). Without a CL the
      // cell stays adjudicated, the conservative side.
      if (shadow !== null && shadow[k] === 1) {
        let excusedByCl = false;
        if (opts.clAt !== undefined) {
          const cl = opts.clAt(mapAt(i, j).x, goal.y0 + j * goal.pitch);
          if (cl !== null) {
            const ci = Math.round((cl.x - goal.x0) / goal.pitch);
            const cjRaw = Math.round((cl.y - goal.y0) / goal.pitch);
            const cj = ((cjRaw % goal.ny) + goal.ny) % goal.ny;
            if (ci >= 0 && ci < goal.nx) {
              excusedByCl = edges.wallDist[cj * goal.nx + ci]! >= shadowRadius! - goal.pitch - 1e-9;
            }
          }
        }
        if (excusedByCl) {
          excluded[k] = 1;
          shadowNotScoredCells++;
          continue;
        }
      }
      // #996 (gate v6) — THE STRADDLING-CELL EXCUSE, ON PROOF, in the map frame: the design step
      // over the cell is at least the measured intrusion AND the swept radius is at or above the
      // design's low side, so nothing was cut that the design keeps. Rows wrap; uncovered
      // neighbours contribute nothing (the design exists only where it is covered).
      if (depth > ADJUDICATED_FLOOR_MM) {
        const zc = goal.z[k]!;
        if (Number.isFinite(zc)) {
          let hi = zc;
          let lo = zc;
          for (const [di, dj] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
            const ci = i + di;
            if (ci < 0 || ci >= goal.nx) continue;
            const cj = ((j + dj) % goal.ny + goal.ny) % goal.ny;
            const kk = cj * goal.nx + ci;
            if (sampled[kk] !== 1) continue;
            const zz = goal.z[kk]!;
            if (!Number.isFinite(zz)) continue;
            if (zz > hi) hi = zz;
            if (zz < lo) lo = zz;
          }
          const step = hi - lo;
          const swept = designRk + dOf[k]!;
          if (step > 0 && step + 1e-12 >= depth && swept >= radius + lo - STRADDLING_SLACK_MM) {
            excluded[k] = 1;
            straddlingNotScoredCells++;
            if (step > straddlingMaxStepMm) straddlingMaxStepMm = step;
            continue;
          }
        }
      }
      // THE ADJUDICATED SET — the gate's reading after the unadjudicable cells above.
      adjudicatedCells++;
      if (depth > adjudicatedMaxMm) {
        adjudicatedMaxMm = depth;
        adjudicatedMaxAt = mapAt(i, j);
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
  // #1095 — THE VERDICT IS THE FLAT CHECK'S OWN. Zero adjudicated cut-into at the floor AND the
  // goal's top surface at or above the pass line. #1083 returned `ok: true` unconditionally while
  // the sentence stated a failure; a rotary part now fails exactly when a flat one would.
  const coverageOk = coverage + 1e-9 >= passCoverage;
  const ok = adjudicatedCells === 0 && coverageOk;

  // The sentence states the frame and the plate's own caveat: a cell the relief does not cut keeps
  // the stock's surface (a block's flats are inside the envelope by design), and a map cell is
  // resolved at the field's pitch. Never the flat check's wording.
  const sectionWords =
    section === null || section.kind === 'round'
      ? ''
      : ` The stock's own ${Number(section.width.toFixed(2))} × ${Number(section.height.toFixed(2))} mm section surface sits inside the ⌀${Number((2 * radius).toFixed(3))} envelope, so a covered cell the relief never cuts reads the stock's radius and counts as standing.`;
  // The exclusion clause names only the classes that actually occurred, so a report with one wall
  // cannot read as if the shadow and straddling proofs had also been applied.
  const exclusionWords: string[] = [];
  if (wallNotScoredCells > 0) exclusionWords.push(`${wallNotScoredCells} wall/border`);
  if (shadowNotScoredCells > 0) exclusionWords.push(`${shadowNotScoredCells} wall-shadow`);
  if (straddlingNotScoredCells > 0) {
    exclusionWords.push(
      `${straddlingNotScoredCells} straddling on a ${Number(straddlingMaxStepMm.toFixed(3))} mm step`,
    );
  }
  const sentence =
    `goal check on the rotary map: coverage ${pct(coverage)} of the goal's surface — the pass line asks ${pct(passCoverage)} ` +
    `(${pct(leftoverFractions[0] ?? 0)} stands more than ${leftoverBandsMm[0]} mm above the goal)` +
    (cutCells === 0 ? '; nothing is cut into the goal' : `; ${pct(cutIntoFraction)} is cut into the goal, up to ${mm3(maxCutIntoMm)} mm`) +
    (exclusionWords.length === 0
      ? ''
      : ` (after the cells the map heightfield cannot adjudicate — ${exclusionWords.join(', ')} — ` +
        `${pct(adjudicatedCells / n)} is cut into by up to ${mm3(adjudicatedMaxMm)} mm)`) +
    (stamped === null
      ? `. The comparison is cell by cell on the map's (X, θ) grid at ${Number(goal.pitch.toFixed(3))} mm.`
      : `. The comparison is the posted program stamped onto the map's (X, θ) grid at ${Number(goal.pitch.toFixed(3))} mm; the column grid's read is stated beside it.`) +
    sectionWords;

  return {
    ok,
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
    wallNotScoredFraction: wallNotScoredCells / n,
    shadowNotScoredFraction: shadowNotScoredCells / n,
    straddlingNotScoredCells,
    straddlingMaxStepMm,
    ...(colDOf === null ? {} : { columnCutInto: { fraction: columnCells / n, maxMm: columnMax, at: columnAt } }),
    adjudicatedFraction: adjudicatedCells / n,
    adjudicatedMaxMm,
    adjudicatedMaxAt,
    // #1092 (gate v8) — THE OVER-RELIEF COUNTERS ARE THE FLAT CHECK'S. The rotary map's class
    // exclusions are its own #1094 proofs — wall/border by class (`wallNotScoredFraction`), the
    // wall shadow on the v5 CL proof (`shadowNotScoredFraction`), the #996 straddling step — and
    // those cells are counted and printed in the fields above. v8's counted-instead counters are
    // not reproduced here, so they state zero rather than a number this check did not measure.
    wallOverReliefCells: 0,
    shadowOverReliefCells: 0,
    borderOverReliefCells: 0,
    overReliefDeepest: null,
    // #1092 (gate v8) — the rotary map has no stock-top silhouette class of its own (its rim cells
    // are the wall/border class above), so no rim cell is counted for an unavailable silhouette
    // proof.
    silhouetteExcusedCells: 0,
    silhouetteDeepest: null,
    silhouetteUnavailableCells: 0,
    // #1092 (0f's inward-witness ruling) — the witness sub-count is the flat check's silhouette
    // proof; the rotary map's silhouette class is the wall/border class above, so it states zero.
    silhouetteByWitnessCells: 0,
    medianDeltaMm,
    sentence,
  };
}
