import type { Vec2, Vec3 } from '@/types';
import { aabbOfOp, type Aabb, type BuildOp, type Profile } from './buildPlan';

/**
 * The shared clash check for the case's interior and exterior features (magnet
 * bosses and pockets, the floor grid's dividers, the stacking connector's
 * sockets, and everything they can land on).
 *
 * Every feature is turned into its REAL geometry, read straight off the
 * BuildOps the compiler emits, never their bounding boxes:
 *
 *   - Convex pieces become convex polyhedra: cubes, cylinders and cones,
 *     extrusions of convex outlines (rectangles, circles, rounded rectangles,
 *     dovetails), hulls of a few such pieces, and convex triangle meshes, each
 *     carried through every translate, rotate and scale above it.
 *   - A union is its pieces. A difference keeps the first child's pieces and
 *     subtracts the rest exactly, so a ring (the alignment brim, a lid lip) is a
 *     ring and not the slab it was cut from.
 *   - Two solids clash when the intersection of the actual polyhedra, after the
 *     subtractions, still has volume. The answer carries the overlap's size and
 *     where it is.
 *
 * Flat features (a divider's foot, a HAT board) can be given as a FOOTPRINT —
 * convex outlines in XY between two Z heights. Two footprints are tested in 2D
 * with their Z bands, which is exact for them and cheaper.
 *
 * What cannot be read exactly falls back to its bounding box, and the answer
 * says so (`method: 'bounds'`): a non-convex outline (its hull is used), an
 * intersection op (its first child), a twisted or unevenly tapered extrusion, a
 * revolve, a large hull or a non-convex mesh. Circles are polygons of at most
 * `MAX_SEGMENTS` sides, so a curved surface can be off by up to
 * r·(1 − cos(π/48)) — 0.02 mm on an 8 mm radius.
 *
 * Speed: the compile runs on every slider move. Each op's polyhedra are cached
 * by the op's content (a moved feature is a new key, an unchanged one is not
 * rebuilt), each pair's answer is cached by the two keys, and pairs whose boxes
 * do not meet are never intersected.
 */

export type ClashMethod = 'solid' | 'footprint' | 'bounds';

/** A clash is only a clash when the overlap is at least this thick, mm. */
export const MIN_OVERLAP = 0.01;
/** Most sides a circle gets in the clash model. */
export const MAX_SEGMENTS = 48;

const EPS = 1e-7;

// ---------------------------------------------------------------------------
// Convex polyhedra
// ---------------------------------------------------------------------------

interface Plane {
  n: Vec3;
  d: number;
}

interface Convex {
  /** Face polygons, outward normals, in world coordinates. */
  faces: Vec3[][];
  planes: Plane[];
  box: Aabb;
  /** False when this is a stand-in (a bounding box or a hull) for the real shape. */
  exact: boolean;
}

interface Part {
  body: Convex;
  /** Each group is a union of convex pieces cut out of the body. */
  minus: Convex[][];
}

/** One op's geometry in the clash model. */
export interface ClashShape {
  key: string;
  parts: Part[];
  box: Aabb | null;
  method: ClashMethod;
  /** A trial shape, kept out of the caches. */
  transient?: boolean;
  /** Set for a footprint shape: its convex outlines and Z band. */
  footprint?: { polys: Vec2[][]; z0: number; z1: number };
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

function boxOfPoints(pts: Iterable<Vec3>): Aabb | null {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  let any = false;
  for (const p of pts) {
    any = true;
    for (let k = 0; k < 3; k++) {
      if (p[k]! < min[k]!) min[k] = p[k]!;
      if (p[k]! > max[k]!) max[k] = p[k]!;
    }
  }
  return any ? { min, max } : null;
}

function* facePoints(c: { faces: Vec3[][] }): Iterable<Vec3> {
  for (const f of c.faces) yield* f;
}

function boxesMeet(a: Aabb, b: Aabb, tol = 0): boolean {
  for (let k = 0; k < 3; k++) {
    if (a.max[k]! <= b.min[k]! + tol || b.max[k]! <= a.min[k]! + tol) return false;
  }
  return true;
}

function unionBox(a: Aabb | null, b: Aabb | null): Aabb | null {
  if (!a) return b;
  if (!b) return a;
  return {
    min: [Math.min(a.min[0], b.min[0]), Math.min(a.min[1], b.min[1]), Math.min(a.min[2], b.min[2])],
    max: [Math.max(a.max[0], b.max[0]), Math.max(a.max[1], b.max[1]), Math.max(a.max[2], b.max[2])],
  };
}

/**
 * A convex polyhedron from its face polygons. Each face's plane comes from
 * Newell's method and is turned to face away from the centroid, so a mirror in
 * the transform chain cannot invert it. Degenerate faces are dropped.
 */
function convexOf(faces: Vec3[][], exact: boolean): Convex | null {
  const pts = faces.flat();
  if (pts.length < 4) return null;
  const c: Vec3 = [0, 0, 0];
  for (const p of pts) for (let k = 0; k < 3; k++) c[k]! += p[k]! / pts.length;
  const keptFaces: Vec3[][] = [];
  const planes: Plane[] = [];
  for (const f of faces) {
    if (f.length < 3) continue;
    let nx = 0;
    let ny = 0;
    let nz = 0;
    for (let i = 0; i < f.length; i++) {
      const a = f[i]!;
      const b = f[(i + 1) % f.length]!;
      nx += (a[1] - b[1]) * (a[2] + b[2]);
      ny += (a[2] - b[2]) * (a[0] + b[0]);
      nz += (a[0] - b[0]) * (a[1] + b[1]);
    }
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-12) continue;
    let n: Vec3 = [nx / len, ny / len, nz / len];
    let d = dot(n, f[0]!);
    if (dot(n, c) > d) {
      n = [-n[0], -n[1], -n[2]];
      d = -d;
    }
    keptFaces.push(f);
    planes.push({ n, d });
  }
  if (planes.length < 4) return null;
  const box = boxOfPoints(pts);
  if (!box) return null;
  return { faces: keptFaces, planes, box, exact };
}

