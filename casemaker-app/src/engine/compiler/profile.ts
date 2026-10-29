import type { Vec2 } from '@/types';

/**
 * 2D cross-sections, evaluated by Manifold's CrossSection (Clipper2) in the
 * geometry worker.
 *
 * Profiles are the missing half of the build vocabulary. Nearly every feature
 * in this codebase is prismatic — ribs, gussets, ledges, cleats, snap barbs,
 * keyholes, lightening pockets are all a 2D outline plus a thickness. Without
 * a way to say that, they came out as stacks of overlapping cubes (see
 * `roundedRectPrism`) or as hand-rolled triangle soup (see `triPrismZ` in
 * rack.ts), and material had to be taken back out in a second pass because
 * there was no way to draw the lightened shape in the first place. Draw the
 * outline once, in the plane it is actually drawn in, then `extrude` it.
 *
 * Profiles are plain serializable data so they ride the BuildOp tree across
 * the worker boundary with no special handling.
 */
export type ProfileJoin = 'round' | 'miter' | 'square';

/** Polygon fill rule, as Manifold names them. */
export type ProfileFillRule = 'EvenOdd' | 'NonZero' | 'Positive' | 'Negative';

export type Profile =
  /**
   * Explicit contours. Even-odd fill by default, so inner contours punch holes
   * whichever way they wind. Pass `fillRule: 'NonZero'` for outlines that carry
   * their own winding (font glyphs): overlapping same-direction contours then
   * UNION instead of cancelling into a hole.
   */
  | { kind: 'p-poly'; contours: Vec2[][]; fillRule?: ProfileFillRule }
  | { kind: 'p-rect'; size: Vec2; center?: boolean }
  | { kind: 'p-circle'; radius: number; segments?: number }
  | { kind: 'p-union'; children: Profile[] }
  | { kind: 'p-difference'; children: Profile[] }
  | { kind: 'p-intersection'; children: Profile[] }
  /**
   * True 2D offset (Clipper2). Positive grows, negative shrinks. This is the
   * one operation with no cube-stacking equivalent: it is what makes shelling,
   * uniform wall thicknesses, and clean fillets-in-plane possible.
   */
  | {
      kind: 'p-offset';
      child: Profile;
      delta: number;
      join?: ProfileJoin;
      miterLimit?: number;
      segments?: number;
    }
  | { kind: 'p-hull'; children: Profile[] }
  | { kind: 'p-translate'; offset: Vec2; child: Profile }
  | { kind: 'p-rotate'; degrees: number; child: Profile }
  /**
   * Non-uniform scale about the origin (#240, R10). The one profile operation a wrap needs: a
   * rotary engraving's opening is anisotropic, and scaling the AROUND axis into the floor's own
   * radius turns that opening into an isotropic one that Clipper2 can build.
   */
  | { kind: 'p-scale'; scale: Vec2; child: Profile }
  /**
   * Reflect across the line through the origin whose NORMAL is `normal`
   * (so [1, 0] flips x, [0, 1] flips y).
   */
  | { kind: 'p-mirror'; normal: Vec2; child: Profile };

// ---- Constructors -----------------------------------------------------------

/** Closed polygon from a point ring. */
export function poly(points: Vec2[]): Profile {
  return { kind: 'p-poly', contours: [points] };
}

/** Outer ring plus hole rings (even-odd fill). */
export function polyWithHoles(outer: Vec2[], holes: Vec2[][]): Profile {
  return { kind: 'p-poly', contours: [outer, ...holes] };
}

/** Axis-aligned rectangle; bbox-min at the origin unless `center`. */
export function rectProfile(width: number, height: number, center = false): Profile {
  return { kind: 'p-rect', size: [width, height], center };
}

export function circleProfile(radius: number, segments?: number): Profile {
  return { kind: 'p-circle', radius, segments };
}

/**
 * Rectangle with all four corners rounded to `radius`, as a real arc rather
 * than a union of corner cylinders. Origin convention matches `rectProfile`:
 * bbox-min at (0, 0), body out to (width, height).
 */
export function roundedRect(width: number, height: number, radius: number): Profile {
  const r = Math.min(radius, width / 2, height / 2);
  if (r <= 0) return rectProfile(width, height);
  return pOffset(
    pTranslate([r, r], rectProfile(width - 2 * r, height - 2 * r)),
    r,
    'round',
  );
}

/**
 * Isosceles-trapezoid outline — the workhorse for anything with draft: snap
 * barb lead-ins, printable overhang transitions, dovetail pins. Bbox-min at
 * the origin, `baseW` at y = 0 narrowing (or widening) to `topW` at y = height.
 */
