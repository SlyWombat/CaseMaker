import type { Vec3 } from '@/types';

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
  | { kind: 'union'; children: BuildOp[] }
  | { kind: 'difference'; children: BuildOp[] }
  | { kind: 'intersection'; children: BuildOp[] };

export interface BuildNode {
  id: string;
  op: BuildOp;
}

export interface BuildPlan {
  nodes: BuildNode[];
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

export function difference(children: BuildOp[]): BuildOp {
  return { kind: 'difference', children };
}

export function union(children: BuildOp[]): BuildOp {
  return { kind: 'union', children };
}