function boxConvex(b: Aabb, exact: boolean): Convex {
  const [x0, y0, z0] = b.min;
  const [x1, y1, z1] = b.max;
  const v = (x: number, y: number, z: number): Vec3 => [x, y, z];
  return convexOf(
    [
      [v(x0, y0, z0), v(x0, y1, z0), v(x1, y1, z0), v(x1, y0, z0)],
      [v(x0, y0, z1), v(x1, y0, z1), v(x1, y1, z1), v(x0, y1, z1)],
      [v(x0, y0, z0), v(x1, y0, z0), v(x1, y0, z1), v(x0, y0, z1)],
      [v(x0, y1, z0), v(x0, y1, z1), v(x1, y1, z1), v(x1, y1, z0)],
      [v(x0, y0, z0), v(x0, y0, z1), v(x0, y1, z1), v(x0, y1, z0)],
      [v(x1, y0, z0), v(x1, y1, z0), v(x1, y1, z1), v(x1, y0, z1)],
    ],
    exact,
  )!;
}

/** Clip a convex polyhedron to the inside of `h` (n·p ≤ d). Null when nothing is left. */
function clipConvex(c: Convex, h: Plane): Convex | null {
  let allIn = true;
  let allOut = true;
  for (const f of c.faces)
    for (const p of f) {
      const s = dot(h.n, p) - h.d;
      if (s > EPS) allIn = false;
      if (s < -EPS) allOut = false;
    }
  if (allIn) return c;
  if (allOut) return null;
  const faces: Vec3[][] = [];
  const planes: Plane[] = [];
  const cut: Vec3[] = [];
  for (let i = 0; i < c.faces.length; i++) {
    const f = c.faces[i]!;
    const out: Vec3[] = [];
    for (let j = 0; j < f.length; j++) {
      const p = f[j]!;
      const q = f[(j + 1) % f.length]!;
      const sp = dot(h.n, p) - h.d;
      const sq = dot(h.n, q) - h.d;
      if (sp <= EPS) {
        out.push(p);
        if (sp >= -EPS) cut.push(p);
      }
      if ((sp < -EPS && sq > EPS) || (sp > EPS && sq < -EPS)) {
        const t = sp / (sp - sq);
        const x: Vec3 = [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, p[2] + (q[2] - p[2]) * t];
        out.push(x);
        cut.push(x);
      }
    }
    if (out.length >= 3) {
      faces.push(out);
      planes.push(c.planes[i]!);
    }
  }
  // The cap: every point on the cutting plane, in order around their centre.
  const cap = orderOnPlane(dedupe(cut), h.n);
  if (cap.length >= 3) {
    faces.push(cap);
    planes.push(h);
  }
  if (faces.length < 4) return null;
  const box = boxOfPoints(facePoints({ faces }));
  if (!box) return null;
  return { faces, planes, box, exact: c.exact };
}

function dedupe(pts: Vec3[]): Vec3[] {
  const out: Vec3[] = [];
  for (const p of pts) {
    if (!out.some((q) => Math.abs(q[0] - p[0]) < 1e-6 && Math.abs(q[1] - p[1]) < 1e-6 && Math.abs(q[2] - p[2]) < 1e-6))
      out.push(p);
  }
  return out;
}

/** Points on a plane with normal `n`, ordered counter-clockwise seen from +n. */
function orderOnPlane(pts: Vec3[], n: Vec3): Vec3[] {
  if (pts.length < 3) return pts;
  const c: Vec3 = [0, 0, 0];
  for (const p of pts) for (let k = 0; k < 3; k++) c[k]! += p[k]! / pts.length;
  const ref: Vec3 = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u = cross(n, ref);
  const ul = Math.hypot(...u);
  const uu: Vec3 = [u[0] / ul, u[1] / ul, u[2] / ul];
  const vv = cross(n, uu);
  return pts
    .map((p) => {
      const r = sub(p, c);
      return { p, a: Math.atan2(dot(r, vv), dot(r, uu)) };
    })
    .sort((x, y) => x.a - y.a)
    .map((x) => x.p);
}

function flip(h: Plane): Plane {
  return { n: [-h.n[0], -h.n[1], -h.n[2]], d: -h.d };
}

