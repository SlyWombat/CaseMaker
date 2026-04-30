import type { Vec3, Facing } from '@/types';

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
  | { kind: 'intersection'; children: BuildOp[] };

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

export function difference(children: BuildOp[]): BuildOp {
  return { kind: 'difference', children };
}

export function union(children: BuildOp[]): BuildOp {
  return { kind: 'union', children };
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
        for (const c of o.children) walk(c);
        return;
      default:
        return;
    }
  }
}
