import type { Vec3, Vec2, Facing } from '@/types';
import { aabbOfProfile, type Profile } from './profile';

export type { Profile } from './profile';
export * from './profile';

export type BuildOp =
  | { kind: 'cube'; size: Vec3; center?: boolean }
  | {
      kind: 'cylinder';
      height: number;
      radiusLow: number;
      radiusHigh?: number;
      segments?: number;
      center?: boolean;
    }
  | { kind: 'translate'; offset: Vec3; child: BuildOp }
  | { kind: 'rotate'; degrees: Vec3; child: BuildOp }
  | { kind: 'scale'; factor: number; child: BuildOp }
  | { kind: 'mesh'; positions: Float32Array; indices: Uint32Array }
  | { kind: 'union'; children: BuildOp[] }
  | { kind: 'difference'; children: BuildOp[] }
  | { kind: 'intersection'; children: BuildOp[] }
  /**
   * Extrude a 2D profile along +Z. `scaleTop` tapers the far end (a scalar or
   * per-axis pair), which is how draft, snap-barb lead-ins and printable
   * overhang transitions get built without hand-rolling triangle soup.
   */
  | {
      kind: 'extrude';
      profile: Profile;
      height: number;
      divisions?: number;
      twistDegrees?: number;
      scaleTop?: Vec2 | number;
      center?: boolean;
    }
  /** Revolve a 2D profile about its Y axis, which becomes the solid's Z axis. */
  | { kind: 'revolve'; profile: Profile; degrees?: number; segments?: number }
  /** Convex hull of the children — blends bosses into walls in one call. */
  | { kind: 'hull'; children: BuildOp[] };

export interface BuildNode {
  id: string;
  op: BuildOp;
}

export interface BuildPlan {
  nodes: BuildNode[];
  /** Issue #37 — placement validator findings; consumers may show a banner. */
  placementReport?: import('./placementValidator').PlacementReport;
  /**
   * Issue #51 — smart-cutout decisions taken during this compile. Lives on
   * the plan (not as module-level mutable state in ProjectCompiler) so it
   * stays in sync with the project that produced it.
   */
  smartCutoutDecisions?: import('./smartCutoutLayout').SmartCutoutDecision[];
}

export function cube(size: Vec3, center = false): BuildOp {
  return { kind: 'cube', size, center };
}

export function cylinder(
  height: number,
  radius: number,
  segments = 48,
  center = false,
): BuildOp {
  return { kind: 'cylinder', height, radiusLow: radius, segments, center };
}

export function translate(offset: Vec3, child: BuildOp): BuildOp {
  return { kind: 'translate', offset, child };
}

export function rotate(degrees: Vec3, child: BuildOp): BuildOp {
  return { kind: 'rotate', degrees, child };
}

export function scale(factor: number, child: BuildOp): BuildOp {
  return { kind: 'scale', factor, child };
}

export function mesh(positions: Float32Array, indices: Uint32Array): BuildOp {
  return { kind: 'mesh', positions, indices };
}

/**
 * Issue #45 — axis-aligned cylinder oriented along a face normal. The
 * resulting cylinder is centered on origin in its perpendicular plane and
 * extends from 0 to `length` along the chosen axis. Combine with `translate`
 * to position the centerline.
 *
 * The base `cylinder` primitive only supports the +z axis; previously every
 * compiler that needed a wall-piercing through-hole open re-emitted a
 * bespoke `rotate(cylinder)` switch (roundCutout, antennas, mountingFeatures
 * VESA — the last one shipped the wrong rotation, hence the issue).
 */
export function axisCylinder(
  facing: Facing,
  length: number,
  radius: number,
  segments = 48,
): BuildOp {
  const cyl = cylinder(length, radius, segments);
  switch (facing) {
    case '+z':
      return cyl;
    case '+x':
    case '-x':
      return rotate([0, 90, 0], cyl);
    case '+y':
    case '-y':
      return rotate([-90, 0, 0], cyl);
    default:
      return cyl;
  }
}

export interface Aabb {
  min: Vec3;
  max: Vec3;
}

/**
 * Conservative world-space bounding box of a build op. Rotations transform
 * the child box's corners (applied X→Y→Z), so the result may over-cover but
 * never under-covers. Used for coarse keep-out tests (e.g. ventilation
 * avoiding port cutouts). Returns null for empty composites.
 */
