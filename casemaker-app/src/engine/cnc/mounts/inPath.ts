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
  /**
   * #710 — the `;@MKR|TOOLPATH` number in force for this move, when the file states one. It is how
   * a refusal names the ITEM the operator sees ("“Tray” runs under the clamp…"), from the program's
   * own header rather than from the generator's word.
   */
  toolpath?: number | null;
}

export interface InPathFinding {
  severity: 'error';
  code: 'clamp-in-path' | 'bracket-in-path';
  line: number | null;
  obstacleId: string;
  message: string;
}

const fmt = (n: number) => String(Math.round(n * 1000) / 1000);

/**
 * The strips of the top a face pass cannot cut because the mount stands over them (#432 decision
 * 5): each obstacle's footprint, grown by the cutter's radius and the mount's fit and clipped to the
 * stock, in one sentence per strip.
 *
 * This is what a refused skim carries instead of silently shrinking its raster. It is measured from
 * the OBSTACLES the app models, not guessed: an obstacle that stands clear of the stock contributes
 * nothing, and a stock with no obstacle over it says nothing at all.
 */
export function unfacedBands(
  obstacles: MountObstacle[],
  stock: { x: number; y: number },
  opts: { radius: number; uncertainty: number },
): string[] {
  const grow = opts.radius + opts.uncertainty;
  const out: string[] = [];
  for (const o of obstacles) {
    const x0 = Math.max(o.min[0] - grow, 0);
    const x1 = Math.min(o.max[0] + grow, stock.x);
    const y0 = Math.max(o.min[1] - grow, 0);
    const y1 = Math.min(o.max[1] + grow, stock.y);
    if (x1 - x0 <= 0 || y1 - y0 <= 0) continue;
    out.push(`a ${fmt(x1 - x0)} mm × ${fmt(y1 - y0)} mm band of the top (${o.label} stands over it) could not be faced`);
  }
  return out;
}

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

/** The parameters the mount check is grown by, and the words a refusal uses (#427, #710). */
export interface MountCheckOpts {
  /** The widest part of the tool beside the old mount: its shank or its cutting diameter. */
  radius: number;
  /** The mount's fit: how far the stock's corner may sit from the bracket's datum. */
  uncertainty: number;
  /**
   * #710 — the FIXTURE CLEARANCE: the job's jaw clearance (`job.jawClearance`), which now covers the
   * clamps and the arms too. Grown by it on top of the fit, and quoted in the arm refusal as the
   * keep-out from the edge. Absent: 0.
   */
  clearance?: number;
  /**
   * #710 — the subject of a refusal, for the item's own name: the verifier answers with the
   * operation's label read from the program's header ("“Tray”"), or null for a file that names
   * none.
   */
  subjectOf?: (segment: PathSegment) => string | null;
}

/** The distance from a point to a segment, in the XY plane. */
function pointToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/**
 * The clear XY distance between a segment and a rectangle, mm; 0 when they touch or overlap.
 * #710 — the arm refusal quotes it ("comes within 1.2 mm of the bracket's front arm"), so it is
 * computed rather than left out.
 */
export function segmentToRect(from: Vec3, to: Vec3, min: [number, number], max: [number, number]): number {
  if (clipToRect(from, to, min, max) !== null) return 0;
  const corners: [number, number][] = [
    [min[0], min[1]],
    [max[0], min[1]],
    [max[0], max[1]],
    [min[0], max[1]],
  ];
  let best = Infinity;
  for (let i = 0; i < 4; i++) {
    const a = corners[i]!;
    const b = corners[(i + 1) % 4]!;
    // Segment-to-edge distance: 0 when they cross, else the nearest of the four endpoint-to-other
    // distances (the minimum over both ends of both segments is the true distance for two
    // non-crossing convex segments).
    if (clipSegments(from, to, a, b)) return 0;
    best = Math.min(
      best,
      pointToSegment(a[0], a[1], from[0], from[1], to[0], to[1]),
      pointToSegment(b[0], b[1], from[0], from[1], to[0], to[1]),
      pointToSegment(from[0], from[1], a[0], a[1], b[0], b[1]),
      pointToSegment(to[0], to[1], a[0], a[1], b[0], b[1]),
    );
  }
  return best;
}

