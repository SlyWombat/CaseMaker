/**
 * cam/model/dropcutter.ts — the drop-cutter primitive #957/#956 §2 build on: the exact CL height a
 * flat, ball, bull or V cutter reaches at one (x, y) against a triangle mesh.
 *
 * Re-implemented from OpenCamLib's published description (`BatchDropCutter`/`PathDropCutter`,
 * LGPL-2.1, algorithm reference only — no OCL source read or copied): the cutter's own drop routine
 * evaluated against the triangles within its reach, per cutter-geometry contact rule. The four
 * cutter shapes are unified under one profile function (`CutterProfile.heightAt`, below): the
 * cutter's own bottom surface height above its tip, as a function of horizontal distance from the
 * tool axis. Flat, ball, bull and V/chamfer all have a known closed form for this; §9 of the design
 * note names a cone's as OpenCamLib's description, a ball/bull's as the standard sphere-offset
 * result (the same `R(secθ − 1)` rise this engine's own held findings already use).
 *
 * The drop height at (x, y) is the Z that puts the cutter's tip as low as possible while every
 * triangle point within reach stays at or below the cutter's surface:
 *
 *     z_tip(x, y) = max over every reachable mesh point p of [ p.z − heightAt(ρ) ]
 *
 * where ρ is p's horizontal distance from (x, y). For a FLAT cutter (heightAt ≡ 0 within radius)
 * this is just "the highest point within the footprint"; for a ball it reduces to the known
 * `R(secθ − 1)` rise on a plane; the same one formula covers all four shapes.
 *
 * PER-TRIANGLE EVALUATION is the EXACT closed-form contact, for all four shapes, not dense
 * sampling (advisor's review on #960's row-dropper slice, which first surfaced this, and again on
 * this slice: one earlier version of this fix covered only flat/ball, leaving bull/cone on the old
 * grid). The dense barycentric sampling the parity fixtures were first checked against is a FINITE
 * grid (48 divisions), and on a large facet most queries have no sampled point within the cutter's
 * own reach at all — the true max is then missed, ALWAYS on the low side (every miss under-reports
 * the surface, never over), by as much as the grid's own spacing allows. Confirmed directly: a
 * ball dropped on a single 70x40 mm sloped triangle read 0.02-0.1 mm low; F's own re-check against
 * the real references (not the old ±1 mm comparator a5cc4597 was measured against — THAT claim is
 * withdrawn) found 20 of 21 comparisons failing at the fixtures' real 0.001 mm tolerance.
 *
 * ONE METHOD covers flat, ball, bull and cone/V, because `heightAt` is convex and non-decreasing
 * for all four: the required tip height at a point `p`, `f(p) = p.z − heightAt(|p − axis|)`, is
 * therefore concave along any straight line through the query axis — in particular along a
 * facet's own UPHILL ray (direction `(a,b)/g`, `g = √(a²+b²)` the facet's slope magnitude) and
 * along any EDGE (whose points are `heightAt` of a distance that is itself convex in the edge's
 * own parameter). A concave function of one variable has exactly one maximum, found exactly:
 *
 *   - FACET (`z = a·x+b·y+c`, `L = √(1+a²+b²)`): the maximiser, as a radius ρ* from the axis along
 *     the uphill ray, has a closed form per shape (`facetRhoStar`) — flat: `R`; ball: `R·g/L`;
 *     bull: `ρ0 + r·g/L` (`ρ0 = flatRadiusMm`, `r = curveRadiusMm`); cone: `ρ0` when `g·tanφ < 1`,
 *     else `R`. The contact point is `axis + ρ*·(a,b)/g` (or the axis itself when `g ≈ 0` — a
 *     horizontal facet's own contact is trivially `z = c` for every shape, `heightAt(anything
 *     within flatRadiusMm) = 0` and the concave max past it is never higher). Valid only when that
 *     point is actually on the triangle (`insideTriangleXY`); `z = plane(contact) − heightAt(ρ*)`.
 *   - EDGE: `f` restricted to one edge, parametrised by its own `s ∈ [0, 1]`, is still concave (the
 *     same convexity argument), so a GOLDEN-SECTION search (`edgeContactMax`) finds its one maximum
 *     exactly over the part of the edge actually within reach (`edgeReachInterval`, a quadratic in
 *     `s` for the circle-line intersection, same structure `facetRhoStar`'s own derivation used) —
 *     checked against the two endpoints explicitly too, since a FLAT's own `f` is linear along an
 *     edge (no interior maximum for golden-section to converge toward) and must land exactly on
 *     one. A zero-length-in-XY (vertical) edge is skipped: `ρ` is constant along it, so whichever
 *     vertex is higher already binds and is already exact.
 *   - VERTICES are always exact (any single point is, for every shape) — kept as the base case.
 *
 * A true spatial index (kd-tree) over the mesh, not the brute-force bbox prune `reachableTriangles`
 * still does, is the next documented performance follow-up — this slice is correctness only.
 *
 * ASSUMED, NOT CHECKED HERE: the mesh is CLOSED over the top surface a cutter can reach — a
 * degenerate (zero-area) triangle leaves no gap because its neighbours still cover the ground it
 * sat on, but a genuinely MISSING facet does, and the max-reduction then has nothing there to beat
 * a neighbour's own (otherwise correct) edge contact, under-reporting the true height. Not this
 * file's problem to catch: a mesh with open edges on a reachable surface is an input-validity
 * question, repaired or refused before planning ever sees it (the existing closed-mesh check this
 * engine already throws on, `manifoldOfTriangles`'s `ManifoldError: Not manifold`, is the same
 * question asked earlier, for a different reason).
 */