export function aabbOfOp(op: BuildOp): Aabb | null {
  switch (op.kind) {
    case 'cube': {
      const [x, y, z] = op.size;
      return op.center
        ? { min: [-x / 2, -y / 2, -z / 2], max: [x / 2, y / 2, z / 2] }
        : { min: [0, 0, 0], max: [x, y, z] };
    }
    case 'cylinder': {
      const r = Math.max(op.radiusLow, op.radiusHigh ?? op.radiusLow);
      return op.center
        ? { min: [-r, -r, -op.height / 2], max: [r, r, op.height / 2] }
        : { min: [-r, -r, 0], max: [r, r, op.height] };
    }
    case 'mesh': {
      if (!op.positions.length) return null;
      const min: [number, number, number] = [Infinity, Infinity, Infinity];
      const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < op.positions.length; i += 3) {
        for (let a = 0; a < 3; a++) {
          const v = op.positions[i + a]!;
          if (v < min[a]!) min[a] = v;
          if (v > max[a]!) max[a] = v;
        }
      }
      return { min, max };
    }
    case 'translate': {
      const b = aabbOfOp(op.child);
      if (!b) return null;
      const o = op.offset;
      return {
        min: [b.min[0] + o[0], b.min[1] + o[1], b.min[2] + o[2]],
        max: [b.max[0] + o[0], b.max[1] + o[1], b.max[2] + o[2]],
      };
    }
    case 'scale': {
      const b = aabbOfOp(op.child);
      if (!b) return null;
      const f = op.factor;
      return {
        min: [b.min[0] * f, b.min[1] * f, b.min[2] * f],
        max: [b.max[0] * f, b.max[1] * f, b.max[2] * f],
      };
    }
    case 'rotate': {
      const b = aabbOfOp(op.child);
      if (!b) return null;
      const [ax, ay, az] = op.degrees.map((d) => (d * Math.PI) / 180) as [
        number,
        number,
        number,
      ];
      const rot = (v: [number, number, number]): [number, number, number] => {
        let [x, y, z] = v;
        let c = Math.cos(ax);
        let s = Math.sin(ax);
        [y, z] = [y * c - z * s, y * s + z * c];
        c = Math.cos(ay);
        s = Math.sin(ay);
        [x, z] = [x * c + z * s, -x * s + z * c];
        c = Math.cos(az);
        s = Math.sin(az);
        [x, y] = [x * c - y * s, x * s + y * c];
        return [x, y, z];
      };
      const min: [number, number, number] = [Infinity, Infinity, Infinity];
      const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
      for (const cx of [b.min[0], b.max[0]])
        for (const cy of [b.min[1], b.max[1]])
          for (const cz of [b.min[2], b.max[2]]) {
            const p = rot([cx, cy, cz]);
            for (let a = 0; a < 3; a++) {
              if (p[a]! < min[a]!) min[a] = p[a]!;
              if (p[a]! > max[a]!) max[a] = p[a]!;
            }
          }
      return { min, max };
    }
    case 'extrude': {
      const b = aabbOfProfile(op.profile);
      if (!b) return null;
      // Manifold scales and twists the far face about the profile's ORIGIN, so
      // bound the solid by the union of the base outline and the scaled one;
      // a twist sweeps the whole circumscribing radius.
      const s = op.scaleTop ?? 1;
      const sx = typeof s === 'number' ? s : s[0];
      const sy = typeof s === 'number' ? s : s[1];
      let lo: Vec2 = [Math.min(b.min[0], b.min[0] * sx), Math.min(b.min[1], b.min[1] * sy)];
      let hi: Vec2 = [Math.max(b.max[0], b.max[0] * sx), Math.max(b.max[1], b.max[1] * sy)];
      if (op.twistDegrees) {
        const r =
          Math.max(Math.abs(lo[0]), Math.abs(hi[0]), Math.abs(lo[1]), Math.abs(hi[1]));
        lo = [-r, -r];
        hi = [r, r];
      }
      return op.center
        ? { min: [lo[0], lo[1], -op.height / 2], max: [hi[0], hi[1], op.height / 2] }
        : { min: [lo[0], lo[1], 0], max: [hi[0], hi[1], op.height] };
    }
    case 'revolve': {
      const b = aabbOfProfile(op.profile);
      if (!b) return null;
      // Only the +X half of the profile is swept; it becomes a disc of that
      // radius, and the profile's Y range becomes the solid's Z range.
      const r = Math.max(Math.abs(b.min[0]), Math.abs(b.max[0]));
      return { min: [-r, -r, b.min[1]], max: [r, r, b.max[1]] };
    }
    case 'hull':
    case 'union':
    case 'difference':
    case 'intersection': {
      // The FIRST child bounds a difference/intersection; a union (and a hull,
      // which never reaches outside its inputs) merges all.
      const kids =
        op.kind === 'union' || op.kind === 'hull' ? op.children : op.children.slice(0, 1);
      let out: Aabb | null = null;
      for (const k of kids) {
        const b = aabbOfOp(k);
        if (!b) continue;
        if (!out) out = { min: [...b.min] as Vec3, max: [...b.max] as Vec3 };
        else
          for (let a = 0; a < 3; a++) {
            if (b.min[a]! < out.min[a]!) (out.min as number[])[a] = b.min[a]!;
            if (b.max[a]! > out.max[a]!) (out.max as number[])[a] = b.max[a]!;
          }
      }
      return out;
    }
  }
}

