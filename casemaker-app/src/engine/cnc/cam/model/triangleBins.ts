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
    //
    // #1020 (C's review, the gouge finding) — `planeA`'s own NaN stays the EXACT-degenerate test
    // only: this classification is SHARED with `dropcutter.ts`'s own facet-contact query, which
    // needs every near-vertical (but not exactly vertical) facet's real contact — a flat's rim
    // touching an 87-89.9° drafted wall in its interior, away from any edge, is exactly this case.
    // Folding a near-vertical skip in HERE fed a false-negative into every op's CL, not just the
    // pocket's own per-cell ceiling bound — a possible gouge, worse than the bound's own 0.2 mm
    // lip. The scale-free "how close to vertical" question (`isNearVertical`, below) is answered
    // only where the POCKET's bound reads it (`ops/pocket.ts`'s own cellBound loop).
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
  // #1054 — EACH CELL'S SLICE SORTED BY `maxZ`, DESCENDING. The CL answer is
  // `max(maxZ − heightAt(ρ))` and `heightAt(ρ) ≥ 0` for every profile, so once a running best
  // reaches an entry's `maxZ`, neither it nor any later entry of this sorted cell can beat it —
  // the drop-cutter's sweep stops on one comparison instead of testing the whole stack (the
  // elephant's ⌀6 queries read 17,153 slots for 5,065 unique triangles). The answer is a
  // maximum, so the order cannot change it: byte-identical plans.
  {
    const sortScratch: number[] = [];
    for (let c = 0; c < cells; c++) {
      const start = cellStart[c]!;
      const end = cellStart[c + 1]!;
      if (end - start < 2) continue;
      sortScratch.length = 0;
      for (let s = start; s < end; s++) sortScratch.push(cellTriangles[s]!);
      sortScratch.sort((a, b) => triangles.maxZ[b]! - triangles.maxZ[a]!);
      cellTriangles.set(sortScratch, start);
    }
  }
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
export function binnedReachableTriangles(bins: TriangleBins, x: number, y: number, radiusMm: number): number[] {  const { triangles, cellMm, x0, y0, nx, ny } = bins;
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

const binsByMesh = new WeakMap<DropCutterMesh, TriangleBins>();

/** The bins for a mesh, built once and cached — the ceiling gate and the pocket mask's bound
 * share them, so a plan builds each mesh's bins once, not once per query. */
export function triangleBinsFor(mesh: DropCutterMesh): TriangleBins {
  let bins = binsByMesh.get(mesh);
  if (bins === undefined) {
    bins = buildTriangleBins(mesh);
    binsByMesh.set(mesh, bins);
  }
  return bins;
}

/**
 * #1003 (6b's rule, round 3) — THE TRIANGLE CLIPPED TO AN XY SQUARE, and the exact height of its
 * plane over that clipped polygon.
 *
 * `triangles.maxZ` is the triangle's HIGHEST VERTEX, which for a big facet spanning many bin
 * cells is the height at the facet's shallow END, not anywhere near a given cell: one long
 * sloped-pocket-floor triangle therefore closed every cell its bbox overlapped up to its shallow
 * end, and the deep half of the slope was never cut (the #1003 sloped seeds, 93.9 %). The
 * triangle's own surface is a PLANE (`planeA/B/C`, precomputed above); the maximum of a linear
 * function over a convex polygon is at one of the polygon's vertices, so clipping the triangle to
 * the cell's own square (Sutherland–Hodgman against the four half-planes) and evaluating the
 * plane at the clipped polygon's vertices is EXACT — no bin-cell inflation, no rise missed between
 * samples.
 *
 * `clippedTriangleToSquare` returns the polygon as a flat `[x, y, …]` ring (or null when the
 * triangle does not touch the square), in the triangle's own winding. The caller uses it both for
 * the height bound and to ask whether the part of the triangle over the cell really lies inside
 * the node's region (`ops/pocket.ts`): a huge mouth-level land triangle can clip a sliver into a
 * rim cell while lying wholly OUTSIDE the pocket, and must not close it.
 */
const SQUARE_EPS = 1e-9;

type XY = { x: number; y: number };

function clipPoly(poly: XY[], inside: (p: XY) => boolean, cut: (a: XY, b: XY) => XY): XY[] {
  const out: XY[] = [];
  for (let i = 0; i < poly.length; i++) {
    const cur = poly[i]!;
    const prev = poly[(i + poly.length - 1) % poly.length]!;
    const curIn = inside(cur);
    const prevIn = inside(prev);
    if (curIn) {
      if (!prevIn) out.push(cut(prev, cur));
      out.push(cur);
    } else if (prevIn) {
      out.push(cut(prev, cur));
    }
  }
  return out;
}

/**
 * #1020 — true when facet `t`'s own normal is within `maxCosine` of vertical (default 0.05,
 * ~3° from vertical) — including the exactly-vertical case (`planeA` `NaN`). NOT the same
 * question `planeA`'s own classification answers: THAT one is shared with `dropcutter.ts`'s own
 * facet-contact query, which needs a near-vertical facet's real contact (a flat's rim touching a
 * steep drafted wall in its interior), so folding this test in there fed a false-negative into
 * every op's CL — a possible gouge. This is for a caller that specifically wants "no real
 * ceiling here" for a near-vertical facet, as the pocket's own per-cell bound does
 * (`ops/pocket.ts`'s `cellBound` loop) — never applied to the shared plane itself.
 *
 * `|nz| / |n|` is the angle's cosine; rather than re-deriving `nx`/`ny`/`nz` from the mesh, the
 * ALREADY-STORED `planeL = sqrt(1 + a² + b²)` (`a = -nx/nz`, `b = -ny/nz`, `nz` flipped positive)
 * gives it directly: `a² + b² + 1 = (nx² + ny²)/nz² + 1 = |n|²/nz²`, so `planeL = |n| / |nz|` and
 * `|nz| / |n| = 1 / planeL` — no new per-triangle field, no extra trig.
 */
export function isNearVertical(bins: TriangleBins, t: number, maxCosine = 0.05): boolean {
  const l = bins.triangles.planeL[t]!;
  // `planeL` is only ever set in the non-degenerate branch (`>= 1` there, `sqrt(1+a²+b²)`); the
  // degenerate (`planeA` NaN) branch never sets it, so it stays the array's own default, 0 — and
  // an exactly-vertical facet is trivially "near vertical" too.
  return l === 0 || 1 / l < maxCosine;
}

/** The triangle clipped to the axis-aligned square, as a flat `[x, y, …]` ring; null when empty. */
export function clippedTriangleToSquare(
  bins: TriangleBins,
  t: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): Float64Array | null {
  const tri = bins.triangles;
  if (tri.maxX[t]! < x0 - SQUARE_EPS || tri.minX[t]! > x1 + SQUARE_EPS || tri.maxY[t]! < y0 - SQUARE_EPS || tri.minY[t]! > y1 + SQUARE_EPS) {
    return null;
  }
  const pos = bins.mesh.positions;
  const idx = bins.mesh.indices;
  const i0 = idx[t * 3]! * 3;
  const i1 = idx[t * 3 + 1]! * 3;
  const i2 = idx[t * 3 + 2]! * 3;
  let poly: XY[] = [
    { x: pos[i0]!, y: pos[i0 + 1]! },
    { x: pos[i1]!, y: pos[i1 + 1]! },
    { x: pos[i2]!, y: pos[i2 + 1]! },
  ];
  const cutX = (xc: number) => (a: XY, b: XY): XY => {
    const s = (xc - a.x) / (b.x - a.x);
    return { x: xc, y: a.y + s * (b.y - a.y) };
  };
  const cutY = (yc: number) => (a: XY, b: XY): XY => {
    const s = (yc - a.y) / (b.y - a.y);
    return { x: a.x + s * (b.x - a.x), y: yc };
  };
  poly = clipPoly(poly, (p) => p.x >= x0 - SQUARE_EPS, cutX(x0));
  if (poly.length === 0) return null;
  poly = clipPoly(poly, (p) => p.x <= x1 + SQUARE_EPS, cutX(x1));
  if (poly.length === 0) return null;
  poly = clipPoly(poly, (p) => p.y >= y0 - SQUARE_EPS, cutY(y0));
  if (poly.length === 0) return null;
  poly = clipPoly(poly, (p) => p.y <= y1 + SQUARE_EPS, cutY(y1));
  if (poly.length === 0) return null;
  // #1020 — A TOUCH IS NOT AN OVERLAP. A facet that only grazes the square's own edge or corner
  // (never crosses into its interior) clips to a degenerate ring — a point or a zero-width sliver
  // along the boundary — with `poly.length > 0` but no real area; the organizer's own facets
  // 40284/40320 (a shelf) touch the cell [26.25, 26.50]×[89.50, 89.75] at exactly x = 26.500 this
  // way. Treated as "no overlap" (the shoelace area is the exact test, not a vertex count), the
  // SAME null a facet that misses the square entirely already returns.
  let area2 = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i]!;
    const q = poly[(i + 1) % poly.length]!;
    area2 += p.x * q.y - q.x * p.y;
  }
  if (Math.abs(area2) <= SQUARE_EPS) return null;
  const flat = new Float64Array(poly.length * 2);
  for (let i = 0; i < poly.length; i++) {
    flat[2 * i] = poly[i]!.x;
    flat[2 * i + 1] = poly[i]!.y;
  }
  return flat;
}