function thick(c: Convex): boolean {
  return (
    c.box.max[0] - c.box.min[0] >= MIN_OVERLAP &&
    c.box.max[1] - c.box.min[1] >= MIN_OVERLAP &&
    c.box.max[2] - c.box.min[2] >= MIN_OVERLAP
  );
}

function intersectConvex(a: Convex, b: Convex): Convex | null {
  if (!boxesMeet(a.box, b.box)) return null;
  let p: Convex | null = a;
  for (const h of b.planes) {
    p = clipConvex(p, h);
    if (!p || !thick(p)) return null;
  }
  return p;
}

const MAX_PIECES = 256;

/**
 * `pieces` minus the union of `group`, exactly: P∖C is the union over C's
 * planes h_k of P ∩ inside(h_1..h_{k−1}) ∩ outside(h_k), disjoint pieces each
 * convex. Returns null when the piece count runs away (the caller then keeps
 * what it had, which over-covers rather than misses).
 */
function subtractGroup(pieces: Convex[], group: Convex[]): Convex[] | null {
  let cur = pieces;
  for (const c of group) {
    const next: Convex[] = [];
    for (const p of cur) {
      if (!boxesMeet(p.box, c.box)) {
        next.push(p);
        continue;
      }
      let rest: Convex | null = p;
      for (const h of c.planes) {
        if (!rest) break;
        const outside = clipConvex(rest, flip(h));
        if (outside && thick(outside)) next.push(outside);
        rest = clipConvex(rest, h);
      }
      if (next.length > MAX_PIECES) return null;
    }
    cur = next;
    if (cur.length === 0) break;
  }
  return cur;
}

// ---------------------------------------------------------------------------
// Transforms
// ---------------------------------------------------------------------------

/** Row-major 3×4 affine: x' = M·[x y z 1]. */
type Affine = number[];
const IDENTITY: Affine = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];

function compose(a: Affine, b: Affine): Affine {
  const o = new Array<number>(12);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      o[r * 4 + c] = a[r * 4]! * b[c]! + a[r * 4 + 1]! * b[4 + c]! + a[r * 4 + 2]! * b[8 + c]!;
    }
    o[r * 4 + 3] = a[r * 4]! * b[3]! + a[r * 4 + 1]! * b[7]! + a[r * 4 + 2]! * b[11]! + a[r * 4 + 3]!;
  }
  return o;
}

function apply(m: Affine, p: Vec3): Vec3 {
  return [
    m[0]! * p[0] + m[1]! * p[1] + m[2]! * p[2] + m[3]!,
    m[4]! * p[0] + m[5]! * p[1] + m[6]! * p[2] + m[7]!,
    m[8]! * p[0] + m[9]! * p[1] + m[10]! * p[2] + m[11]!,
  ];
}

/** Manifold's rotate: about X, then Y, then Z. */
function rotation(deg: Vec3): Affine {
  const [ax, ay, az] = deg.map((d) => (d * Math.PI) / 180) as Vec3;
  const cx = Math.cos(ax), sx = Math.sin(ax);
  const cy = Math.cos(ay), sy = Math.sin(ay);
  const cz = Math.cos(az), sz = Math.sin(az);
  const rx: Affine = [1, 0, 0, 0, 0, cx, -sx, 0, 0, sx, cx, 0];
  const ry: Affine = [cy, 0, sy, 0, 0, 1, 0, 0, -sy, 0, cy, 0];
  const rz: Affine = [cz, -sz, 0, 0, sz, cz, 0, 0, 0, 0, 1, 0];
  return compose(rz, compose(ry, rx));
}

// ---------------------------------------------------------------------------
// 2D outlines
// ---------------------------------------------------------------------------

interface Region {
  outer: Vec2[];
  holes: Vec2[][];
  exact: boolean;
}

function area2(p: Vec2[]): number {
  let a = 0;
  for (let i = 0; i < p.length; i++) {
    const [x0, y0] = p[i]!;
    const [x1, y1] = p[(i + 1) % p.length]!;
    a += x0 * y1 - x1 * y0;
  }
  return a / 2;
}

function ccw(p: Vec2[]): Vec2[] {
  return area2(p) < 0 ? [...p].reverse() : p;
}