export function difference(children: BuildOp[]): BuildOp {
  return { kind: 'difference', children };
}

export function union(children: BuildOp[]): BuildOp {
  return { kind: 'union', children };
}

export function intersection(children: BuildOp[]): BuildOp {
  return { kind: 'intersection', children };
}

export interface ExtrudeOptions {
  /** Intermediate slices — only needed with twist or a taper. */
  divisions?: number;
  twistDegrees?: number;
  /** Scale of the far face: a scalar, or [x, y]. 1 = straight prism. */
  scaleTop?: Vec2 | number;
  center?: boolean;
}

/** Extrude a profile along +Z, base at z = 0. */
export function extrude(profile: Profile, height: number, opts: ExtrudeOptions = {}): BuildOp {
  const divisions =
    opts.divisions ?? (opts.twistDegrees || opts.scaleTop !== undefined ? 16 : 0);
  return { kind: 'extrude', profile, height, ...opts, divisions };
}

/** Extrude along +X — the profile's x becomes y, its y becomes z. */
export function extrudeX(profile: Profile, length: number, opts: ExtrudeOptions = {}): BuildOp {
  return rotate([0, 90, 0], rotate([0, 0, 90], extrude(profile, length, opts)));
}

/** Extrude along +Y — the profile's x stays x, its y becomes z. */
export function extrudeY(profile: Profile, length: number, opts: ExtrudeOptions = {}): BuildOp {
  return rotate([-90, 0, 0], extrude(profile, length, opts));
}

/** Revolve a profile about its Y axis (which becomes the solid's Z axis). */
export function revolve(profile: Profile, degrees = 360, segments?: number): BuildOp {
  return { kind: 'revolve', profile, degrees, segments };
}

/** Convex hull of the children. */
export function hull(children: BuildOp[]): BuildOp {
  return { kind: 'hull', children };
}

/**
 * Issue #81 — extruded rounded rectangle: a box of (width × height × depth)
 * with the four VERTICAL edges rounded to `radius`. Built as the union of
 * two perpendicular center-cross strips + four corner cylinders, all of full
 * `depth`. Manifold's union fuses them into a single connected component.
 *
 * When `radius <= 0` returns a plain cube to keep the legacy fast path
 * byte-identical to pre-#81 builds.
 *
 * Origin convention: bbox-min corner sits at (0, 0, 0); body extends to
 * (width, height, depth) — same as `cube([w, h, d], false)` so callers can
 * swap in roundedRectPrism without changing translation logic.
 */
export function roundedRectPrism(
  width: number,
  height: number,
  depth: number,
  radius: number,
  segments = 24,
): BuildOp {
  if (radius <= 0) return cube([width, height, depth], false);
  // Clamp so the corner cylinders never exceed the rectangle's half-extent.
  const r = Math.min(radius, width / 2, height / 2);
  // Center cross: a "+"-shaped pair of overlapping cubes that fill everything
  // inside the rounded rim. Each strip is full-thickness in one axis and
  // (full - 2r) in the other. Skip a strip entirely when its in-plane
  // thickness collapses to zero (radius == width/2 or height/2 exactly) —
  // a zero-extent cube would be an empty manifold mesh that breaks union.
  const out: BuildOp[] = [];
  const horizH = height - 2 * r;
  if (horizH > 0) out.push(translate([0, r, 0], cube([width, horizH, depth], false)));
  const vertW = width - 2 * r;
  if (vertW > 0) out.push(translate([r, 0, 0], cube([vertW, height, depth], false)));
  // Quarter circles at each corner — using a full cylinder is cheaper than
  // building a quarter-cylinder mesh, and the parts of the cylinder past the
  // rim get clipped by manifold's boolean union with the strips automatically
  // since they sit at the same depth.
  out.push(translate([r, r, 0], cylinder(depth, r, segments)));
  out.push(translate([width - r, r, 0], cylinder(depth, r, segments)));
  out.push(translate([r, height - r, 0], cylinder(depth, r, segments)));
  out.push(translate([width - r, height - r, 0], cylinder(depth, r, segments)));
  return union(out);
}

export function collectMeshTransferables(op: BuildOp): ArrayBuffer[] {
  const out: ArrayBuffer[] = [];
  walk(op);
  return out;
  function walk(o: BuildOp): void {
    switch (o.kind) {
      case 'mesh':
        out.push(o.positions.buffer as ArrayBuffer, o.indices.buffer as ArrayBuffer);
        return;
      case 'translate':
      case 'rotate':
      case 'scale':
        walk(o.child);
        return;
      case 'union':
      case 'difference':
      case 'intersection':
      case 'hull':
        for (const c of o.children) walk(c);
        return;
      default:
        return;
    }
  }
}
