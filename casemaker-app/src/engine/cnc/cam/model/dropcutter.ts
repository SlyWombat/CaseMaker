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
import { binnedReachableTriangles, buildTriangleBins, type TriangleBins } from './triangleBins';

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
 * contact formulas both use. `null` for a triangle whose own projection onto XY is degenerate
 * (a vertical facet, or three collinear points) — no `a*x+b*y+c` plane states its height there. */
interface Plane {
  a: number;
  b: number;
  c: number;
  L: number;
}

function planeOf(tri: Tri): Plane | null {
  const ux = tri.bx - tri.ax, uy = tri.by - tri.ay, uz = tri.bz - tri.az;
  const vx = tri.cx - tri.ax, vy = tri.cy - tri.ay, vz = tri.cz - tri.az;
  let nx = uy * vz - uz * vy;
  let ny = uz * vx - ux * vz;
  let nz = ux * vy - uy * vx;
  if (Math.abs(nz) < EPS) return null;
  if (nz < 0) {
    nx = -nx;
    ny = -ny;
    nz = -nz;
  }
  const a = -nx / nz;
  const b = -ny / nz;
  const c = tri.az - a * tri.ax - b * tri.ay;
  return { a, b, c, L: Math.sqrt(1 + a * a + b * b) };
}

/** Whether `(px, py)` lies within the triangle's own XY projection (on the boundary counts), by
 * the sign of its three edge cross-products — independent of winding. */
function insideTriangleXY(tri: Tri, px: number, py: number): boolean {
  const cross = (ox: number, oy: number, ax: number, ay: number, bx: number, by: number): number =>
    (ax - ox) * (by - oy) - (ay - oy) * (bx - ox);
  const d1 = cross(tri.ax, tri.ay, tri.bx, tri.by, px, py);
  const d2 = cross(tri.bx, tri.by, tri.cx, tri.cy, px, py);
  const d3 = cross(tri.cx, tri.cy, tri.ax, tri.ay, px, py);
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
 * One triangle's contribution to the drop-cutter max at (x, y) — the highest `p.z - heightAt(rho)`
 * over every point of the triangle within `profile.radiusMm`, EXACT for every shape (this file's
 * own header: vertices, the one facet-interior maximiser, and a golden-section edge search).
 */
function triangleContribution(tri: Tri, profile: CutterProfile, x: number, y: number): number | null {
  const R = profile.radiusMm;
  let best: number | null = null;
  const consider = (px: number, py: number, pz: number): void => {
    const rho = Math.hypot(px - x, py - y);
    if (rho > R + EPS) return;
    const z = pz - heightAt(profile, rho);
    if (best === null || z > best) best = z;
  };
  const considerExact = (z: number): void => {
    if (best === null || z > best) best = z;
  };

  // Vertices — always exact, every profile.
  consider(tri.ax, tri.ay, tri.az);
  consider(tri.bx, tri.by, tri.bz);
  consider(tri.cx, tri.cy, tri.cz);

  const plane = planeOf(tri);
  if (plane === null) return best; // a degenerate (vertical) facet: vertices are all there is

  const facet = facetContact(plane, profile, x, y);
  if (insideTriangleXY(tri, facet.px, facet.py)) considerExact(facet.z);

  const edges: [number, number, number, number, number, number][] = [
    [tri.ax, tri.ay, tri.az, tri.bx, tri.by, tri.bz],
    [tri.bx, tri.by, tri.bz, tri.cx, tri.cy, tri.cz],
    [tri.cx, tri.cy, tri.cz, tri.ax, tri.ay, tri.az],
  ];
  for (const [ex0, ey0, ez0, ex1, ey1, ez1] of edges) {
    const z = edgeContactMax(ex0, ey0, ez0, ex1, ey1, ez1, x, y, profile);
    if (z !== null) considerExact(z);
  }
  return best;
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

export function dropCutterHeight(profile: CutterProfile, mesh: DropCutterMesh, x: number, y: number): number | null {
  let best: number | null = null;
  for (const t of binnedReachableTriangles(binsFor(mesh), x, y, profile.radiusMm)) {
    const tri = triangleOf(mesh, t);
    const contribution = triangleContribution(tri, profile, x, y);
    if (contribution !== null && (best === null || contribution > best)) best = contribution;
  }
  return best;
}
