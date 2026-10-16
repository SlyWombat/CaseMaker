/**
 * `clamp-in-path` / `bracket-in-path` (#427): a toolpath that crosses a clamp's or the bracket's
 * footprint below its top. Pure and cheap — no solids — so the program verifier (`verify.ts`) can run it
 * on the file the machine will get.
 *
 * TESTED ON THE SEGMENT, NOT ITS POINTS. A 15 mm clamp is easily crossed by a move whose endpoints and
 * midpoint are all outside it. Each move is clipped against the footprint (grown by the tool's radius at
 * that height and the mount's uncertainty — a square grow, so it errs toward a finding), and the tool's
 * lowest point over the clipped part is compared with the obstacle's top. Rapids count: a hop below a
 * clamp's top is exactly the crash this exists for.
 *
 * THE RADIUS is the widest part of the tool that can be alongside the clamp — the shank or the cutting
 * diameter, whichever is larger — because at clamp height it is the body, not the tip, that passes.
 */

import type { Vec3 } from '@/types/units';
import type { MountObstacle } from './bracket';

export interface PathSegment {
  line: number | null;
  mode: 'rapid' | 'cut';
  from: Vec3;
  to: Vec3;
}

export interface InPathFinding {
  severity: 'error';
  code: 'clamp-in-path' | 'bracket-in-path';
  line: number | null;
  obstacleId: string;
  message: string;
}

const fmt = (n: number) => String(Math.round(n * 1000) / 1000);

/** The part of the XY segment inside the rectangle, as a parameter range on [0, 1], or null. */
export function clipToRect(a: Vec3, b: Vec3, min: [number, number], max: [number, number]): [number, number] | null {
  let t0 = 0;
  let t1 = 1;
  for (const axis of [0, 1] as const) {
    const d = b[axis] - a[axis];
    if (Math.abs(d) < 1e-12) {
      if (a[axis] < min[axis] || a[axis] > max[axis]) return null;
      continue;
    }
    let lo = (min[axis] - a[axis]) / d;
    let hi = (max[axis] - a[axis]) / d;
    if (lo > hi) [lo, hi] = [hi, lo];
    t0 = Math.max(t0, lo);
    t1 = Math.min(t1, hi);
    if (t0 > t1) return null;
  }
  return [t0, t1];
}

/**
 * Every obstacle the path passes through below its top: ONE finding per obstacle, at the first move that
 * does, with how many more do.
 */
export function mountInPath(
  segments: PathSegment[],
  obstacles: MountObstacle[],
  opts: { radius: number; uncertainty: number },
): InPathFinding[] {
  const out: InPathFinding[] = [];
  const grow = opts.radius + opts.uncertainty;
  for (const o of obstacles) {
    const min: [number, number] = [o.min[0] - grow, o.min[1] - grow];
    const max: [number, number] = [o.max[0] + grow, o.max[1] + grow];
    const top = o.topZ + opts.uncertainty;
    let first: { seg: PathSegment; z: number } | null = null;
    let more = 0;
    for (const seg of segments) {
      const t = clipToRect(seg.from, seg.to, min, max);
      if (t === null) continue;
      const zAt = (u: number) => seg.from[2] + (seg.to[2] - seg.from[2]) * u;
      const low = Math.min(zAt(t[0]), zAt(t[1]));
      if (low >= top) continue;
      if (first === null) first = { seg, z: low };
      else more++;
    }
    if (first === null) continue;
    const what = first.seg.mode === 'rapid' ? 'a rapid' : 'a cutting move';
    out.push({
      severity: 'error',
      code: o.kind === 'clamp' ? 'clamp-in-path' : 'bracket-in-path',
      line: first.seg.line,
      obstacleId: o.id,
      message:
        `${what} takes the tool over ${o.label} at Z ${fmt(first.z)}, below its top at Z ${fmt(o.topZ)}` +
        `${more > 0 ? ` (and ${more} more move${more === 1 ? '' : 's'})` : ''}: ${o.fix}`,
    });
  }
  return out;
}