function isConvex2(p: Vec2[]): boolean {
  let sign = 0;
  for (let i = 0; i < p.length; i++) {
    const a = p[i]!;
    const b = p[(i + 1) % p.length]!;
    const c = p[(i + 2) % p.length]!;
    const z = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (Math.abs(z) < 1e-12) continue;
    const s = Math.sign(z);
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

/** Andrew's monotone chain, counter-clockwise. */
export function hull2(points: Vec2[]): Vec2[] {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const crossZ = (o: Vec2, a: Vec2, b: Vec2) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Vec2[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && crossZ(lower[lower.length - 2]!, lower[lower.length - 1]!, p) <= 1e-12) lower.pop();
    lower.push(p);
  }
  const upper: Vec2[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i]!;
    while (upper.length >= 2 && crossZ(upper[upper.length - 2]!, upper[upper.length - 1]!, p) <= 1e-12) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

function circleSegments(r: number, asked?: number): number {
  if (asked && asked >= 3) return Math.min(asked, MAX_SEGMENTS * 2);
  // Manifold's own default grows with the radius; the clash model caps it.
  return Math.max(12, Math.min(MAX_SEGMENTS, Math.ceil(r * 8)));
}

function circle2(r: number, segs: number): Vec2[] {
  return Array.from({ length: segs }, (_, i) => {
    const a = (2 * Math.PI * i) / segs;
    return [r * Math.cos(a), r * Math.sin(a)] as Vec2;
  });
}

function mapRegion(r: Region, f: (p: Vec2) => Vec2): Region {
  return { outer: ccw(r.outer.map(f)), holes: r.holes.map((h) => ccw(h.map(f))), exact: r.exact };
}

function regionOf(contour: Vec2[], exact = true): Region {
  if (isConvex2(contour)) return { outer: ccw(contour), holes: [], exact };
  return { outer: hull2(contour), holes: [], exact: false };
}

/** Grow a convex outline by `delta` (round joins). */
function offsetConvex(p: Vec2[], delta: number, round: boolean): Vec2[] {
  if (delta === 0) return p;
  if (delta > 0 && round) {
    const segs = circleSegments(delta);
    const pts: Vec2[] = [];
    for (const v of p) for (const c of circle2(delta, segs)) pts.push([v[0] + c[0], v[1] + c[1]]);
    return hull2(pts);
  }
  // Move every edge along its outward normal and meet the neighbours (a mitre).
  const q = ccw(p);
  const lines = q.map((a, i) => {
    const b = q[(i + 1) % q.length]!;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const l = Math.hypot(dx, dy) || 1;
    const nx = dy / l;
    const ny = -dx / l;
    return { a: [a[0] + nx * delta, a[1] + ny * delta] as Vec2, d: [dx, dy] as Vec2 };
  });
  const out: Vec2[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l1 = lines[(i + lines.length - 1) % lines.length]!;
    const l2 = lines[i]!;
    const den = l1.d[0] * l2.d[1] - l1.d[1] * l2.d[0];
    if (Math.abs(den) < 1e-12) {
      out.push(l2.a);
      continue;
    }
    const t = ((l2.a[0] - l1.a[0]) * l2.d[1] - (l2.a[1] - l1.a[1]) * l2.d[0]) / den;
    out.push([l1.a[0] + l1.d[0] * t, l1.a[1] + l1.d[1] * t]);
  }
  return area2(out) > 0 ? out : [];
}

/** A profile as convex regions with convex holes, or null when it cannot be read. */
function regionsOf(p: Profile): Region[] | null {
  switch (p.kind) {
    case 'p-rect': {
      const [w, h] = p.size;
      const x0 = p.center ? -w / 2 : 0;
      const y0 = p.center ? -h / 2 : 0;
      return [{ outer: [[x0, y0], [x0 + w, y0], [x0 + w, y0 + h], [x0, y0 + h]], holes: [], exact: true }];
    }
    case 'p-circle':
      return [{ outer: circle2(p.radius, circleSegments(p.radius, p.segments)), holes: [], exact: true }];
    case 'p-poly': {
      const cs = p.contours.filter((c) => c.length >= 3);
      if (cs.length === 0) return [];
      if (p.fillRule && p.fillRule !== 'EvenOdd') {
        return [{ outer: hull2(cs.flat()), holes: [], exact: false }];
      }
      const outer = regionOf(cs[0]!);
      for (const h of cs.slice(1)) if (isConvex2(h)) outer.holes.push(ccw(h));
      return [outer];
    }
    case 'p-union': {
      const out: Region[] = [];
      for (const c of p.children) {
        const r = regionsOf(c);
        if (!r) return null;
        out.push(...r);
      }
      return out;
    }
    case 'p-difference': {
      const [first, ...rest] = p.children;
      if (!first) return [];
      const base = regionsOf(first);
      if (!base) return null;
      const holes: Vec2[][] = [];
      for (const c of rest) {
        const r = regionsOf(c);
        // A subtractor that is not a plain convex outline is left out: the
        // region then over-covers, which can over-state but never miss.
        if (r) for (const x of r) if (x.exact && x.holes.length === 0) holes.push(x.outer);
      }
      return base.map((b) => ({ ...b, holes: [...b.holes, ...holes] }));
    }
    case 'p-intersection': {
      const first = p.children[0];
      const r = first ? regionsOf(first) : [];
      return r ? r.map((x) => ({ ...x, exact: false })) : null;
    }
    case 'p-hull': {
      const pts: Vec2[] = [];
      let exact = true;
      for (const c of p.children) {
        const r = regionsOf(c);
        if (!r) return null;
        for (const x of r) {
          pts.push(...x.outer);
          exact = exact && x.exact;
        }
      }
      return pts.length >= 3 ? [{ outer: hull2(pts), holes: [], exact }] : [];
    }
    case 'p-offset': {
      const r = regionsOf(p.child);
      if (!r) return null;
      const round = (p.join ?? 'round') === 'round';
      return r
        .map((x) => ({
          outer: offsetConvex(x.outer, p.delta, round),
          // Holes shrink as the outline grows; dropping them over-covers.
          holes: p.delta < 0 ? x.holes : [],
          exact: x.exact && (round || p.delta < 0 || (p.join ?? 'round') === 'miter'),
        }))
        .filter((x) => x.outer.length >= 3);
    }
    case 'p-translate': {
      const r = regionsOf(p.child);
      const [dx, dy] = p.offset;
      return r ? r.map((x) => mapRegion(x, ([a, b]) => [a + dx, b + dy])) : null;
    }
    case 'p-rotate': {
      const r = regionsOf(p.child);
      const a = (p.degrees * Math.PI) / 180;
      const c = Math.cos(a);
      const s = Math.sin(a);
      return r ? r.map((x) => mapRegion(x, ([u, v]) => [u * c - v * s, u * s + v * c])) : null;
    }
    case 'p-scale': {
      const r = regionsOf(p.child);
      const [sx, sy] = p.scale;
      return r ? r.map((x) => mapRegion(x, ([u, v]) => [u * sx, v * sy])) : null;
    }
    case 'p-mirror': {
      const r = regionsOf(p.child);
      const [nx, ny] = p.normal;
      const l = Math.hypot(nx, ny) || 1;
      const ux = nx / l;
      const uy = ny / l;
      return r
        ? r.map((x) =>
            mapRegion(x, ([u, v]) => {
              const k = 2 * (u * ux + v * uy);
              return [u - k * ux, v - k * uy];
            }),
          )
        : null;
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// BuildOp → parts
// ---------------------------------------------------------------------------

/** Faces of a frustum: `bottom` at z0 and `bottom` scaled by `topScale` at z1. */
function prismFaces(poly: Vec2[], z0: number, z1: number, topScale = 1): Vec3[][] {
  const p = ccw(poly);
  const n = p.length;
  const lo = p.map(([x, y]) => [x, y, z0] as Vec3);
  const hi = p.map(([x, y]) => [x * topScale, y * topScale, z1] as Vec3);
  const faces: Vec3[][] = [[...lo].reverse(), hi];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    faces.push([lo[i]!, lo[j]!, hi[j]!, hi[i]!]);
  }
  return faces;
}

function placed(faces: Vec3[][], m: Affine, exact: boolean): Convex | null {
  return convexOf(
    faces.map((f) => f.map((p) => apply(m, p))),
    exact,
  );
}

function boundsPart(op: BuildOp, m: Affine): Part[] {
  const b = aabbOfOp(op);
  if (!b) return [];
  const corners: Vec3[] = [];
  for (const x of [b.min[0], b.max[0]])
    for (const y of [b.min[1], b.max[1]]) for (const z of [b.min[2], b.max[2]]) corners.push(apply(m, [x, y, z]));
  const wb = boxOfPoints(corners)!;
  return [{ body: boxConvex(wb, false), minus: [] }];
}

const MAX_HULL_POINTS = 32;

/** Brute-force 3D hull for a handful of points: every triangle with all points on one side. */
function hull3(points: Vec3[]): Convex | null {
  const pts = dedupe(points);
  if (pts.length < 4 || pts.length > MAX_HULL_POINTS) return null;
  const faces: Vec3[][] = [];
  const n = pts.length;
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++)
      for (let k = j + 1; k < n; k++) {
        const a = pts[i]!;
        const nn = cross(sub(pts[j]!, a), sub(pts[k]!, a));
        if (Math.hypot(...nn) < 1e-12) continue;
        let pos = false;
        let neg = false;
        for (const q of pts) {
          const s = dot(nn, sub(q, a));
          if (s > 1e-9) pos = true;
          else if (s < -1e-9) neg = true;
          if (pos && neg) break;
        }
        if (!(pos && neg)) faces.push([a, pts[j]!, pts[k]!]);
      }
  return convexOf(faces, true);
}

function partsOf(op: BuildOp, m: Affine): Part[] {
  switch (op.kind) {
    case 'cube': {
      const [x, y, z] = op.size;
      const o: Vec3 = op.center ? [-x / 2, -y / 2, -z / 2] : [0, 0, 0];
      const faces = prismFaces(
        [
          [o[0], o[1]],
          [o[0] + x, o[1]],
          [o[0] + x, o[1] + y],
          [o[0], o[1] + y],
        ],
        o[2],
        o[2] + z,
      );
      const c = placed(faces, m, true);
      return c ? [{ body: c, minus: [] }] : [];
    }
    case 'cylinder': {
      const r0 = op.radiusLow;
      const r1 = op.radiusHigh ?? op.radiusLow;
      const r = Math.max(r0, r1);
      if (!(r > 0) || !(op.height > 0)) return [];
      const segs = circleSegments(r, op.segments);
      const z0 = op.center ? -op.height / 2 : 0;
      const base = r0 > 0 ? circle2(r0, segs) : circle2(r1, segs);
      const faces =
        r0 > 0
          ? prismFaces(base, z0, z0 + op.height, r1 / r0)
          : // A cone standing on its point: build it upside down and flip.
            prismFaces(base, z0 + op.height, z0, 0);
      const c = placed(faces, m, true);
      return c ? [{ body: c, minus: [] }] : [];
    }
    case 'extrude': {
      const regions = regionsOf(op.profile);
      const s = op.scaleTop ?? 1;
      const uniform = typeof s === 'number' ? s : s[0] === s[1] ? s[0] : null;
      if (!regions || uniform === null || op.twistDegrees) return boundsPart(op, m);
      const z0 = op.center ? -op.height / 2 : 0;
      const z1 = z0 + op.height;
      const out: Part[] = [];
      for (const r of regions) {
        // A scaled top shrinks the holes with the outline: a hole is cut as the
        // same frustum, run a hair past both ends so its caps are not shared.
        const body = placed(prismFaces(r.outer, z0, z1, uniform), m, r.exact);
        if (!body) continue;
        const minus: Convex[][] = [];
        for (const h of r.holes) {
          const pad = 0.01;
          const hz0 = z0 - pad;
          const hz1 = z1 + pad;
          const hc = placed(prismFaces(h, hz0, hz1, uniform), m, true);
          if (hc) minus.push([hc]);
        }
        out.push({ body, minus });
      }
      return out;
    }
    case 'translate': {
      const [x, y, z] = op.offset;
      return partsOf(op.child, compose(m, [1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z]));
    }
    case 'rotate':
      return partsOf(op.child, compose(m, rotation(op.degrees)));
    case 'scale': {
      const f = op.factor;
      return partsOf(op.child, compose(m, [f, 0, 0, 0, 0, f, 0, 0, 0, 0, f, 0]));
    }
    case 'union':
      return op.children.flatMap((c) => partsOf(c, m));
    case 'difference': {
      const [first, ...rest] = op.children;
      if (!first) return [];
      const base = partsOf(first, m);
      const groups: Convex[][] = [];
      for (const c of rest) {
        const ps = partsOf(c, m);
        // Only exact, hole-free pieces may be subtracted: taking away a stand-in
        // could take away real material and hide a clash.
        if (ps.length > 0 && ps.every((p) => p.minus.length === 0 && p.body.exact)) groups.push(ps.map((p) => p.body));
      }
      return base.map((b) => ({ body: b.body, minus: [...b.minus, ...groups] }));
    }
    case 'intersection': {
      const first = op.children[0];
      return first ? partsOf(first, m).map((p) => ({ body: { ...p.body, exact: false }, minus: p.minus })) : [];
    }
    case 'hull': {
      const kids = op.children.flatMap((c) => partsOf(c, m));
      const pts = kids.flatMap((k) => [...facePoints(k.body)]);
      const h = kids.every((k) => k.body.exact) ? hull3(pts) : null;
      if (h) return [{ body: h, minus: [] }];
      const b = boxOfPoints(pts);
      return b ? [{ body: boxConvex(b, false), minus: [] }] : [];
    }
    case 'mesh': {
      const pos = op.positions;
      const idx = op.indices;
      const v = (i: number): Vec3 => [pos[i * 3]!, pos[i * 3 + 1]!, pos[i * 3 + 2]!];
      const tris: Vec3[][] = [];
      for (let i = 0; i + 2 < idx.length; i += 3) tris.push([v(idx[i]!), v(idx[i + 1]!), v(idx[i + 2]!)]);
      const local = convexOf(tris, true);
      // Convex only if every vertex is inside every face's plane.
      const verts = Array.from({ length: pos.length / 3 }, (_, i) => v(i));
      const convex =
        local !== null && local.planes.every((h) => verts.every((q) => dot(h.n, q) - h.d <= 1e-6 * (1 + Math.abs(h.d))));
      if (!convex) return boundsPart(op, m);
      const c = placed(tris, m, true);
      return c ? [{ body: c, minus: [] }] : [];
    }
    case 'revolve':
    default:
      return boundsPart(op, m);
  }
}

// ---------------------------------------------------------------------------
// Keys and caches
// ---------------------------------------------------------------------------

function fnv(s: string): string {
  // 2 × 32-bit FNV-1a, enough that two different ops do not share a key.
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193 ^ s.length;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x5bd1e995);
  }
  return (h1 >>> 0).toString(36) + (h2 >>> 0).toString(36) + s.length.toString(36);
}

function opKey(op: BuildOp): string {
  return fnv(
    JSON.stringify(op, (_k, v: unknown) =>
      v instanceof Float32Array || v instanceof Uint32Array ? `ta:${fnv(Array.from(v).join(','))}` : v,
    ),
  );
}

const SHAPE_CACHE_SIZE = 512;
const PAIR_CACHE_SIZE = 4096;
const shapeCache = new Map<string, ClashShape>();
const pairCache = new Map<string, ClashHit | null>();

function lruGet<K, V>(m: Map<K, V>, k: K): V | undefined {
  const v = m.get(k);
  if (v !== undefined) {
    m.delete(k);
    m.set(k, v);
  }
  return v;
}

function lruSet<K, V>(m: Map<K, V>, k: K, v: V, cap: number): void {
  m.set(k, v);
  if (m.size > cap) m.delete(m.keys().next().value as K);
}

/** Counters for the timing spec and for tuning. */
export const clashStats = { shapesBuilt: 0, pairsTested: 0, pairsCached: 0 };

/** Forget every cached shape and answer (tests time a cold pass with this). */
export function resetClashCache(): void {
  shapeCache.clear();
  pairCache.clear();
  clashStats.shapesBuilt = 0;
  clashStats.pairsTested = 0;
  clashStats.pairsCached = 0;
}

function worst(a: ClashMethod, b: ClashMethod): ClashMethod {
  const rank = { footprint: 0, solid: 1, bounds: 2 } as const;
  return rank[a] >= rank[b] ? a : b;
}

/** The clash model of one op, cached by its content. */
export function shapeOfOp(op: BuildOp, opts: { transient?: boolean } = {}): ClashShape {
  const key = opKey(op);
  const hit = lruGet(shapeCache, key);
  if (hit) return hit;
  clashStats.shapesBuilt++;
  const parts = partsOf(op, IDENTITY);
  let box: Aabb | null = null;
  let method: ClashMethod = 'solid';
  for (const p of parts) {
    box = unionBox(box, p.body.box);
    if (!p.body.exact) method = 'bounds';
  }
  const shape: ClashShape = { key, parts, box, method, ...(opts.transient ? { transient: true } : {}) };
  // A trial shape (one step of a move search) is used once: caching it would
  // only push out the case's own features.
  if (!opts.transient) lruSet(shapeCache, key, shape, SHAPE_CACHE_SIZE);
  return shape;
}

/** A flat feature: convex outlines in world XY, standing from z0 to z1. */
export function footprintShape(polys: Vec2[][], z0: number, z1: number): ClashShape {
  const clean = polys.filter((p) => p.length >= 3).map((p) => (isConvex2(p) ? ccw(p) : hull2(p)));
  const key = fnv(`fp:${JSON.stringify(clean)}:${z0}:${z1}`);
  const hit = lruGet(shapeCache, key);
  if (hit) return hit;
  clashStats.shapesBuilt++;
  const parts: Part[] = [];
  let box: Aabb | null = null;
  for (const p of clean) {
    const c = convexOf(prismFaces(p, z0, z1), true);
    if (!c) continue;
    parts.push({ body: c, minus: [] });
    box = unionBox(box, c.box);
  }
  const shape: ClashShape = { key, parts, box, method: 'footprint', footprint: { polys: clean, z0, z1 } };
  lruSet(shapeCache, key, shape, SHAPE_CACHE_SIZE);
  return shape;
}

/** An axis-aligned rectangle footprint. */
export function rectFootprint(x0: number, y0: number, x1: number, y1: number, z0: number, z1: number): ClashShape {
  return footprintShape(
    [
      [
        [x0, y0],
        [x1, y0],
        [x1, y1],
        [x0, y1],
      ],
    ],
    z0,
    z1,
  );
}

// ---------------------------------------------------------------------------
// The question
// ---------------------------------------------------------------------------

export interface ClashHit {
  /** How the answer was reached: the real solids, two footprints, or a stand-in box. */
  method: ClashMethod;
  /** The overlap's bounding box, world mm. */
  min: Vec3;
  max: Vec3;
  size: Vec3;
  centre: Vec3;
  /**
   * The overlap as convex pieces' boxes (their union is the overlap). A swept
   * feature projects these onto its sweep axis to find every position that
   * clears in one test.
   */
  pieces: Aabb[];
}

function clip2(subject: Vec2[], clipper: Vec2[]): Vec2[] {
  let out = subject;
  for (let i = 0; i < clipper.length && out.length > 0; i++) {
    const a = clipper[i]!;
    const b = clipper[(i + 1) % clipper.length]!;
    const side = (p: Vec2) => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
    const inp = out;
    out = [];
    for (let j = 0; j < inp.length; j++) {
      const p = inp[j]!;
      const q = inp[(j + 1) % inp.length]!;
      const sp = side(p);
      const sq = side(q);
      if (sp >= -EPS) out.push(p);
      if ((sp < -EPS && sq > EPS) || (sp > EPS && sq < -EPS)) {
        const t = sp / (sp - sq);
        out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
      }
    }
  }
  return out;
}

function hitOf(box: Aabb, method: ClashMethod, pieces: Aabb[]): ClashHit {
  const size: Vec3 = [box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]];
  return {
    method,
    min: box.min,
    max: box.max,
    size,
    centre: [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, (box.min[2] + box.max[2]) / 2],
    pieces,
  };
}

