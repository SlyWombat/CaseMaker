/**
 * #968 — A STROKE WITH A WIDTH IS A REGION, not a centre line.
 *
 * SVG paints a stroke as a band `stroke-width` wide, centred on the path. Makera Studio imports an
 * SVG the same way and raster-clears that band; our importer used to read the centre line, which is
 * a different operation and scored every stroke as up to half a width wrong (#955's coasters
 * finding). This module turns one flattened subpath plus its stroke style into the band's region:
 *
 *  - an OPEN subpath becomes ONE closed contour: the left offset forward, the end cap, the right
 *    offset backward, the start cap;
 *  - a CLOSED subpath becomes ONE contour (a keyhole annulus): the outer offset ring, a zero-width
 *    bridge, the inner ring wound the other way, the bridge back. The NonZero fill rule reads it as
 *    the band with its hole, and the region count stays one per stroke.
 *
 * The joins are SVG's own: miter (with `stroke-miterlimit`), round or bevel; the caps are butt,
 * round or square. Curves are already flattened by the caller, so this is polyline geometry: no
 * clipper, no dependency, deterministic. The stroke width is the caller's, in the SAME units as
 * `points`; the caller converts to mm.
 *
 * Prior art read as a reference only (no code copied): SVG 1.1 §11's stroke geometry (offset,
 * join and cap definitions).
 */
import type { Vec2 } from '@/types';

export type StrokeCap = 'butt' | 'round' | 'square';
export type StrokeJoin = 'miter' | 'round' | 'bevel';

export interface StrokeStyle {
  /** The full band width, in the same units as the points. */
  width: number;
  cap?: StrokeCap;
  join?: StrokeJoin;
  /** SVG's `stroke-miterlimit`, in multiples of half the width; default 4. */
  miterLimit?: number;
  /** Chord tolerance for round joins/caps, in the points' units; default 0.02. */
  tolerance?: number;
}

const EPS = 1e-9;

function unit(dx: number, dy: number): Vec2 | null {
  const l = Math.hypot(dx, dy);
  return l > EPS ? [dx / l, dy / l] : null;
}

function leftNormal(d: Vec2): Vec2 {
  return [-d[1], d[0]];
}

function lineIntersect(p1: Vec2, d1: Vec2, p2: Vec2, d2: Vec2): Vec2 | null {
  const den = d1[0] * d2[1] - d1[1] * d2[0];
  if (Math.abs(den) < 1e-9) return null;
  const t = ((p2[0] - p1[0]) * d2[1] - (p2[1] - p1[1]) * d2[0]) / den;
  return [p1[0] + d1[0] * t, p1[1] + d1[1] * t];
}

function signedArea(points: readonly Vec2[]): number {
  let a = 0;
  for (let i = 0; i < points.length; i++) {
    const [x0, y0] = points[i]!;
    const [x1, y1] = points[(i + 1) % points.length]!;
    a += x0 * y1 - x1 * y0;
  }
  return a / 2;
}

/** Points along a circular arc from `from` to `to` about `center`, the short way (≤ π). */
function arcPoints(center: Vec2, from: Vec2, to: Vec2, radius: number, tolerance: number): Vec2[] {
  const a0 = Math.atan2(from[1] - center[1], from[0] - center[0]);
  let delta = Math.atan2(to[1] - center[1], to[0] - center[0]) - a0;
  while (delta > Math.PI) delta -= 2 * Math.PI;
  while (delta < -Math.PI) delta += 2 * Math.PI;
  if (Math.abs(delta) < EPS) return [];
  const ratio = Math.min(1, tolerance / Math.max(radius, EPS));
  const step = ratio >= 1 ? Math.PI / 4 : 2 * Math.acos(1 - ratio);
  const n = Math.min(256, Math.max(1, Math.ceil(Math.abs(delta) / step)));
  const out: Vec2[] = [];
  for (let i = 1; i < n; i++) {
    const t = a0 + (delta * i) / n;
    out.push([center[0] + radius * Math.cos(t), center[1] + radius * Math.sin(t)]);
  }
  return out;
}

/** Dedupe consecutive points (and a repeated closing point) so every segment has a direction. */
function clean(points: readonly Vec2[], closed: boolean): Vec2[] {
  const out: Vec2[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last && Math.hypot(p[0] - last[0], p[1] - last[1]) <= EPS) continue;
    out.push([p[0], p[1]]);
  }
  if (closed && out.length > 1) {
    const first = out[0]!;
    const last = out[out.length - 1]!;
    if (Math.hypot(first[0] - last[0], first[1] - last[1]) <= EPS) out.pop();
  }
  return out;
}