import type { Tool } from '@/engine/cnc/tool';
import { isVShape, vCone } from '@/engine/cnc/vProfile';
import { buildTriangleBins, type TriangleBins } from './triangleBins';

/** A triangle-soup mesh: `positions` is 9 numbers (x0,y0,z0,x1,y1,z1,x2,y2,z2) per triangle, exactly `ParsedMesh`'s shape. */
export interface DropCutterMesh {
  positions: Float32Array | number[];
  indices: Uint32Array | number[];
  triangleCount: number;
}

/**
 * The cutter's own bottom-surface height above its tip, as a function of horizontal distance `rho`
 * from the tool axis, for `rho` up to `radiusMm`. `flatRadiusMm` is where the flat-bottomed part of
 * the profile ends (the whole radius for a flat cutter, 0 for a ball, the cone's tip radius for a
 * V/chamfer, `R − r` for a bull); beyond it the profile is either a circular arc (ball/bull, radius
 * `curveRadiusMm`) or a cone (V/chamfer, slope `1 / tanHalfAngle`).
 */
export interface CutterProfile {
  radiusMm: number;
  flatRadiusMm: number;
  kind: 'flat' | 'arc' | 'cone';
  curveRadiusMm?: number;
  tanHalfAngle?: number;
}

export function heightAt(profile: CutterProfile, rho: number): number {
  if (rho <= profile.flatRadiusMm) return 0;
  if (profile.kind === 'cone') return (rho - profile.flatRadiusMm) / (profile.tanHalfAngle ?? 1);
  if (profile.kind === 'flat') return 0;
  const r = profile.curveRadiusMm ?? 0;
  const w = rho - profile.flatRadiusMm;
  return r - Math.sqrt(Math.max(0, r * r - w * w));
}

/**
 * The cutter's profile, from its `Tool` record. `null` for a shape this engine's CL surface does
 * not cover (drill, thread, engraving/chamfer with no stated angle) — §2 is flat/ball/bull/V only.
 */
export function profileOf(tool: Tool): CutterProfile | null {
  if (isVShape(tool)) {
    const cone = vCone(tool);
    if (cone === null) return null;
    return {
      radiusMm: cone.outerRadius ?? cone.tipRadius + 10,
      flatRadiusMm: cone.tipRadius,
      kind: 'cone',
      tanHalfAngle: cone.tanHalf,
    };
  }
  const diameter = cuttingDiameterOf(tool);
  if (diameter === null || !(diameter > 0)) return null;
  const R = diameter / 2;
  if (tool.shape === 'flat') return { radiusMm: R, flatRadiusMm: R, kind: 'flat' };
  if (tool.shape === 'ball') return { radiusMm: R, flatRadiusMm: 0, kind: 'arc', curveRadiusMm: R };
  if (tool.shape === 'bull') {
    const r = tool.cornerRadius;
    if (r === null || !(r > 0) || !(r <= R)) return null;
    return { radiusMm: R, flatRadiusMm: R - r, kind: 'arc', curveRadiusMm: r };
  }
  return null;
}

