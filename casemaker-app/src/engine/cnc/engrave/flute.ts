/**
 * #674 — A FLUTE: a trace whose groove RAMPS in and out along its ends instead of plunging to
 * depth and retracting from it.
 *
 * WHAT IT IS. The operator marks a `line` with a `FluteMark`; this module turns the path's
 * ARCLENGTH into a DEPTH PER POINT. The trace CAM walks the path as one continuous feed whose Z
 * follows the profile (no plunge, no retract from depth), and the prediction decomposes the same
 * profile per segment — so the tool, the file and the oracle read one array.
 *
 * THE NUMBERS, and where each comes from:
 *
 *   - the DEPTH is the line's own `depth` — the operator's number, checked by
 *     `depth-exceeds-stock` like any trace.
 *   - `rampMm` is the ramp's length along the path. {@link DEFAULT_FLUTE_RAMP_FACTOR} × the depth
 *     when the operator states none — a labelled CAM rule, not a measured value: at 3:1 the ramp
 *     runs at about 18°, steep enough to stay short on a decorative line and shallow enough not
 *     to plunge.
 *
 * THE PROFILE. For an open path: `depth · min(s / ramp, (L − s) / ramp, 1)` at arclength `s`. For
 * a closed path the ramps meet at the SEAM (the first point), so the ring fades in and out there
 * and the groove is continuous everywhere else. When the path is shorter than its two ramps they
 * overlap and the groove peaks at `depth · L / (2 · ramp)` — never at the stated depth; the
 * `flute-short` finding says so with both numbers.
 *
 * THE SAMPLING. The profile is only as fine as the points it is sampled at, and a job's line may
 * be two points long. A segment whose ends differ in depth by more than `depth /
 * FLUTE_RAMP_STEPS` is subdivided into equal pieces, so the plan's staircase is `depth / 16` and
 * every consumer (the CAM's moves, the oracle's per-segment entries, the picture) is stepped by
 * the same amount. That step is deliberate and stated on the sheet: the two engines both apply a
 * move at the move's own Z, so the sim, the prediction and the file agree exactly, and a real
 * machine's linear ramp differs from them by at most one step — in the safe direction on the way
 * in.
 */

import type { EngraveLineItem, EngraveTraceItem, FluteMark } from '@/types/engraveJob';
import type { Mm } from '@/types/units';

/** The ramp is this many times the trace's depth when the operator states none — labeled, not measured. */
export const DEFAULT_FLUTE_RAMP_FACTOR = 3;

/** Subdivision of a ramping segment: a step no deeper than `depth / this`. */
export const FLUTE_RAMP_STEPS = 16;

/** Where a flute's ramp came from, in the words the row prints. */
export type FluteRampSource = 'typed' | 'three times the depth';

export interface FluteNumbers {
  /** The groove's deepest point, mm — the line's own depth. */
  depthMm: Mm;
  /** The ramp's length along the path, mm. */
  rampMm: Mm;
  rampSource: FluteRampSource;
}

/** Resolve a line's marker (or none) into the numbers the profile runs with. */
export function fluteNumbers(mark: FluteMark | undefined, depthMm: Mm): FluteNumbers {
  const typed = mark?.rampMm;
  const ok = typed !== undefined && Number.isFinite(typed) && typed > 0;
  return {
    depthMm,
    rampMm: ok ? (typed as number) : DEFAULT_FLUTE_RAMP_FACTOR * depthMm,
    rampSource: ok ? 'typed' : 'three times the depth',
  };
}

/** One fluted path: the (densified) points and one depth per point, mm below the top face. */
export interface FlutePath {
  points: [Mm, Mm][];
  depths: Mm[];
  /**
   * False always, for a path that was closed: the seam's ramp is a SEGMENT like any other, so the
   * flute SPRONGS its ring open — the closing leg is sampled into points and ends exactly on the
   * first point with depth 0. A single `closed` feed move could not carry the profile.
   */
  closed: boolean;
}