export function trapezoid(baseW: number, topW: number, height: number): Profile {
  const dx = (baseW - topW) / 2;
  return poly([
    [0, 0],
    [baseW, 0],
    [baseW - dx, height],
    [dx, height],
  ]);
}

// ---- Combinators ------------------------------------------------------------

export function pUnion(children: Profile[]): Profile {
  return { kind: 'p-union', children };
}

export function pDifference(children: Profile[]): Profile {
  return { kind: 'p-difference', children };
}

export function pIntersection(children: Profile[]): Profile {
  return { kind: 'p-intersection', children };
}

export function pOffset(
  child: Profile,
  delta: number,
  join: ProfileJoin = 'round',
  opts: { miterLimit?: number; segments?: number } = {},
): Profile {
  return { kind: 'p-offset', child, delta, join, ...opts };
}

/** Convex hull — the cheap way to blend a boss into a wall or loft a gusset. */
export function pHull(children: Profile[]): Profile {
  return { kind: 'p-hull', children };
}

export function pTranslate(offset: Vec2, child: Profile): Profile {
  return { kind: 'p-translate', offset, child };
}

export function pRotate(degrees: number, child: Profile): Profile {
  return { kind: 'p-rotate', degrees, child };
}

/**
 * Scale each axis independently about the origin (#240). A NEGATIVE factor mirrors, and the
 * bounds function swaps that axis' corners to match.
 */
export function pScale(scale: Vec2, child: Profile): Profile {
  return { kind: 'p-scale', scale, child };
}

export function pMirror(normal: Vec2, child: Profile): Profile {
  return { kind: 'p-mirror', normal, child };
}

/** Reflect about the vertical line x = at — the chiral-pair workhorse. */
export function pMirrorX(child: Profile, at = 0): Profile {
  return pTranslate([at, 0], pMirror([1, 0], pTranslate([-at, 0], child)));
}

/** Reflect about the horizontal line y = at. */
export function pMirrorY(child: Profile, at = 0): Profile {
  return pTranslate([0, at], pMirror([0, 1], pTranslate([0, -at], child)));
}

/**
 * Shell a profile to a uniform wall: the original minus its inward offset.
 * `difference([slab, extrude(shellProfile(outline, wall), t)])` is a hollow
 * prismatic part with no hand-computed inner contour.
 */
export function shellProfile(outline: Profile, wall: number): Profile {
  return pDifference([outline, pOffset(outline, -wall, 'miter')]);
}

// ---- Bounds -----------------------------------------------------------------

export interface Aabb2 {
  min: Vec2;
  max: Vec2;
}

/**
 * Conservative 2D bounds. Over-covers but never under-covers, matching
 * `aabbOfOp`'s contract — negative offsets keep the un-shrunk box rather than
 * guessing how far a concave region actually pulls in.
 */