/**
 * The exact maximum of the triangle's plane over a clipped polygon from `clippedTriangleToSquare`.
 * A vertical facet (`planeA` NaN — `planeOf`'s own `null`) states no surface above a column and
 * reads `-Infinity`, the identity of the caller's max reduction, as does an empty polygon.
 */
export function planeMaxOverPolygon(bins: TriangleBins, t: number, poly: Float64Array | null): number {
  if (poly === null) return Number.NEGATIVE_INFINITY;
  const tri = bins.triangles;
  const a = tri.planeA[t]!;
  if (Number.isNaN(a)) return Number.NEGATIVE_INFINITY;
  const b = tri.planeB[t]!;
  const c = tri.planeC[t]!;
  let m = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < poly.length; i += 2) {
    const z = a * poly[i]! + b * poly[i + 1]! + c;
    if (z > m) m = z;
  }
  return m;
}

/** Scratch for `clipEdgeToSquare` — reused so the mask's inner loop allocates nothing. */
const edgeRange = { t0: 0, t1: 1 };

/**
 * Liang–Barsky: the parameter range of the segment `(ax, ay) + t·(dx, dy)` inside the square,
 * written into `edgeRange`; false when the segment misses the square entirely.
 */
function clipEdgeToSquare(ax: number, ay: number, dx: number, dy: number, x0: number, y0: number, x1: number, y1: number): boolean {
  let t0 = 0;
  let t1 = 1;
  for (let k = 0; k < 4; k++) {
    let p: number;
    let q: number;
    if (k === 0) {
      p = -dx;
      q = ax - x0;
    } else if (k === 1) {
      p = dx;
      q = x1 - ax;
    } else if (k === 2) {
      p = -dy;
      q = ay - y0;
    } else {
      p = dy;
      q = y1 - ay;
    }
    if (p === 0) {
      if (q < 0) return false;
      continue;
    }
    const r = q / p;
    if (p < 0) {
      if (r > t1) return false;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return false;
      if (r < t1) t1 = r;
    }
  }
  edgeRange.t0 = t0;
  edgeRange.t1 = t1;
  return true;
}