/**
 * Derive a flute's Z profile along one path. Pure and deterministic: the same points, depth and
 * ramp always give the same array, so the program is byte-identical run to run.
 *
 * `points` are in any one frame (the profile is a function of arclength only). A closed path's
 * `L` includes the implicit closing segment, so the ramps meet at the first point.
 */
export function fluteProfile(
  points: readonly [Mm, Mm][],
  closed: boolean,
  depthMm: Mm,
  rampMm: Mm,
): FlutePath {
  const n = points.length;
  if (n === 0) return { points: [], depths: [], closed: false };
  if (n === 1) return { points: [[points[0]![0], points[0]![1]]], depths: [0], closed: false };
  if (!(depthMm > 0) || !(rampMm > 0)) {
    return { points: points.map(([x, y]) => [x, y] as [Mm, Mm]), depths: points.map(() => 0), closed: false };
  }

  // The walked vertices: the item's own points, and — for a ring — the seam's closing leg made
  // explicit, because its ramp is a segment like every other and a single `closed` move could
  // not carry it.
  const verts: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    verts.push([points[i]![0], points[i]![1]]);
    if (closed && i === n - 1) verts.push([points[0]![0], points[0]![1]]);
  }
  const s: number[] = [0];
  for (let i = 1; i < verts.length; i++) {
    const a = verts[i - 1]!;
    const b = verts[i]!;
    s.push(s[i - 1]! + Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
  const total = s[s.length - 1]!;
  if (!(total > 0)) {
    return { points: verts.map(([x, y]) => [x, y] as [Mm, Mm]), depths: verts.map(() => 0), closed: false };
  }

  /** The profile at one arclength: ramps at both ends, the stated depth between them. */
  const depthAt = (at: number): number => {
    const rise = Math.min(at, total - at) / rampMm;
    return depthMm * Math.min(rise, 1);
  };
  // Arclengths where the profile is not a single straight line along a segment: the two ramp
  // feet and the peak. Splitting at them means a segment that SPANS a foot (a two-point line's
  // whole path) is still subdivided by the depth it changes.
  const breaks = [rampMm, total / 2, total - rampMm]
    .filter((b) => b > 1e-9 && b < total - 1e-9)
    .sort((a, b) => a - b);

  const outPoints: [Mm, Mm][] = [];
  const outDepths: Mm[] = [];
  const step = depthMm / FLUTE_RAMP_STEPS;
  const push = (x: number, y: number, z: number): void => {
    outPoints.push([x, y]);
    outDepths.push(z);
  };
  push(verts[0]![0], verts[0]![1], depthAt(0));
  for (let i = 1; i < verts.length; i++) {
    const sa = s[i - 1]!;
    const sb = s[i]!;
    const a = verts[i - 1]!;
    const b = verts[i]!;
    const length = sb - sa;
    if (!(length > 1e-12)) continue;
    const stations = [sa, ...breaks.filter((br) => br > sa + 1e-9 && br < sb - 1e-9), sb];
    for (let k = 1; k < stations.length; k++) {
      const s0 = stations[k - 1]!;
      const s1 = stations[k]!;
      const z0 = depthAt(s0);
      const z1 = depthAt(s1);
      const pieces = Math.max(1, Math.ceil(Math.abs(z1 - z0) / step));
      for (let j = 1; j <= pieces; j++) {
        const t = j / pieces;
        const at = s0 + (s1 - s0) * t;
        const f = (at - sa) / length;
        push(a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, z0 + (z1 - z0) * t);
      }
    }
  }
  return { points: outPoints, depths: outDepths, closed: false };
}

/** The operation's display name for a fluted trace: the trace's own, with the word swapped. */
export function fluteOperationName(item: EngraveTraceItem): string {
  const named = item.name ? ` "${item.name}"` : '';
  if (item.kind === 'line') {
    const n = item.points.length;
    return `Flute line${named} (${n} point${n === 1 ? '' : 's'}${item.closed ? ', closed' : ''})`;
  }
  return `Flute text "${item.text}"${named}`;
}

/** Is this trace item a flute the plan must derive a profile for? */
export function flutedLine(item: EngraveTraceItem): item is EngraveLineItem & { flute: FluteMark } {
  return item.kind === 'line' && item.flute !== undefined;
}
