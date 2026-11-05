/**
 * cam/model/triangleBins.ts — a SPATIAL BIN for the drop-cutter's triangle query (#959/#960).
 *
 * `dropcutter.ts`'s `reachableTriangles` scans EVERY triangle of the mesh on every query (`for t
 * in 0..triangleCount`), which is the whole cost of a CL surface on a real part: a goal's mesh has
 * thousands of facets and a mask grid asks tens of thousands of times. This module answers the
 * SAME question — "which triangles' bounding boxes, expanded by the cutter's radius, contain
 * (x, y)?" — from a uniform grid over the mesh's XY bbox, so a query touches one cell and a
 * handful of triangles.
 *
 * DROP-IN: `binnedReachableTriangles` applies exactly `reachableTriangles`' predicate to exactly
 * the same candidates (a triangle whose expanded bbox contains the point is registered in a cell
 * the query scans), so the returned SET is identical — and therefore so is any height computed
 * from it. B swaps the query inside `dropCutterHeight`; nothing else changes.
 *
 * #970 — THE PRUNING BOUND. `triMaxZ` (per triangle, the max of its own 3 vertex Z's — a planar
 * facet's own maximum is always at a vertex) and `cellMaxZ` (per cell, the max over its
 * registered triangles' `triMaxZ`) let a caller skip a cell or a triangle whose highest possible
 * contact — `maxZ − heightAt(distance to it)` — cannot beat a running maximum, without reading a
 * single vertex. The PLANE coefficients (`planeA/B/C/L`, `planeOf`'s own formula) are precomputed
 * once here too, so a surviving candidate's exact facet contact never repeats the cross-product
 * and square root `dropcutter.ts` used to redo on every query — `NaN` marks a degenerate
 * (vertical) facet, exactly `planeOf`'s own `null` case. Both are geometry, not cutter-shape —
 * `heightAt`/`profile` stay `dropcutter.ts`'s own, which is why the bound here is only the raw
 * `maxZ`/distance pieces, not a finished height.
 */

import type { DropCutterMesh } from './dropcutter';

interface MeshTriangles {
  /** Per triangle, the bbox `reachableTriangles` reads (`triangleOf`'s own values). */
  minX: Float64Array;
  maxX: Float64Array;
  minY: Float64Array;
  maxY: Float64Array;
  /** #970 — the max of the triangle's own 3 vertex Z's, the exact upper bound on its contact. */
  maxZ: Float64Array;
  /** #970 — `planeOf`'s own `z = a*x + b*y + c`, `L = sqrt(1+a^2+b^2)`, precomputed once.
   * `NaN` (in `planeA`) marks a degenerate (vertical) facet — `planeOf`'s own `null` case. */
  planeA: Float64Array;
  planeB: Float64Array;
  planeC: Float64Array;
  planeL: Float64Array;
}

export interface TriangleBins {
  readonly mesh: DropCutterMesh;
  readonly triangles: MeshTriangles;
  readonly cellMm: number;
  readonly x0: number;
  readonly y0: number;
  readonly nx: number;
  readonly ny: number;
  /** CSR layout: cell c's triangles are `cellTriangles[cellStart[c] .. cellStart[c+1])`. */
  readonly cellStart: Int32Array;
  readonly cellTriangles: Int32Array;
  /** #970 — per cell, the max over its registered triangles' own `triangles.maxZ`. */
  readonly cellMaxZ: Float64Array;
  /** Scratch for query dedup (one stamp per triangle; queries bump the generation). */
  readonly stamp: Uint32Array;
  generation: number;
}

const PLANE_EPS = 1e-9;

