/**
 * #1258 — THE DRAWING'S GEOMETRY. The tab question is drawn to scale on the job's own outline: the
 * outline is a closed polyline, a stretch is the arc of it between two tabs, and a tab is a short
 * mark on it. This is the one piece of geometry the page needs; it reads no store.
 */

/** A point on the part's plane, mm. */
export type XY = readonly [number, number];


export interface LoopPoint {
  x: number;
  y: number;
  /** Direction of travel there, radians. */
  ang: number;
}

/** A closed outline, measured: arc length at every vertex, and the means to place a point on it. */
export interface Loop {
  length: number;
  at(s: number): LoopPoint;
  /** The arc length of the loop point nearest `p`. */
  project(p: XY): number;
  /** How far `p` is from the loop, mm. */
  distance(p: XY): number;
}

export function loopOf(points: readonly XY[]): Loop {
  const pts = points.length > 1 && points[0]![0] === points[points.length - 1]![0] && points[0]![1] === points[points.length - 1]![1]
    ? points.slice(0, -1)
    : points;
  const n = pts.length;
  const cum: number[] = [0];
  for (let i = 0; i < n; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % n]!;
    cum.push(cum[i]! + Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
  const length = cum[n]!;
  const at = (sIn: number): LoopPoint => {
    const s = ((sIn % length) + length) % length;
    let i = 0;
    while (i < n - 1 && cum[i + 1]! <= s) i++;
    const a = pts[i]!;
    const b = pts[(i + 1) % n]!;
    const seg = cum[i + 1]! - cum[i]!;
    const t = seg === 0 ? 0 : (s - cum[i]!) / seg;
    return { x: a[0] + (b[0] - a[0]) * t, y: a[1] + (b[1] - a[1]) * t, ang: Math.atan2(b[1] - a[1], b[0] - a[0]) };
  };
  const nearest = (p: XY): { d: number; s: number } => {
    let best = Infinity;
    let bestS = 0;
    for (let i = 0; i < n; i++) {
      const a = pts[i]!;
      const b = pts[(i + 1) % n]!;
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const len2 = dx * dx + dy * dy;
      const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
      const d = Math.hypot(a[0] + dx * t - p[0], a[1] + dy * t - p[1]);
      if (d < best) {
        best = d;
        bestS = cum[i]! + t * Math.sqrt(len2);
      }
    }
    return { d: best, s: bestS };
  };
  return { length, at, project: (p) => nearest(p).s, distance: (p) => nearest(p).d };
}

/**
 * The arc lengths a stretch spans along the loop, start to end. The engine reports a stretch by its
 * two end points and its length; of the two ways round the loop, the one whose length matches the
 * stated span is the stretch.
 */
export function stretchSpan(loop: Loop, s: { startXY: XY; endXY: XY; spanMm: number }): { from: number; to: number } {
  const a = loop.project(s.startXY);
  const b = loop.project(s.endXY);
  const forward = (((b - a) % loop.length) + loop.length) % loop.length;
  const backward = loop.length - forward;
  return Math.abs(forward - s.spanMm) <= Math.abs(backward - s.spanMm)
    ? { from: a, to: a + forward }
    : { from: b, to: b + backward };
}

/** Of several closed rings (an outer path and its islands), the one a point lies on. */
export function loopNearest(loops: readonly Loop[], p: XY): Loop {
  let best = loops[0]!;
  let bd = Infinity;
  for (const l of loops) {
    const d = l.distance(p);
    if (d < bd) {
      bd = d;
      best = l;
    }
  }
  return best;
}