/**
 * The exact maximum of the triangle's plane over an axis-aligned XY square — the SAME value
 * `planeMaxOverPolygon` reads off `clippedTriangleToSquare`, computed without building the
 * polygon. The square's intersection with the triangle is convex, so the plane's maximum is at
 * one of its vertices: triangle vertices inside the square (the clipped endpoints of each edge),
 * square corners inside the triangle, and the triangle-edge × square-edge crossings the endpoint
 * clip already yields. Used on the mask's interior cells, where the per-cell region test has
 * already been answered by the corner grid; boundary cells use the polygon form, which the
 * region test also needs.
 */
export function planeMaxOverSquare(bins: TriangleBins, t: number, x0: number, y0: number, x1: number, y1: number): number {
  const tri = bins.triangles;
  const a = tri.planeA[t]!;
  if (Number.isNaN(a)) return Number.NEGATIVE_INFINITY;
  if (tri.maxX[t]! < x0 - SQUARE_EPS || tri.minX[t]! > x1 + SQUARE_EPS || tri.maxY[t]! < y0 - SQUARE_EPS || tri.minY[t]! > y1 + SQUARE_EPS) {
    return Number.NEGATIVE_INFINITY;
  }
  const b = tri.planeB[t]!;
  const c = tri.planeC[t]!;
  const pos = bins.mesh.positions;
  const idx = bins.mesh.indices;
  const i0 = idx[t * 3]! * 3;
  const i1 = idx[t * 3 + 1]! * 3;
  const i2 = idx[t * 3 + 2]! * 3;
  const ax0 = pos[i0]!, ay0 = pos[i0 + 1]!;
  const ax1 = pos[i1]!, ay1 = pos[i1 + 1]!;
  const ax2 = pos[i2]!, ay2 = pos[i2 + 1]!;
  let m = Number.NEGATIVE_INFINITY;
  // The three edges, without per-call arrays or closures: this is the mask's inner loop (one
  // call per cell × candidate triangle, the organizer's largest node being 73k cells).
  for (let e = 0; e < 3; e++) {
    const ax = e === 0 ? ax0 : e === 1 ? ax1 : ax2;
    const ay = e === 0 ? ay0 : e === 1 ? ay1 : ay2;
    const bx = e === 0 ? ax1 : e === 1 ? ax2 : ax0;
    const by = e === 0 ? ay1 : e === 1 ? ay2 : ay0;
    const dx = bx - ax;
    const dy = by - ay;
    if (!clipEdgeToSquare(ax, ay, dx, dy, x0, y0, x1, y1)) continue;
    const t0 = edgeRange.t0;
    const t1 = edgeRange.t1;
    const z0 = a * (ax + t0 * dx) + b * (ay + t0 * dy) + c;
    const z1 = a * (ax + t1 * dx) + b * (ay + t1 * dy) + c;
    if (z0 > m) m = z0;
    if (z1 > m) m = z1;
  }
  // The square's own corners inside the triangle (the square-in-triangle case).
  for (let k = 0; k < 4; k++) {
    const cx = k < 2 ? x0 : x1;
    const cy = k === 0 || k === 3 ? y0 : y1;
    const d1 = (ax1 - ax0) * (cy - ay0) - (ay1 - ay0) * (cx - ax0);
    const d2 = (ax2 - ax1) * (cy - ay1) - (ay2 - ay1) * (cx - ax1);
    const d3 = (ax0 - ax2) * (cy - ay2) - (ay0 - ay2) * (cx - ax2);
    const hasNeg = d1 < -SQUARE_EPS || d2 < -SQUARE_EPS || d3 < -SQUARE_EPS;
    const hasPos = d1 > SQUARE_EPS || d2 > SQUARE_EPS || d3 > SQUARE_EPS;
    if (hasNeg && hasPos) continue;
    const z = a * cx + b * cy + c;
    if (z > m) m = z;
  }
  return m;
}

