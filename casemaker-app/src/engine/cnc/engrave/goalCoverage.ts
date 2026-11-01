/**
 * #872 — HOW MUCH OF A GOAL'S SURFACE ONE SETUP REACHES, as an area the operator can be told and a
 * plan can be ranked by.
 *
 * THE QUESTION. A mesh target is cut from the top by a 3-axis raster: the CAM follows the TOP
 * SURFACE at every XY, so a face pointing down, an undercut, and anything standing in the shadow
 * of an overhang are never touched — the job looks finished and is not (#872). This module answers
 * "how much of the GOAL's surface does this setup reproduce", split into the three ways a face can
 * be out of its reach, so the sentence can say WHY rather than only a percentage.
 *
 * THREE CLASSES, in the order they are decided (a face is counted once, by the first that applies):
 *
 *   1. FACING AWAY — its outward normal is at or past 90° from the tool axis (a downward face, an
 *      undercut, a vertical wall at the tolerance). A 3-axis machine cannot reach it from this side
 *      at ANY shape of cutter, so it is not a tolerance question.
 *   2. SHADOWED — it does face the tool, but the goal's own TOP surface at its cell stands higher
 *      than the face by more than `shadowMm`: something overhangs it, and the cutter would have to
 *      come through the material to reach it.
 *   3. VISIBLE — everything else, judged by the SIMULATION: the swept result's top at the face's
 *      cell must be within `reachedMm` of the goal's top there. A visible face the result leaves
 *      above the goal (stock standing) or below it (a gouge) is MISSED — the tolerance question.
 *
 * Area is the mesh's own triangle area, so the denominator is the WHOLE goal surface — the flat
 * back of a relief is part of it, which is exactly why a relief "reaches" 50 % and moves no
 * proposal (see `goalFlipPlan`).
 *
 * PURE, PLAIN DATA. No Manifold, no session: triangles, the goal's sampled heightfield, and a
 * function for the swept top in. That is what lets a unit test drive it with a cube and a sphere,
 * the worker tier drive it with the real sweep (#873), and the proposals be ranked before any CAM
 * runs.
 */

import type { GoalHeightfield } from '@/engine/cnc/cam/surface3d';

/** A mesh's triangles, flat: `positions[i*3 + axis]`, three indices per triangle. */
export interface CoverageMesh {
  positions: Float32Array;
  indices: Uint32Array;
}

export interface CoverageOptions {
  /**
   * A face whose normal is at or below this angle to the tool axis counts as FACING AWAY, degrees.
   * 6° keeps a near-vertical wall out of the tolerance judgement: the raster follows the top
   * surface, and a wall that steep has no projected area to cut.
   */
  facingDeg?: number;
  /**
   * A facing-the-tool face with the goal's own top standing more than this above its HIGHEST
   * point is SHADOWED, mm. The comparison is against the highest vertex so an ordinary slope's
   * cell top (at its upslope edge) is not mistaken for an overhang; this tolerance then absorbs
   * the rest (a tall triangle's cell top, the raster's own rounding).
   */
  shadowMm?: number;
  /**
   * The simulated top must be within this of the goal's top to count as REACHED, mm — the oracle's
   * band floored at 0.05 (#872's decided default).
   */
  reachedMm?: number;
}

/** The three ways a goal's area is out of a setup's reach, plus the share it does reach. */
export interface GoalCoverage {
  /** The goal's whole surface area, mm² — every triangle, both faces of a thin part. */
  totalAreaMm2: number;
  reachedAreaMm2: number;
  facingAwayAreaMm2: number;
  shadowedAreaMm2: number;
  missedAreaMm2: number;
  /** `reachedAreaMm2 / totalAreaMm2`, 0 when the goal has no area. */
  fraction: number;
}

/** #872's decided defaults: the "small amount" is 1 % of the goal area (the CALLER reads it). */
export const COVERAGE_SMALL_FRACTION = 0.01;
export const COVERAGE_DEFAULTS = { facingDeg: 6, shadowMm: 0.3, reachedMm: 0.05 } as const;

/** The swept result's top at a work XY, or null where nothing of the stock remains there. */
export type ResultTop = (x: number, y: number) => number | null;

interface Tri {
  ax: number; ay: number; az: number;
  bx: number; by: number; bz: number;
  cx: number; cy: number; cz: number;
}

/**
 * Turn a mesh into the SETUP frame: `m` is a row-major 3×3 stock→machine rotation (the setups
 * engine's `orient` matrix). Normals rotate with the points, so the classifier reads the same
 * `+Z` tool axis for every side.
 */
export function rotateCoverageMesh(mesh: CoverageMesh, m: readonly number[]): CoverageMesh {
  const to = (x: number, y: number, z: number): [number, number, number] => [
    m[0]! * x + m[1]! * y + m[2]! * z,
    m[3]! * x + m[4]! * y + m[5]! * z,
    m[6]! * x + m[7]! * y + m[8]! * z,
  ];
  const positions = new Float32Array(mesh.positions.length);
  for (let i = 0; i < mesh.positions.length; i += 3) {
    const [x, y, z] = to(mesh.positions[i]!, mesh.positions[i + 1]!, mesh.positions[i + 2]!);
    positions[i] = x;
    positions[i + 1] = y;
    positions[i + 2] = z;
  }
  return { positions, indices: mesh.indices };
}