function footprintClash(a: NonNullable<ClashShape['footprint']>, b: NonNullable<ClashShape['footprint']>): ClashHit | null {
  const z0 = Math.max(a.z0, b.z0);
  const z1 = Math.min(a.z1, b.z1);
  if (z1 - z0 < MIN_OVERLAP) return null;
  let box: Aabb | null = null;
  const pieces: Aabb[] = [];
  for (const p of a.polys)
    for (const q of b.polys) {
      const r = clip2(p, q);
      if (r.length < 3 || Math.abs(area2(r)) < MIN_OVERLAP * MIN_OVERLAP) continue;
      const xs = r.map((v) => v[0]);
      const ys = r.map((v) => v[1]);
      const bx: Aabb = { min: [Math.min(...xs), Math.min(...ys), z0], max: [Math.max(...xs), Math.max(...ys), z1] };
      if (bx.max[0] - bx.min[0] < MIN_OVERLAP || bx.max[1] - bx.min[1] < MIN_OVERLAP) continue;
      box = unionBox(box, bx);
      pieces.push(bx);
    }
  return box ? hitOf(box, 'footprint', pieces) : null;
}

function solidClash(a: ClashShape, b: ClashShape): ClashHit | null {
  let box: Aabb | null = null;
  const boxes: Aabb[] = [];
  let method: ClashMethod = 'solid';
  for (const pa of a.parts)
    for (const pb of b.parts) {
      const p = intersectConvex(pa.body, pb.body);
      if (!p) continue;
      let pieces: Convex[] = [p];
      for (const g of [...pa.minus, ...pb.minus]) {
        const next = subtractGroup(pieces, g);
        if (next === null) {
          method = 'bounds';
          continue;
        }
        pieces = next;
        if (pieces.length === 0) break;
      }
      for (const q of pieces) {
        box = unionBox(box, q.box);
        boxes.push(q.box);
      }
      if (pieces.length > 0 && (!pa.body.exact || !pb.body.exact)) method = 'bounds';
    }
  return box ? hitOf(box, method, boxes) : null;
}

