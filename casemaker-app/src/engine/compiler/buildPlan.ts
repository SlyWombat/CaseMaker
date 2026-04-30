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