export function aabbOfProfile(p: Profile): Aabb2 | null {
  switch (p.kind) {
    case 'p-poly': {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const contour of p.contours)
        for (const [x, y] of contour) {
          if (x < minX) minX = x;
          if (y < minY) minY = y;
          if (x > maxX) maxX = x;
          if (y > maxY) maxY = y;
        }
      return minX === Infinity ? null : { min: [minX, minY], max: [maxX, maxY] };
    }
    case 'p-rect': {
      const [w, h] = p.size;
      return p.center
        ? { min: [-w / 2, -h / 2], max: [w / 2, h / 2] }
        : { min: [0, 0], max: [w, h] };
    }
    case 'p-circle':
      return { min: [-p.radius, -p.radius], max: [p.radius, p.radius] };
    case 'p-union':
    case 'p-hull': {
      let out: Aabb2 | null = null;
      for (const c of p.children) {
        const b = aabbOfProfile(c);
        if (!b) continue;
        out = out ? mergeAabb2(out, b) : b;
      }
      return out;
    }
    case 'p-difference':
      return p.children[0] ? aabbOfProfile(p.children[0]) : null;
    case 'p-intersection': {
      let out: Aabb2 | null = null;
      for (const c of p.children) {
        const b = aabbOfProfile(c);
        if (!b) continue;
        if (!out) out = b;
        else
          out = {
            min: [Math.max(out.min[0], b.min[0]), Math.max(out.min[1], b.min[1])],
            max: [Math.min(out.max[0], b.max[0]), Math.min(out.max[1], b.max[1])],
          };
      }
      return out;
    }
    case 'p-offset': {
      const b = aabbOfProfile(p.child);
      if (!b) return null;
      const g = Math.max(p.delta, 0);
      return { min: [b.min[0] - g, b.min[1] - g], max: [b.max[0] + g, b.max[1] + g] };
    }
    case 'p-translate': {
      const b = aabbOfProfile(p.child);
      if (!b) return null;
      const [dx, dy] = p.offset;
      return { min: [b.min[0] + dx, b.min[1] + dy], max: [b.max[0] + dx, b.max[1] + dy] };
    }
    case 'p-mirror': {
      const b = aabbOfProfile(p.child);
      if (!b) return null;
      // Reflect all four corners across the axis line through the origin.
      const [nx, ny] = p.normal;
      const len2 = nx * nx + ny * ny;
      if (!len2) return b;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const x of [b.min[0], b.max[0]])
        for (const y of [b.min[1], b.max[1]]) {
          // Reflect across the plane through the origin with this normal.
          const d = (2 * (x * nx + y * ny)) / len2;
          const rx = x - d * nx;
          const ry = y - d * ny;
          if (rx < minX) minX = rx;
          if (ry < minY) minY = ry;
          if (rx > maxX) maxX = rx;
          if (ry > maxY) maxY = ry;
        }
      return { min: [minX, minY], max: [maxX, maxY] };
    }
    case 'p-scale': {
      const b = aabbOfProfile(p.child);
      if (!b) return null;
      // Scaling maps corners to corners; a negative factor swaps which corner is the min, so take
      // the min/max of the two mapped values on each axis rather than assuming the sign.
      const [sx, sy] = p.scale;
      return {
        min: [Math.min(b.min[0] * sx, b.max[0] * sx), Math.min(b.min[1] * sy, b.max[1] * sy)],
        max: [Math.max(b.min[0] * sx, b.max[0] * sx), Math.max(b.min[1] * sy, b.max[1] * sy)],
      };
    }
    case 'p-rotate': {
      const b = aabbOfProfile(p.child);
      if (!b) return null;
      const a = (p.degrees * Math.PI) / 180;
      const c = Math.cos(a);
      const s = Math.sin(a);
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const x of [b.min[0], b.max[0]])
        for (const y of [b.min[1], b.max[1]]) {
          const rx = x * c - y * s;
          const ry = x * s + y * c;
          if (rx < minX) minX = rx;
          if (ry < minY) minY = ry;
          if (rx > maxX) maxX = rx;
          if (ry > maxY) maxY = ry;
        }
      return { min: [minX, minY], max: [maxX, maxY] };
    }
  }
}

/**
 * #743 — HOW FAR any point of `profile` can lie from `point`: an UPPER bound, read off the
 * profile's own expression tree. The round-stock check needs it because a region's bounding
 * RECTANGLE is not its reach: a ⌀26 pocket centred in a ⌀30 disc has box corners 8 mm outside the
 * rim it never enters, and a corner test would refuse a cut that is entirely inside the circle.
 *
 * Conservative where the tree does not say:
 *
 *   - a DIFFERENCE is inside its FIRST child (the shape being cut away from);
 *   - an INTERSECTION is inside EVERY child, so the nearest of their bounds holds;
 *   - a UNION or HULL is inside the farthest child;
 *   - an OFFSET never reaches past its child plus a positive delta (a negative delta only
 *     shrinks, so the child's own bound is already safe);
 *   - the transforms recurse with the query point moved by their inverse — rotation and
 *     reflection are rigid, and a scale multiplies the bound by its largest factor.
 */