function cuttingDiameterOf(tool: Tool): number | null {
  if (tool.tipDiameter !== null && tool.tipDiameter > 0) return tool.tipDiameter;
  if (tool.diameter !== null && tool.diameter > 0) return tool.diameter;
  return null;
}

interface Tri {
  ax: number; ay: number; az: number;
  bx: number; by: number; bz: number;
  cx: number; cy: number; cz: number;
  minX: number; maxX: number; minY: number; maxY: number;
}

function triangleOf(mesh: DropCutterMesh, t: number): Tri {
  const i0 = mesh.indices[t * 3]! * 3;
  const i1 = mesh.indices[t * 3 + 1]! * 3;
  const i2 = mesh.indices[t * 3 + 2]! * 3;
  const p = mesh.positions;
  const ax = p[i0]!, ay = p[i0 + 1]!, az = p[i0 + 2]!;
  const bx = p[i1]!, by = p[i1 + 1]!, bz = p[i1 + 2]!;
  const cx = p[i2]!, cy = p[i2 + 1]!, cz = p[i2 + 2]!;
  return {
    ax, ay, az, bx, by, bz, cx, cy, cz,
    minX: Math.min(ax, bx, cx), maxX: Math.max(ax, bx, cx),
    minY: Math.min(ay, by, cy), maxY: Math.max(ay, by, cy),
  };
}

/** Triangle indices whose bounding box (grown by `radiusMm`) can reach (x, y). Brute-force bbox prune; a kd-tree is the documented follow-up. */
export function reachableTriangles(mesh: DropCutterMesh, x: number, y: number, radiusMm: number): number[] {
  const out: number[] = [];
  for (let t = 0; t < mesh.triangleCount; t++) {
    const tri = triangleOf(mesh, t);
    if (x < tri.minX - radiusMm || x > tri.maxX + radiusMm) continue;
    if (y < tri.minY - radiusMm || y > tri.maxY + radiusMm) continue;
    out.push(t);
  }
  return out;
}

const EPS = 1e-9;

/** `z = a*x + b*y + c`; `L = sqrt(1 + a^2 + b^2)` — the slope-length factor the ball/flat exact
 * contact formulas both use. A triangle whose own projection onto XY is degenerate (a vertical
 * facet, or three collinear points) has no such plane — `triangleBins.ts`'s own `planeA` is `NaN`
 * for one, the bin-build-time equivalent of this file's old per-query `planeOf`'s `null` (#970:
 * the plane is now computed once per triangle at bin build, never per query — see that file). */
interface Plane {
  a: number;
  b: number;
  c: number;
  L: number;
}

/** Whether `(px, py)` lies within the triangle `(ax,ay)-(bx,by)-(cx,cy)`'s own XY projection (on
 * the boundary counts), by the sign of its three edge cross-products — independent of winding.
 * Explicit scalar vertices, not a `Tri`, so #970's exact pass can call this straight off the
 * mesh's own typed arrays with no intermediate object. */
function insideTriangleXY(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, px: number, py: number): boolean {
  const cross = (ox: number, oy: number, ax: number, ay: number, bx: number, by: number): number =>
    (ax - ox) * (by - oy) - (ay - oy) * (bx - ox);
  const d1 = cross(ax, ay, bx, by, px, py);
  const d2 = cross(bx, by, cx, cy, px, py);
  const d3 = cross(cx, cy, ax, ay, px, py);
  const hasNeg = d1 < -EPS || d2 < -EPS || d3 < -EPS;
  const hasPos = d1 > EPS || d2 > EPS || d3 > EPS;
  return !(hasNeg && hasPos);
}

/**
 * The facet-interior maximiser ρ* (header's own derivation) — the radius from the axis, along the
 * facet's own uphill ray, where `f(ρ) = g·ρ − heightAt(ρ)` peaks. `g` is the facet's own slope
 * magnitude, `L` its slope-length factor (`√(1+a²+b²)`, both from the same `Plane`).
 */
function facetRhoStar(profile: CutterProfile, g: number, L: number): number {
  const R = profile.radiusMm;
  if (profile.kind === 'flat') return R;
  if (profile.kind === 'cone') {
    const tanPhi = profile.tanHalfAngle ?? 1;
    return g * tanPhi < 1 ? profile.flatRadiusMm : R;
  }
  const r = profile.curveRadiusMm ?? 0; // 'arc': ball (flatRadiusMm 0) or bull (flatRadiusMm R-r)
  return profile.flatRadiusMm + (r * g) / L;
}