/** Whether two 2D segments cross or touch. */
function clipSegments(a: Vec3, b: Vec3, c: [number, number], d: [number, number]): boolean {
  const orient = (px: number, py: number, qx: number, qy: number, rx: number, ry: number): number => {
    const v = (qy - py) * (rx - qx) - (qx - px) * (ry - qy);
    return Math.abs(v) < 1e-12 ? 0 : Math.sign(v);
  };
  const o1 = orient(a[0], a[1], b[0], b[1], c[0], c[1]);
  const o2 = orient(a[0], a[1], b[0], b[1], d[0], d[1]);
  const o3 = orient(c[0], c[1], d[0], d[1], a[0], a[1]);
  const o4 = orient(c[0], c[1], d[0], d[1], b[0], b[1]);
  return o1 !== o2 && o3 !== o4;
}

/** `4 mm`, `2.688 mm` — the precision the refusal sentences use. */
const mm = (n: number): string => `${fmt(n)} mm`;

/**
 * Every obstacle the path passes through below its top: ONE finding per obstacle, at the first move
 * that does.
 *
 * THE SENTENCES ARE THE DESIGN'S (#710, `docs/design/bed-mounts-flow.md` §3.7), in the operator's
 * words and with the item as the subject: a clamp refusal says the item runs under the clamp and
 * where the clamp is; an arm refusal says how close the cutter comes, how high the arm stands and
 * how far inside the edge the cut has to keep. A file that names no operation keeps the old
 * "a rapid / a cutting move" subject rather than inventing one.
 */
export function mountInPath(segments: PathSegment[], obstacles: MountObstacle[], opts: MountCheckOpts): InPathFinding[] {
  const out: InPathFinding[] = [];
  const clearance = opts.clearance ?? 0;
  const grow = opts.radius + opts.uncertainty + clearance;
  for (const o of obstacles) {
    const min: [number, number] = [o.min[0] - grow, o.min[1] - grow];
    const max: [number, number] = [o.max[0] + grow, o.max[1] + grow];
    const top = o.topZ + opts.uncertainty;
    let first: { seg: PathSegment; z: number } | null = null;
    for (const seg of segments) {
      const t = clipToRect(seg.from, seg.to, min, max);
      if (t === null) continue;
      const zAt = (u: number) => seg.from[2] + (seg.to[2] - seg.from[2]) * u;
      const low = Math.min(zAt(t[0]), zAt(t[1]));
      if (low >= top) continue;
      if (first === null) first = { seg, z: low };
    }
    if (first === null) continue;
    const subject = opts.subjectOf?.(first.seg) ?? null;
    const who = subject ?? (first.seg.mode === 'rapid' ? 'a rapid' : 'a cutting move');
    let message: string;
    if (o.kind === 'bracket') {
      // How close the CUTTER's edge comes to the arm's own footprint (the grown box is the
      // keep-out, not the arm), and the keep-out it should have kept.
      const edgeGap = Math.max(0, segmentToRect(first.seg.from, first.seg.to, o.min, o.max) - opts.radius);
      const where =
        o.topZ >= 0
          ? `which stands ${mm(o.topZ)} above the plate`
          : `which sits ${mm(-o.topZ)} below the plate’s top`;
      const inside = o.edge === undefined ? 'inside the stock’s edge' : `inside the ${o.edge} edge`;
      message = `${who} comes within ${mm(edgeGap)} of ${o.label}, ${where} — keep the cut ${mm(grow)} ${inside}.`;
    } else {
      message = `${who} runs under ${o.label} — ${o.fix}.`;
    }
    out.push({
      severity: 'error',
      code: o.kind === 'clamp' ? 'clamp-in-path' : 'bracket-in-path',
      line: first.seg.line,
      obstacleId: o.id,
      message,
    });
  }
  return out;
}
