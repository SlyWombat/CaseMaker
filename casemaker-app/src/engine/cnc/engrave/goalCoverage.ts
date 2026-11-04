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
 *   1. FACING AWAY — its outward normal points DOWN: past 90° from the tool axis by more than the
 *      facing tolerance (2°). A downward face and an undercut wall are surfaces no 3-axis cut from
 *      this side can produce at ANY shape of cutter, so it is not a tolerance question. A
 *      VERTICAL face is not facing away: the raster produces it as the cliff between two cells'
 *      tops, so it belongs to the visible set (and a side setup can reach it as a cliff too).
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

import type { GoalHeightfield } from '@/engine/cnc/engrave/goalHeightfield';

/** A mesh's triangles, flat: `positions[i*3 + axis]`, three indices per triangle. */
export interface CoverageMesh {
  positions: Float32Array;
  indices: Uint32Array;
}

export interface CoverageOptions {
  /**
   * Tilt DOWN past vertical, degrees, at which a face counts as FACING AWAY. 2° is an epsilon for
   * a model's own slop around vertical, not a judgement about steepness: a vertical face is
   * reachable as the raster's cliff, a downward one is not.
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
export const COVERAGE_DEFAULTS = { facingDeg: 2, shadowMm: 0.3, reachedMm: 0.05 } as const;

/** The swept result's top at a work XY, or null where nothing of the stock remains there. */
export type ResultTop = (x: number, y: number) => number | null;

/** What one triangle is, geometrically, from the tool's side. */
export interface TriangleFacts {
  /** Its area, mm². */
  areaMm2: number;
  /** Its centroid, in the setup frame. */
  centre: [number, number, number];
  /** Unit normal's Z — 1 for a face square to the tool, negative for one pointing down. */
  nz: number;
  /** The unit normal in the setup frame — the plan compares directions to spot one flat face. */
  normal: [number, number, number];
  /** The goal's own top at the centroid's cell, or null outside the grid. */
  goalTop: number | null;
  /** The first class that applies: facing away, or shadowed; otherwise visible (tolerance aside). */
  cls: 'facingAway' | 'shadowed' | 'visible';
}

/**
 * Every triangle's area and class — the plan's per-side bookkeeping (which area a candidate side
 * ADDS) and the coverage sums both read this, so the two cannot disagree about a face.
 */
export function coverageTriangles(mesh: CoverageMesh, goal: GoalHeightfield, opts: CoverageOptions = {}): TriangleFacts[] {
  const facingDeg = opts.facingDeg ?? COVERAGE_DEFAULTS.facingDeg;
  const shadowMm = opts.shadowMm ?? COVERAGE_DEFAULTS.shadowMm;
  const facingDown = -Math.sin((facingDeg * Math.PI) / 180);
  const out: TriangleFacts[] = [];
  const triangles = mesh.indices.length / 3;
  for (let t = 0; t < triangles; t++) {
    const tri = triangleAt(mesh, t);
    const { area, nz, slope, normal } = areaAndNormalZ(tri);
    const centre: [number, number, number] = [
      (tri.ax + tri.bx + tri.cx) / 3,
      (tri.ay + tri.by + tri.cy) / 3,
      (tri.az + tri.bz + tri.cz) / 3,
    ];
    const goalTop = goalTopAt(goal, centre[0], centre[1]);
    if (!(area > 0)) {
      out.push({ areaMm2: 0, centre, nz, normal, goalTop, cls: 'facingAway' });
      continue;
    }
    if (nz < facingDown) {
      out.push({ areaMm2: area, centre, nz, normal, goalTop, cls: 'facingAway' });
      continue;
    }
    // The face's own highest point over its cell: its top vertex, plus what its own slope adds
    // across one cell. Only a surface ABOVE that is an overhang.
    const high = Math.max(tri.az, tri.bz, tri.cz) + (Number.isFinite(slope) ? slope * goal.pitch : 0);
    if (goalTop !== null && goalTop > high + shadowMm) {
      out.push({ areaMm2: area, centre, nz, normal, goalTop, cls: 'shadowed' });
      continue;
    }
    out.push({ areaMm2: area, centre, nz, normal, goalTop, cls: 'visible' });
  }
  return out;
}

/**
 * The goal's own TOP field, rasterised from triangles — the plan's shadow reference for a rotated
 * side. (`sampleGoalHeightfield` samples a TARGET's placement along +Z; a candidate side is the
 * same mesh turned by an orientation matrix, which this reads directly.)
 */
export function sampleCoverageField(mesh: CoverageMesh, pitchMm = 0.25, topZ = 0): GoalHeightfield {
  const p = mesh.positions;
  let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity, zMax = -Infinity;
  for (let i = 0; i < p.length; i += 3) {
    xMin = Math.min(xMin, p[i]!); xMax = Math.max(xMax, p[i]!);
    yMin = Math.min(yMin, p[i + 1]!); yMax = Math.max(yMax, p[i + 1]!);
    zMax = Math.max(zMax, p[i + 2]!);
  }
  const pitch = pitchMm > 0 ? pitchMm : 0.25;
  const nx = Math.max(1, Math.ceil((xMax - xMin) / pitch) + 1);
  const ny = Math.max(1, Math.ceil((yMax - yMin) / pitch) + 1);
  const z = new Float32Array(nx * ny).fill(-Infinity);
  const covered = new Uint8Array(nx * ny);
  const tris = mesh.indices.length / 3;
  for (let t = 0; t < tris; t++) {
    const tri = triangleAt(mesh, t);
    const tMinX = Math.min(tri.ax, tri.bx, tri.cx), tMaxX = Math.max(tri.ax, tri.bx, tri.cx);
    const tMinY = Math.min(tri.ay, tri.by, tri.cy), tMaxY = Math.max(tri.ay, tri.by, tri.cy);
    const i0 = Math.max(0, Math.floor((tMinX - xMin) / pitch));
    const i1 = Math.min(nx - 1, Math.ceil((tMaxX - xMin) / pitch));
    const j0 = Math.max(0, Math.floor((tMinY - yMin) / pitch));
    const j1 = Math.min(ny - 1, Math.ceil((tMaxY - yMin) / pitch));
    const den = (tri.by - tri.cy) * (tri.ax - tri.cx) + (tri.cx - tri.bx) * (tri.ay - tri.cy);
    if (den === 0) continue;
    for (let j = j0; j <= j1; j++) {
      const cy = yMin + j * pitch;
      for (let i = i0; i <= i1; i++) {
        const cx = xMin + i * pitch;
        const w1 = ((tri.by - tri.cy) * (cx - tri.cx) + (tri.cx - tri.bx) * (cy - tri.cy)) / den;
        const w2 = ((tri.cy - tri.ay) * (cx - tri.cx) + (tri.ax - tri.cx) * (cy - tri.cy)) / den;
        const w3 = 1 - w1 - w2;
        if (w1 < -1e-9 || w2 < -1e-9 || w3 < -1e-9) continue;
        const vz = w1 * tri.az + w2 * tri.bz + w3 * tri.cz;
        const k = j * nx + i;
        covered[k] = 1;
        if (!(z[k]! >= vz)) z[k] = vz;
      }
    }
  }
  let minZ = zMax;
  for (let k = 0; k < z.length; k++) if (!(z[k]! > -Infinity)) z[k] = topZ; else minZ = Math.min(minZ, z[k]!);
  return {
    nx,
    ny,
    x0: xMin,
    y0: yMin,
    pitch,
    topZ,
    minZ,
    z,
    covered,
    coveredCount: covered.reduce((a, b) => a + b, 0),
    resolutionNote: `${pitch} mm grid`,
  };
}

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

/**
 * The triangle's area, its unit normal's Z, and the slope its own plane rises across a cell
 * (`horizontal / vertical`, 0 for a face square to the tool). The slope is what the shadow test
 * needs: a steep face's own cell top stands above its highest vertex by up to the pitch times
 * that slope, and only a comparison that allows for it can tell a slope from an overhang.
 */
function areaAndNormalZ(t: Tri): { area: number; nz: number; slope: number; normal: [number, number, number] } {
  const ux = t.bx - t.ax, uy = t.by - t.ay, uz = t.bz - t.az;
  const vx = t.cx - t.ax, vy = t.cy - t.ay, vz = t.cz - t.az;
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz);
  if (len === 0) return { area: 0, nz: 0, slope: 0, normal: [0, 0, 0] };
  const nzUnit = nz / len;
  const horizontal = Math.hypot(nx, ny) / len;
  const slope = Math.abs(nzUnit) > 1e-9 ? horizontal / Math.abs(nzUnit) : Infinity;
  return { area: len / 2, nz: nzUnit, slope, normal: [nx / len, ny / len, nz / len] };
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
  const reachedMm = opts.reachedMm ?? COVERAGE_DEFAULTS.reachedMm;
  let total = 0;
  let reached = 0;
  let facingAway = 0;
  let shadowed = 0;
  let missed = 0;
  for (const f of coverageTriangles(mesh, goal, opts)) {
    if (!(f.areaMm2 > 0)) continue;
    total += f.areaMm2;
    if (f.cls === 'facingAway') {
      facingAway += f.areaMm2;
      continue;
    }
    if (f.cls === 'shadowed') {
      shadowed += f.areaMm2;
      continue;
    }
    if (resultTop === null) {
      reached += f.areaMm2;
      continue;
    }
    const result = resultTop(f.centre[0], f.centre[1]);
    if (result !== null && Math.abs(result - (f.goalTop ?? f.centre[2])) <= reachedMm) {
      reached += f.areaMm2;
    } else {
      missed += f.areaMm2;
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