/** The facet's own exact contact — `z = plane(contact) − heightAt(ρ*)`, valid only when the
 * contact point this function returns is actually on the triangle (`insideTriangleXY`). */
function facetContact(plane: Plane, profile: CutterProfile, x: number, y: number): { px: number; py: number; z: number } {
  const g = Math.hypot(plane.a, plane.b);
  const rhoStar = facetRhoStar(profile, g, plane.L);
  const [px, py] = g < EPS ? [x, y] : [x + (rhoStar * plane.a) / g, y + (rhoStar * plane.b) / g];
  const z = plane.a * px + plane.b * py + plane.c - heightAt(profile, rhoStar);
  return { px, py, z };
}

/**
 * The `s ∈ [0, 1]` sub-interval of the edge from `(x0,y0)` to `(x1,y1)` whose points lie within
 * `R` of `(cx, cy)` — the same quadratic `facetRhoStar`'s own derivation used, here for a line
 * segment's distance instead of a facet's radius. `null` when the edge is degenerate in XY (a
 * vertical edge — `ρ` is constant along it, so whichever vertex is higher already binds) or
 * entirely out of reach.
 */
function edgeReachInterval(x0: number, y0: number, x1: number, y1: number, cx: number, cy: number, R: number): [number, number] | null {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const a = dx * dx + dy * dy;
  if (a < EPS) return null;
  const fx = x0 - cx;
  const fy = y0 - cy;
  const b = 2 * (fx * dx + fy * dy);
  const c = fx * fx + fy * fy - R * R;
  const disc = b * b - 4 * a * c;
  let lo: number;
  let hi: number;
  if (disc < 0) {
    if (c > 0) return null; // the whole line stays outside the circle
    lo = 0;
    hi = 1; // no real crossing and inside at s=0: the whole [0,1] segment is within reach
  } else {
    const sq = Math.sqrt(disc);
    lo = Math.max(0, (-b - sq) / (2 * a));
    hi = Math.min(1, (-b + sq) / (2 * a));
  }
  return lo > hi + EPS ? null : [Math.max(0, lo), Math.min(1, hi)];
}

/**
 * The exact maximum of `f(s) = p(s).z − heightAt(|p(s) − (x,y)|)` over the part of one edge within
 * reach — concave (header's own argument), found by golden-section search to well past the
 * fixtures' own 0.001 mm Z tolerance, with both endpoints checked explicitly so a FLAT's own
 * linear `f` (no interior maximum to converge toward) lands exactly on one. `null` when the edge
 * never comes within reach at all.
 */
function edgeContactMax(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, x: number, y: number, profile: CutterProfile): number | null {
  const interval = edgeReachInterval(x0, y0, x1, y1, x, y, profile.radiusMm);
  if (interval === null) return null;
  const [lo, hi] = interval;
  const f = (s: number): number => {
    const px = x0 + s * (x1 - x0);
    const py = y0 + s * (y1 - y0);
    const pz = z0 + s * (z1 - z0);
    const rho = Math.min(Math.hypot(px - x, py - y), profile.radiusMm);
    return pz - heightAt(profile, rho);
  };
  // #970(b) — A FLAT'S OWN EDGE NEEDS NO SEARCH: `heightAt ≡ 0` throughout the reach interval
  // (flatRadiusMm = radiusMm for a flat profile), so `f` is exactly linear in `s` there — its
  // maximum is at one endpoint, always, and a golden-section search can only ever return one of
  // them anyway (this file's own header). Skipping it removes ~170 f-evaluations per candidate on
  // every path a flat end mill walks — the skim, the 4a mask and every pocket.
  if (profile.kind === 'flat') return Math.max(f(lo), f(hi));
  const GOLDEN = (Math.sqrt(5) - 1) / 2;
  let a = lo;
  let b = hi;
  let c = b - GOLDEN * (b - a);
  let d = a + GOLDEN * (b - a);
  let fc = f(c);
  let fd = f(d);
  for (let i = 0; i < 80 && b - a > 1e-12; i++) {
    if (fc > fd) {
      b = d;
      d = c;
      fd = fc;
      c = b - GOLDEN * (b - a);
      fc = f(c);
    } else {
      a = c;
      c = d;
      fc = fd;
      d = a + GOLDEN * (b - a);
      fd = f(d);
    }
  }
  return Math.max(f(lo), f(hi), f((a + b) / 2));
}