function triangleBboxes(mesh: DropCutterMesh): MeshTriangles {
  const n = mesh.triangleCount;
  const minX = new Float64Array(n).fill(Infinity);
  const maxX = new Float64Array(n).fill(-Infinity);
  const minY = new Float64Array(n).fill(Infinity);
  const maxY = new Float64Array(n).fill(-Infinity);
  const maxZ = new Float64Array(n).fill(-Infinity);
  const planeA = new Float64Array(n);
  const planeB = new Float64Array(n);
  const planeC = new Float64Array(n);
  const planeL = new Float64Array(n);
  for (let t = 0; t < n; t++) {
    const i0 = mesh.indices[t * 3]! * 3;
    const i1 = mesh.indices[t * 3 + 1]! * 3;
    const i2 = mesh.indices[t * 3 + 2]! * 3;
    const ax = mesh.positions[i0] as number, ay = mesh.positions[i0 + 1] as number, az = mesh.positions[i0 + 2] as number;
    const bx = mesh.positions[i1] as number, by = mesh.positions[i1 + 1] as number, bz = mesh.positions[i1 + 2] as number;
    const cx = mesh.positions[i2] as number, cy = mesh.positions[i2 + 1] as number, cz = mesh.positions[i2 + 2] as number;
    minX[t] = Math.min(ax, bx, cx);
    maxX[t] = Math.max(ax, bx, cx);
    minY[t] = Math.min(ay, by, cy);
    maxY[t] = Math.max(ay, by, cy);
    maxZ[t] = Math.max(az, bz, cz);

    // #970(d) — `planeOf`'s own formula, precomputed once per triangle at bin build rather than
    // once per query: the same cross-product + sqrt, the same winding fix-up (normal flipped to
    // point up), the same vertical-facet exclusion.
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    if (Math.abs(nz) < PLANE_EPS) {
      planeA[t] = NaN; // degenerate (vertical) facet — `planeOf`'s own `null`
    } else {
      if (nz < 0) { nx = -nx; ny = -ny; nz = -nz; }
      const a = -nx / nz;
      const b = -ny / nz;
      planeA[t] = a;
      planeB[t] = b;
      planeC[t] = az - a * ax - b * ay;
      planeL[t] = Math.sqrt(1 + a * a + b * b);
    }
  }
  return { minX, maxX, minY, maxY, maxZ, planeA, planeB, planeC, planeL };
}

/**
 * Build the bins. `cellMm` defaults to twice the triangles' median XY extent (clamped to
 * [0.5, 10]): a cell holds a few triangles, so a query with the usual 1–6 mm cutter radius scans
 * a handful of cells either way.
 */