/**
 * #970 — THE MASK CELL'S OWN BOUND: the max `cellMaxZ` over every bin cell the XY square
 * overlaps. A triangle is registered in every bin cell its bbox covers, so this is an upper bound
 * on ANY registered triangle's height within the square — outward by at most one bin cell, which
 * is the price of never missing a rise between point samples (`ops/pocket.ts`'s per-level ceiling
 * mask: a cell's five samples look at [i·pitch − ½, i·pitch + ½] while the square
 * `maskLoopsFromPredicate` opens is [i·pitch, (i+1)·pitch]).
 *
 * #1003 — NO LONGER USED BY THE POCKET MASK (the five-sample gate and its half-pitch inflation are
 * gone; `clippedTriangleToSquare` + `planeMaxOverPolygon` are the mask's exact per-cell bound).
 * Kept because it is `triangleBins`' own stated per-cell query and other callers may want the
 * coarse bound.
 */
export function maxTriangleZOverSquare(bins: TriangleBins, x0: number, y0: number, x1: number, y1: number): number {
  const { cellMm, x0: bx0, y0: by0, nx, ny, cellMaxZ } = bins;
  const i0 = Math.min(nx - 1, Math.max(0, Math.floor((x0 - bx0) / cellMm)));
  const i1 = Math.min(nx - 1, Math.max(0, Math.floor((x1 - bx0) / cellMm)));
  const j0 = Math.min(ny - 1, Math.max(0, Math.floor((y0 - by0) / cellMm)));
  const j1 = Math.min(ny - 1, Math.max(0, Math.floor((y1 - by0) / cellMm)));
  let m = -Infinity;
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const z = cellMaxZ[j * nx + i]!;
      if (z > m) m = z;
    }
  }
  return m;
}