/**
 * The CL height at (x, y): the Z the cutter's tip reaches, dropped onto `mesh`, or `null` when no
 * triangle is within the cutter's reach. `profile` is this cutter's `profileOf(tool)` — callers that
 * query many points for the same cutter should compute it once.
 */
/** Per-mesh bins, built on the first query and reused for the mesh's lifetime (#960). */
const binsByMesh = new WeakMap<DropCutterMesh, TriangleBins>();
function binsFor(mesh: DropCutterMesh): TriangleBins {
  let bins = binsByMesh.get(mesh);
  if (bins === undefined) {
    bins = buildTriangleBins(mesh);
    binsByMesh.set(mesh, bins);
  }
  return bins;
}

/** The horizontal distance from `(x, y)` to the nearest point of the box `[minX,maxX]x[minY,maxY]`
 * — 0 when `(x, y)` is inside it. The exact pruning bound (#970) needs this, never the box's own
 * centre or corner: it is the SMALLEST distance any point of the box could be at, so `maxZ −
 * heightAt(this)` is a true upper bound over the whole box (`heightAt` is non-decreasing). */
function rhoMinToBox(x: number, y: number, minX: number, maxX: number, minY: number, maxY: number): number {
  const dx = x < minX ? minX - x : x > maxX ? x - maxX : 0;
  const dy = y < minY ? minY - y : y > maxY ? y - maxY : 0;
  return Math.hypot(dx, dy);
}

/**
 * #970 — THE EXACT, PRUNED QUERY. Same answer as the old brute force (every triangle, every
 * contribution), to the bit: a triangle whose own upper bound `maxZ − heightAt(distance to its
 * bbox)` cannot beat the running maximum is skipped WITHOUT being read, which can only prune
 * candidates that could never have won — never one that could have. The bound is PER TRIANGLE
 * only, never per cell: a triangle's own bbox is a true superset of its geometry, so the bound
 * off it is always valid, but the small cell it happens to be registered in is not (a mesh with
 * a few triangles much larger than the `cellMm` their own median-extent sizing clamped to can
 * have a cell-bbox distance that reads FARTHER than the triangle's own, which would wrongly skip
 * the cell — this is why there is no `cellMaxZ` check here even though the bins compute one).
 * Two phases over the SAME cell range `binnedReachableTriangles` already used (its own CSR walk
 * and per-query stamp dedup): first the per-triangle bound plus a cheap vertex-only pass (seeds
 * `best` before any exact work runs), then the exact facet/edge work, gated by the SAME bound
 * re-checked against the now-stronger `best` — only for a triangle that still might win. No `Tri`
 * object, no `edges` array, no per-triangle closures: every read is a scalar off a typed array
 * (the mesh's own positions/indices, and the bins' precomputed `maxZ`/plane coefficients).
 */