/** One triangle's vertices, in the setup frame, through the mesh's own index buffer. */
function triangleAt(mesh: CoverageMesh, t: number): Tri {
  const p = mesh.positions;
  const ia = mesh.indices[t * 3]! * 3;
  const ib = mesh.indices[t * 3 + 1]! * 3;
  const ic = mesh.indices[t * 3 + 2]! * 3;
  return {
    ax: p[ia]!, ay: p[ia + 1]!, az: p[ia + 2]!,
    bx: p[ib]!, by: p[ib + 1]!, bz: p[ib + 2]!,
    cx: p[ic]!, cy: p[ic + 1]!, cz: p[ic + 2]!,
  };
}

/** Twice the triangle's area, and its unit normal's Z — the two numbers the classifier needs. */
function areaAndNormalZ(t: Tri): { area: number; nz: number } {
  const ux = t.bx - t.ax, uy = t.by - t.ay, uz = t.bz - t.az;
  const vx = t.cx - t.ax, vy = t.cy - t.ay, vz = t.cz - t.az;
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz);
  return { area: len / 2, nz: len === 0 ? 0 : nz / len };
}

/** The goal's sampled top at a work XY, or null outside the grid / an uncovered cell. */
export function goalTopAt(goal: GoalHeightfield, x: number, y: number): number | null {
  const i = Math.round((x - goal.x0) / goal.pitch);
  const j = Math.round((y - goal.y0) / goal.pitch);
  if (i < 0 || j < 0 || i >= goal.nx || j >= goal.ny) return null;
  const k = j * goal.nx + i;
  return goal.covered[k] === 1 ? goal.z[k]! : null;
}

/**
 * Measure one setup's coverage of the goal.
 *
 * `mesh` is the goal in the SETUP's work frame — `rotateCoverageMesh` with the orientation's
 * matrix for anything but the first, top-up setup. `goal` is the sampled heightfield in the same
 * frame (`sampleGoalHeightfield` samples along +Z of whatever placement it is given). `resultTop`
 * is the sweep's own top after this setup's program, or null to score the GEOMETRY ONLY (the
 * ranking pass: visible faces then count as reached, and the result is an upper bound the
 * simulation confirms).
 */
export function goalCoverage(
  mesh: CoverageMesh,
  goal: GoalHeightfield,
  resultTop: ResultTop | null,
  opts: CoverageOptions = {},
): GoalCoverage {
  const facingDeg = opts.facingDeg ?? COVERAGE_DEFAULTS.facingDeg;
  const shadowMm = opts.shadowMm ?? COVERAGE_DEFAULTS.shadowMm;
  const reachedMm = opts.reachedMm ?? COVERAGE_DEFAULTS.reachedMm;
  const facingSin = Math.sin((facingDeg * Math.PI) / 180);

  let total = 0;
  let reached = 0;
  let facingAway = 0;
  let shadowed = 0;
  let missed = 0;

  const triangles = mesh.indices.length / 3;
  for (let t = 0; t < triangles; t++) {
    const tri = triangleAt(mesh, t);
    const { area, nz } = areaAndNormalZ(tri);
    if (!(area > 0)) continue;
    total += area;

    // 1. Facing away: the tool axis is +Z in this frame.
    if (nz <= facingSin) {
      facingAway += area;
      continue;
    }

    // 2. Shadowed: the goal's own top at the face's cell stands higher than the face's HIGHEST
    // point. Against the highest vertex rather than the centroid, a slope's own cell top (which is
    // at its upslope edge) does not read as an overhang; only something really above the face does.
    const mx = (tri.ax + tri.bx + tri.cx) / 3;
    const my = (tri.ay + tri.by + tri.cy) / 3;
    const mz = (tri.az + tri.bz + tri.cz) / 3;
    const high = Math.max(tri.az, tri.bz, tri.cz);
    const top = goalTopAt(goal, mx, my);
    if (top !== null && top > high + shadowMm) {
      shadowed += area;
      continue;
    }

    // 3. Visible: judged by the simulation when one is given, otherwise assumed reached.
    if (resultTop === null) {
      reached += area;
      continue;
    }
    const result = resultTop(mx, my);
    if (result !== null && Math.abs(result - (top ?? mz)) <= reachedMm) {
      reached += area;
    } else {
      missed += area;
    }
  }

  return {
    totalAreaMm2: total,
    reachedAreaMm2: reached,
    facingAwayAreaMm2: facingAway,
    shadowedAreaMm2: shadowed,
    missedAreaMm2: missed,
    fraction: total > 0 ? reached / total : 0,
  };
}

/** The share of the goal's area a setup does NOT reach. */
export function unreachedFraction(c: GoalCoverage): number {
  return c.totalAreaMm2 > 0 ? 1 - c.fraction : 0;
}

/** `0.5 %` — the operator's figure, one decimal and no trailing zeros. */
export function coveragePercent(fraction: number): string {
  const pct = fraction * 100;
  const text = pct >= 10 ? String(Math.round(pct)) : String(Number(pct.toFixed(1)));
  return `${text} %`;
}
