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
 */

import type { DropCutterMesh } from './dropcutter';

interface MeshTriangles {
  /** Per triangle, the bbox `reachableTriangles` reads (`triangleOf`'s own values). */
  minX: Float64Array;
  maxX: Float64Array;
  minY: Float64Array;
  maxY: Float64Array;
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
  /** Scratch for query dedup (one stamp per triangle; queries bump the generation). */
  readonly stamp: Uint32Array;
  generation: number;
}

function triangleBboxes(mesh: DropCutterMesh): MeshTriangles {
  const n = mesh.triangleCount;
  const minX = new Float64Array(n).fill(Infinity);
  const maxX = new Float64Array(n).fill(-Infinity);
  const minY = new Float64Array(n).fill(Infinity);
  const maxY = new Float64Array(n).fill(-Infinity);
  for (let t = 0; t < n; t++) {
    for (let v = 0; v < 3; v++) {
      const vi = mesh.indices[t * 3 + v]! * 3;
      const x = mesh.positions[vi] as number;
      const y = mesh.positions[vi + 1] as number;
      if (x < minX[t]!) minX[t] = x;
      if (x > maxX[t]!) maxX[t] = x;
      if (y < minY[t]!) minY[t] = y;
      if (y > maxY[t]!) maxY[t] = y;
    }
  }
  return { minX, maxX, minY, maxY };
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