/** Do two shapes intersect, and if so where and how much. Cached by the pair. */
export function shapesClash(a: ClashShape, b: ClashShape): ClashHit | null {
  if (!a.box || !b.box || !boxesMeet(a.box, b.box, MIN_OVERLAP / 2)) return null;
  const key = a.key < b.key ? `${a.key}|${b.key}` : `${b.key}|${a.key}`;
  const cached = pairCache.get(key);
  if (cached !== undefined) {
    clashStats.pairsCached++;
    return cached;
  }
  clashStats.pairsTested++;
  const hit = a.footprint && b.footprint ? footprintClash(a.footprint, b.footprint) : solidClash(a, b);
  if (!a.transient && !b.transient) lruSet(pairCache, key, hit, PAIR_CACHE_SIZE);
  return hit;
}

// ---------------------------------------------------------------------------
// Features
// ---------------------------------------------------------------------------

/** What a feature is, so a caller can pick the pairs it cares about. */
export type ClashKind =
  | 'board'
  | 'standoff'
  | 'port'
  | 'latch'
  | 'hinge'
  | 'lid'
  | 'lid-lip'
  | 'vent'
  | 'hat'
  | 'seam'
  | 'magnet'
  | 'nameplate'
  | 'floor-grid'
  | 'brim'
  | 'ribbing'
  | 'socket'
  | 'divider'
  | 'other';