export function profileReachFrom(p: Profile, point: Vec2): number {
  const from = (x: number, y: number): number => Math.hypot(x - point[0], y - point[1]);
  switch (p.kind) {
    case 'p-poly': {
      let max = 0;
      for (const contour of p.contours) for (const [x, y] of contour) max = Math.max(max, from(x, y));
      return max;
    }
    case 'p-rect': {
      const [w, h] = p.size;
      const x0 = p.center ? -w / 2 : 0;
      const x1 = p.center ? w / 2 : w;
      const y0 = p.center ? -h / 2 : 0;
      const y1 = p.center ? h / 2 : h;
      return Math.max(from(x0, y0), from(x1, y0), from(x0, y1), from(x1, y1));
    }
    case 'p-circle':
      // A bare circle is centred on the origin; placement is a `p-translate` around it.
      return Math.hypot(point[0], point[1]) + p.radius;
    case 'p-union':
    case 'p-hull':
      return p.children.reduce((m, c) => Math.max(m, profileReachFrom(c, point)), 0);
    case 'p-difference':
      return p.children[0] ? profileReachFrom(p.children[0], point) : 0;
    case 'p-intersection':
      if (p.children.length === 0) return 0;
      return p.children.reduce((m, c) => Math.min(m, profileReachFrom(c, point)), Infinity);
    case 'p-offset':
      return profileReachFrom(p.child, point) + Math.max(0, p.delta);
    case 'p-translate':
      return profileReachFrom(p.child, [point[0] - p.offset[0], point[1] - p.offset[1]]);
    case 'p-rotate': {
      const a = (p.degrees * Math.PI) / 180;
      const c = Math.cos(a);
      const s = Math.sin(a);
      return profileReachFrom(p.child, [point[0] * c + point[1] * s, -point[0] * s + point[1] * c]);
    }
    case 'p-mirror': {
      const [nx, ny] = p.normal;
      const len2 = nx * nx + ny * ny;
      if (!len2) return profileReachFrom(p.child, point);
      const d = (2 * (point[0] * nx + point[1] * ny)) / len2;
      return profileReachFrom(p.child, [point[0] - d * nx, point[1] - d * ny]);
    }
    case 'p-scale': {
      const [sx, sy] = p.scale;
      if (sx === 0 || sy === 0) {
        // A collapsed axis has no inverse; the bounding box's corners are still a safe answer.
        const b = aabbOfProfile(p);
        if (!b) return 0;
        return Math.max(from(b.min[0], b.min[1]), from(b.max[0], b.min[1]), from(b.min[0], b.max[1]), from(b.max[0], b.max[1]));
      }
      return Math.max(Math.abs(sx), Math.abs(sy)) * profileReachFrom(p.child, [point[0] / sx, point[1] / sy]);
    }
  }
}

function mergeAabb2(a: Aabb2, b: Aabb2): Aabb2 {
  return {
    min: [Math.min(a.min[0], b.min[0]), Math.min(a.min[1], b.min[1])],
    max: [Math.max(a.max[0], b.max[0]), Math.max(a.max[1], b.max[1])],
  };
}

// ---- Lightening -------------------------------------------------------------

export interface LightenOptions {
  /** Solid rim left inside the outline. */
  rim: number;
  /** Rib thickness. */
  rib: number;
  /** Rib centre-to-centre pitch. */
  pitch: number;
  /** Lattice angle in degrees; 45 gives the usual diagonal truss. */
  angle?: number;
  /** Cross the ribs at ±angle for a triangular lattice (default true). */
  cross?: boolean;
  /** Regions to leave solid — screw bosses, hinge roots, snap-jaw roots. */
  keepOut?: Profile[];
}

/**
 * The *pocket* profile that lightens a prismatic part: everything inside
 * `outline` except a solid rim, a rib lattice, and any keep-outs. Cut it with
 * `difference([slab, extrude(lightenPocket(outline, opts), depth)])`.
 *
 * This exists so lightening is part of drawing the part rather than a second
 * pass bolted on afterwards — the rim, the ribs, and the bosses that must stay
 * solid are all stated once, in the outline's own plane.
 */
/**
 * The rib bars a lightenPocket leaves behind, one Profile per angle.
 *
 * Exposed so callers can build ON the lattice they just cut — raising one
 * diagonal family to stand proud, say. Anything that has to line up with the
 * lattice must come from here rather than being reconstructed, or it lands
 * fractionally off and the two patterns fight.
 */
export function lightenBars(outline: Profile, opts: LightenOptions): Profile[] {
  const { rib, pitch, angle = 45, cross = true } = opts;
  const b = aabbOfProfile(outline);
  if (!b) return [];
  const w = b.max[0] - b.min[0];
  const h = b.max[1] - b.min[1];
  const cx = (b.min[0] + b.max[0]) / 2;
  const cy = (b.min[1] + b.max[1]) / 2;
  // Bars long enough to cross the field at any angle, centred on the outline.
  const span = Math.hypot(w, h) + 2 * pitch;
  const n = Math.ceil(span / pitch);
  return (cross ? [angle, -angle] : [angle]).map((a) => {
    const strip: Profile[] = [];
    for (let i = -n; i <= n; i++) {
      strip.push(pTranslate([-span / 2, i * pitch - rib / 2], rectProfile(span, rib)));
    }
    return pTranslate([cx, cy], pRotate(a, pUnion(strip)));
  });
}

export function lightenPocket(outline: Profile, opts: LightenOptions): Profile {
  const { rim, keepOut = [] } = opts;
  const field = pOffset(outline, -rim, 'miter');
  if (!aabbOfProfile(outline)) return field;
  return pDifference([field, ...lightenBars(outline, opts), ...keepOut]);
}