/** The boundary of one side of the band: segment offsets joined at every vertex. */
function offsetSide(
  points: readonly Vec2[],
  dirs: readonly Vec2[],
  closed: boolean,
  side: 1 | -1,
  half: number,
  style: StrokeStyle,
): Vec2[] {
  const join = style.join ?? 'miter';
  const miterLimit = style.miterLimit ?? 4;
  const tolerance = style.tolerance ?? 0.02;
  const n = points.length;
  const segCount = dirs.length;
  const out: Vec2[] = [];

  const offsetAt = (p: Vec2, d: Vec2): Vec2 => {
    const nrm = leftNormal(d);
    return [p[0] + nrm[0] * side * half, p[1] + nrm[1] * side * half];
  };

  const joinAt = (p: Vec2, dPrev: Vec2, dNext: Vec2): void => {
    const oa = offsetAt(p, dPrev);
    const ob = offsetAt(p, dNext);
    const cross = dPrev[0] * dNext[1] - dPrev[1] * dNext[0];
    const outer = cross * side < 0;
    if (!outer) {
      const m = lineIntersect(oa, dPrev, ob, dNext);
      if (m) out.push(m);
      else out.push(oa, ob);
      return;
    }
    if (join === 'bevel') {
      out.push(oa, ob);
      return;
    }
    if (join === 'round') {
      out.push(oa, ...arcPoints(p, oa, ob, half, tolerance), ob);
      return;
    }
    const m = lineIntersect(oa, dPrev, ob, dNext);
    if (m && Math.hypot(m[0] - p[0], m[1] - p[1]) <= miterLimit * half + EPS) out.push(m);
    else out.push(oa, ob);
  };

  if (closed) {
    for (let i = 0; i < segCount; i++) {
      const p = points[i]!;
      joinAt(p, dirs[(i - 1 + segCount) % segCount]!, dirs[i]!);
    }
  } else {
    out.push(offsetAt(points[0]!, dirs[0]!));
    for (let i = 1; i < segCount; i++) joinAt(points[i]!, dirs[i - 1]!, dirs[i]!);
    out.push(offsetAt(points[n - 1]!, dirs[segCount - 1]!));
  }
  return out;
}

function capPoints(
  center: Vec2,
  inward: Vec2,
  from: Vec2,
  to: Vec2,
  cap: StrokeCap,
  half: number,
  tolerance: number,
): Vec2[] {
  if (cap === 'square') {
    const a: Vec2 = [from[0] + inward[0] * half, from[1] + inward[1] * half];
    const b: Vec2 = [to[0] + inward[0] * half, to[1] + inward[1] * half];
    return [a, b];
  }
  if (cap === 'round') {
    // The semicircle through `inward`: pick the arc whose midpoint lies on the inward side.
    let delta = Math.atan2(to[1] - center[1], to[0] - center[0])
      - Math.atan2(from[1] - center[1], from[0] - center[0]);
    while (delta > Math.PI) delta -= 2 * Math.PI;
    while (delta < -Math.PI) delta += 2 * Math.PI;
    const mid = Math.atan2(from[1] - center[1], from[0] - center[0]) + delta / 2;
    if (Math.cos(mid) * inward[0] + Math.sin(mid) * inward[1] < 0) {
      delta = delta > 0 ? delta - 2 * Math.PI : delta + 2 * Math.PI;
    }
    const ratio = Math.min(1, tolerance / Math.max(half, EPS));
    const step = ratio >= 1 ? Math.PI / 4 : 2 * Math.acos(1 - ratio);
    const n = Math.min(256, Math.max(1, Math.ceil(Math.abs(delta) / step)));
    const a0 = Math.atan2(from[1] - center[1], from[0] - center[0]);
    const out: Vec2[] = [];
    for (let i = 1; i < n; i++) {
      const t = a0 + (delta * i) / n;
      out.push([center[0] + half * Math.cos(t), center[1] + half * Math.sin(t)]);
    }
    return out;
  }
  return [];
}

/**
 * The region a stroke paints, as one contour per subpath: an open polyline's band, or a closed
 * ring's keyhole annulus. Empty when the geometry is degenerate or the width is not positive.
 */
export function strokeBand(points: readonly Vec2[], closed: boolean, style: StrokeStyle): Vec2[][] {
  const half = style.width / 2;
  if (!(half > 0)) return [];
  const pts = clean(points, closed);
  if (closed ? pts.length < 3 : pts.length < 2) return [];

  const dirs: Vec2[] = [];
  const segCount = closed ? pts.length : pts.length - 1;
  for (let i = 0; i < segCount; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % pts.length]!;
    const d = unit(b[0] - a[0], b[1] - a[1]);
    if (d === null) return [];
    dirs.push(d);
  }

  if (closed) {
    // The outer side is the one away from the interior. A CCW ring (positive area) has its
    // interior on the left, so the outer offset is the RIGHT side, and vice versa.
    const ccw = signedArea(pts) > 0;
    const outerSide: 1 | -1 = ccw ? -1 : 1;
    const outer = offsetSide(pts, dirs, true, outerSide, half, style);
    const inner = offsetSide(pts, dirs, true, -outerSide as 1 | -1, half, style);
    if (outer.length < 3 || inner.length < 3) return [];
    const innerRev = inner.slice().reverse();
    // Keyhole: outer ring, bridge, inner ring reversed, bridge back (the closing edge).
    return [[...outer, outer[0]!, ...innerRev, innerRev[0]!]];
  }

  const left = offsetSide(pts, dirs, false, 1, half, style);
  const right = offsetSide(pts, dirs, false, -1, half, style);
  if (left.length < 2 || right.length < 2) return [];

  const first = pts[0]!;
  const last = pts[pts.length - 1]!;
  const d0 = dirs[0]!;
  const dN = dirs[dirs.length - 1]!;
  const cap = style.cap ?? 'butt';
  const tol = style.tolerance ?? 0.02;

  const endCap = capPoints(
    last,
    [dN[0], dN[1]],
    left[left.length - 1]!,
    right[right.length - 1]!,
    cap,
    half,
    tol,
  );
  const startCap = capPoints(
    first,
    [-d0[0], -d0[1]],
    right[0]!,
    left[0]!,
    cap,
    half,
    tol,
  );

  const contour: Vec2[] = [
    ...left,
    ...endCap,
    ...right.slice().reverse(),
    ...startCap,
  ];
  return contour.length >= 3 ? [contour] : [];
}