export function buildTriangleBins(mesh: DropCutterMesh, cellMm?: number): TriangleBins {
  const triangles = triangleBboxes(mesh);
  const n = mesh.triangleCount;
  let xMin = Infinity;
  let xMax = -Infinity;
  let yMin = Infinity;
  let yMax = -Infinity;
  const extents: number[] = [];
  for (let t = 0; t < n; t++) {
    xMin = Math.min(xMin, triangles.minX[t]!);
    xMax = Math.max(xMax, triangles.maxX[t]!);
    yMin = Math.min(yMin, triangles.minY[t]!);
    yMax = Math.max(yMax, triangles.maxY[t]!);
    extents.push(Math.max(triangles.maxX[t]! - triangles.minX[t]!, triangles.maxY[t]! - triangles.minY[t]!));
  }
  if (!(xMax > xMin) || !(yMax > yMin) || n === 0) {
    throw new Error('cam/model/triangleBins: the mesh has no usable XY extent');
  }
  extents.sort((a, b) => a - b);
  const median = extents[Math.floor(extents.length / 2)] ?? 1;
  const cell = Math.min(10, Math.max(0.5, cellMm ?? 2 * (median > 0 ? median : 1)));
  const nx = Math.max(1, Math.ceil((xMax - xMin) / cell));
  const ny = Math.max(1, Math.ceil((yMax - yMin) / cell));
  const cells = nx * ny;
  const counts = new Int32Array(cells + 1);
  const cellOf = (x: number, y: number): number => {
    const i = Math.min(nx - 1, Math.max(0, Math.floor((x - xMin) / cell)));
    const j = Math.min(ny - 1, Math.max(0, Math.floor((y - yMin) / cell)));
    return j * nx + i;
  };
  // Pass 1: count. Pass 2: fill (a triangle lands in every cell its bbox covers).
  const visit = (t: number, fn: (cell: number) => void): void => {
    const i0 = Math.min(nx - 1, Math.max(0, Math.floor((triangles.minX[t]! - xMin) / cell)));
    const i1 = Math.min(nx - 1, Math.max(0, Math.floor((triangles.maxX[t]! - xMin) / cell)));
    const j0 = Math.min(ny - 1, Math.max(0, Math.floor((triangles.minY[t]! - yMin) / cell)));
    const j1 = Math.min(ny - 1, Math.max(0, Math.floor((triangles.maxY[t]! - yMin) / cell)));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) fn(j * nx + i);
  };
  for (let t = 0; t < n; t++) visit(t, (c) => { counts[c + 1]! += 1; });
  for (let c = 0; c < cells; c++) counts[c + 1]! += counts[c]!;
  const cellStart = counts;
  const cellTriangles = new Int32Array(cellStart[cells]!);
  const fill = new Int32Array(cells);
  for (let t = 0; t < n; t++) visit(t, (c) => { cellTriangles[cellStart[c]! + fill[c]!] = t; fill[c]! += 1; });
  void cellOf;
  // #970 — per cell, the max over its own registered triangles' `maxZ` (the CSR range already
  // built above), the cheap bound a query prunes whole cells with before reading any triangle.
  const cellMaxZ = new Float64Array(cells).fill(-Infinity);
  for (let c = 0; c < cells; c++) {
    const end = cellStart[c + 1]!;
    let m = -Infinity;
    for (let s = cellStart[c]!; s < end; s++) {
      const z = triangles.maxZ[cellTriangles[s]!]!;
      if (z > m) m = z;
    }
    cellMaxZ[c] = m;
  }
  return {
    mesh,
    triangles,
    cellMm: cell,
    x0: xMin,
    y0: yMin,
    nx,
    ny,
    cellStart,
    cellTriangles,
    cellMaxZ,
    stamp: new Uint32Array(n),
    generation: 0,
  };
}

/**
 * The drop-in query: the triangle indices whose bbox, expanded by `radiusMm`, contains (x, y) —
 * `reachableTriangles(mesh, x, y, radiusMm)`'s own predicate, answered from the bins. The order is
 * cell order, not ascending; every caller (the drop-cutter's max over contributions) is
 * order-independent.
 */
export function binnedReachableTriangles(bins: TriangleBins, x: number, y: number, radiusMm: number): number[] {
  const { triangles, cellMm, x0, y0, nx, ny } = bins;
  const i0 = Math.min(nx - 1, Math.max(0, Math.floor((x - radiusMm - x0) / cellMm)));
  const i1 = Math.min(nx - 1, Math.max(0, Math.floor((x + radiusMm - x0) / cellMm)));
  const j0 = Math.min(ny - 1, Math.max(0, Math.floor((y - radiusMm - y0) / cellMm)));
  const j1 = Math.min(ny - 1, Math.max(0, Math.floor((y + radiusMm - y0) / cellMm)));
  const generation = ++bins.generation;
  const out: number[] = [];
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const c = j * nx + i;
      const end = bins.cellStart[c + 1]!;
      for (let s = bins.cellStart[c]!; s < end; s++) {
        const t = bins.cellTriangles[s]!;
        if (bins.stamp[t] === generation) continue;
        bins.stamp[t] = generation;
        if (x < triangles.minX[t]! - radiusMm || x > triangles.maxX[t]! + radiusMm) continue;
        if (y < triangles.minY[t]! - radiusMm || y > triangles.maxY[t]! + radiusMm) continue;
        out.push(t);
      }
    }
  }
  return out;
}