export interface ClashFeature {
  id: string;
  kind: ClashKind;
  /** How a statement names it: "a board standoff", "the USB-C cutout". */
  label: string;
  shapes: ClashShape[];
  box: Aabb | null;
}

export function feature(id: string, kind: ClashKind, label: string, shapes: ClashShape[]): ClashFeature {
  let box: Aabb | null = null;
  for (const s of shapes) box = unionBox(box, s.box);
  return { id, kind, label, shapes, box };
}

export function featureOfOps(id: string, kind: ClashKind, label: string, ops: BuildOp[]): ClashFeature {
  return feature(id, kind, label, ops.map((op) => shapeOfOp(op)));
}

/** Where two features meet, or null. The overlap box covers every shape pair that clashed. */
export function interiorClash(a: ClashFeature, b: ClashFeature): ClashHit | null {
  if (!a.box || !b.box || !boxesMeet(a.box, b.box, MIN_OVERLAP / 2)) return null;
  let box: Aabb | null = null;
  let method: ClashMethod | null = null;
  const pieces: Aabb[] = [];
  for (const sa of a.shapes)
    for (const sb of b.shapes) {
      const h = shapesClash(sa, sb);
      if (!h) continue;
      box = unionBox(box, { min: h.min, max: h.max });
      pieces.push(...h.pieces);
      method = method ? worst(method, h.method) : h.method;
    }
  return box && method ? hitOf(box, method, pieces) : null;
}

/** Every feature in `others` that `subject` runs into, with where. */
export function clashesWith(
  subject: ClashFeature,
  others: readonly ClashFeature[],
): { with: ClashFeature; hit: ClashHit }[] {
  const out: { with: ClashFeature; hit: ClashHit }[] = [];
  for (const o of others) {
    if (o.id === subject.id) continue;
    const hit = interiorClash(subject, o);
    if (hit) out.push({ with: o, hit });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

const r1 = (v: number): string => `${Math.round(v * 10) / 10 || 0}`;

/** "1.2 × 0.8 × 3 mm around X 12.3, Y 4.5, Z 8 mm" — the overlap, in the panel's words. */
export function describeOverlap(h: ClashHit): string {
  return `${r1(h.size[0])} × ${r1(h.size[1])} × ${r1(h.size[2])} mm around X ${r1(h.centre[0])}, Y ${r1(h.centre[1])}, Z ${r1(h.centre[2])} mm`;
}

/** The method, for a tooltip. */
export const METHOD_NAME: Record<ClashMethod, string> = {
  solid: 'Checked against the real solids.',
  footprint: 'Checked by footprint and height band.',
  bounds: 'Checked partly by bounding box: part of a shape could not be read exactly.',
};