export function dropCutterHeight(profile: CutterProfile, mesh: DropCutterMesh, x: number, y: number): number | null {
  const bins = binsFor(mesh);
  const R = profile.radiusMm;
  const { triangles, cellMm, x0, y0, nx, ny, cellStart, cellTriangles, stamp } = bins;
  const i0 = Math.min(nx - 1, Math.max(0, Math.floor((x - R - x0) / cellMm)));
  const i1 = Math.min(nx - 1, Math.max(0, Math.floor((x + R - x0) / cellMm)));
  const j0 = Math.min(ny - 1, Math.max(0, Math.floor((y - R - y0) / cellMm)));
  const j1 = Math.min(ny - 1, Math.max(0, Math.floor((y + R - y0) / cellMm)));
  const generation = ++bins.generation;
  const p = mesh.positions;
  const idx = mesh.indices;

  let best = -Infinity; // a real contribution is always > -Infinity; no explicit "found" flag needed
  const candidates: number[] = [];

  // PHASE 1 — cell sweep (no cell-level bound: a triangle's own bbox can reach past the small
  // cell it happens to be registered in — on a mesh with a few triangles much larger than the
  // `cellMm` their own median-extent sizing clamped to, `cellMaxZ`'s cell-bbox distance can read
  // FARTHER than the triangle's own true bbox distance, which would wrongly skip a cell holding
  // the real winner — #970's cell-level prune was dropped for exactly this; the fix is the
  // per-triangle bound below, which is always valid since a triangle IS a subset of its own bbox)
  // then the three vertices of anything that survives THAT — always exact, every profile, and
  // the cheapest way to seed a strong `best` before any facet/edge work is even considered.
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const c = j * nx + i;
      const end = cellStart[c + 1]!;
      for (let s = cellStart[c]!; s < end; s++) {
        const t = cellTriangles[s]!;
        if (stamp[t] === generation) continue;
        stamp[t] = generation;
        const tMinX = triangles.minX[t]!, tMaxX = triangles.maxX[t]!;
        const tMinY = triangles.minY[t]!, tMaxY = triangles.maxY[t]!;
        if (x < tMinX - R || x > tMaxX + R) continue;
        if (y < tMinY - R || y > tMaxY + R) continue;

        const rhoMinTri = Math.min(rhoMinToBox(x, y, tMinX, tMaxX, tMinY, tMaxY), R);
        if (triangles.maxZ[t]! - heightAt(profile, rhoMinTri) <= best) continue;

        candidates.push(t);
        const i0v = idx[t * 3]! * 3, i1v = idx[t * 3 + 1]! * 3, i2v = idx[t * 3 + 2]! * 3;
        for (const vi of [i0v, i1v, i2v]) {
          const vx = p[vi] as number, vy = p[vi + 1] as number, vz = p[vi + 2] as number;
          const rho = Math.hypot(vx - x, vy - y);
          if (rho > R + EPS) continue;
          const z = vz - heightAt(profile, rho);
          if (z > best) best = z;
        }
      }
    }
  }

  // PHASE 2 — exact work (facet + edges), only for a candidate whose own bound still beats the
  // vertex-seeded `best`. The plane is the bins' own precomputed one — no `planeOf` call.
  for (const t of candidates) {
    const tMinX = triangles.minX[t]!, tMaxX = triangles.maxX[t]!;
    const tMinY = triangles.minY[t]!, tMaxY = triangles.maxY[t]!;
    const rhoMinTri = Math.min(rhoMinToBox(x, y, tMinX, tMaxX, tMinY, tMaxY), R);
    if (triangles.maxZ[t]! - heightAt(profile, rhoMinTri) <= best) continue;

    const planeA = triangles.planeA[t]!;

    const i0v = idx[t * 3]! * 3, i1v = idx[t * 3 + 1]! * 3, i2v = idx[t * 3 + 2]! * 3;
    const ax = p[i0v] as number, ay = p[i0v + 1] as number, az = p[i0v + 2] as number;
    const bx = p[i1v] as number, by = p[i1v + 1] as number, bz = p[i1v + 2] as number;
    const cx = p[i2v] as number, cy = p[i2v + 1] as number, cz = p[i2v + 2] as number;

    // A degenerate (vertical) facet has no facet-interior contact to compute (`insideTriangleXY`
    // would be asked about a point from a meaningless plane) — but its EDGES are still real
    // geometry, same as any other triangle's: a quad's two triangles can BOTH collapse to a
    // vertical facet (e.g. a box's side wall, split on its own diagonal) while that shared
    // diagonal edge spans real XY distance and is the true contact nowhere else, since neither
    // adjacent triangle's facet plane exists to carry it. Only the facet maximiser is skipped.
    if (!Number.isNaN(planeA)) {
      const plane: Plane = { a: planeA, b: triangles.planeB[t]!, c: triangles.planeC[t]!, L: triangles.planeL[t]! };
      const facet = facetContact(plane, profile, x, y);
      if (facet.z > best && insideTriangleXY(ax, ay, bx, by, cx, cy, facet.px, facet.py)) best = facet.z;
    }

    const e1 = edgeContactMax(ax, ay, az, bx, by, bz, x, y, profile);
    if (e1 !== null && e1 > best) best = e1;
    const e2 = edgeContactMax(bx, by, bz, cx, cy, cz, x, y, profile);
    if (e2 !== null && e2 > best) best = e2;
    const e3 = edgeContactMax(cx, cy, cz, ax, ay, az, x, y, profile);
    if (e3 !== null && e3 > best) best = e3;
  }

  return best === -Infinity ? null : best;
}
