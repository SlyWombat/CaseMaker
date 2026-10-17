/**
 * The cheap travelling-salesman heuristic the CAM's ordering is built on (#487).
 *
 * The problem is an OPEN path: visit every point once, starting from where the tool already is,
 * and stop wherever the last one is. Two steps, both standard and both instant at the counts CAM
 * sees (tens of contours):
 *
 *   1. NEAREST NEIGHBOUR from `from` — greedy, and good enough that the 2-opt pass starts from a
 *      path without any gross back-and-forth left in it.
 *   2. 2-OPT — reverse any stretch of the path whose two end edges get SHORTER when swapped. The
 *      first point never moves: the path has a start, and changing it would change where the tool
 *      plunges first.
 *
 * DETERMINISM IS PART OF THE CONTRACT. Ties in the nearest-neighbour step go to the lower index,
 * and the 2-opt scan has a fixed order, so the same points in the same order always produce the
 * same tour — and therefore the same `.nc` (#487 item 5).
 *
 * The module is PURE and knows nothing about cutters, contours or moves; `engraveJob.ts` hands it
 * the representative point of each loop and does the entry-point rotation itself.
 */

export type TourPoint = readonly [number, number];

/** Squared distance — the comparisons below never need the square root. */
function d2(a: TourPoint, b: TourPoint): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  return dx * dx + dy * dy;
}

/** The distance along a path through `points`, in order. */
export function pathLength(points: readonly TourPoint[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    total += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  return total;
}

/**
 * Indices of `points` in nearest-neighbour visit order from `from` (the work origin by default).
 *
 * Ties go to the LOWER INDEX: a set of equidistant points is not a coin toss, and the order the
 * caller passed them in is the stable tiebreak.
 */
export function nearestNeighbourOrder(
  points: readonly TourPoint[],
  from: TourPoint = [0, 0],
): number[] {
  const remaining = points.map((_, i) => i);
  const order: number[] = [];
  let px = from[0];
  let py = from[1];
  while (remaining.length > 0) {
    let bestPos = 0;
    let best = Infinity;
    for (let k = 0; k < remaining.length; k++) {
      const p = points[remaining[k]!]!;
      const distance = (p[0] - px) ** 2 + (p[1] - py) ** 2;
      if (distance < best - 1e-9) {
        best = distance;
        bestPos = k;
      }
    }
    const chosen = remaining.splice(bestPos, 1)[0]!;
    order.push(chosen);
    px = points[chosen]![0];
    py = points[chosen]![1];
  }
  return order;
}

/**
 * Improve an open path by 2-opt. `order` is a list of indices into `points`; the FIRST entry stays
 * first (it is where the tool already is nearest), and every other stretch may be reversed when
 * the two edges that replace the cut pair are shorter than the two they remove.
 *
 * The scan is fixed — i ascending, j ascending — and improvements are applied immediately; the
 * loop ends on the first full pass that finds none. With strict improvement on a finite state
 * space that terminates, and the fixed scan makes it deterministic.
 */
export function twoOptOrder(points: readonly TourPoint[], order: readonly number[]): number[] {
  const path = [...order];
  const n = path.length;
  if (n < 3) return path;
  let improved = true;
  while (improved) {
    improved = false;
    for (let i = 1; i < n - 1; i++) {
      for (let j = i + 1; j < n; j++) {
        const a = points[path[i - 1]!]!;
        const b = points[path[i]!]!;
        const c = points[path[j]!]!;
        const after = j + 1 < n ? points[path[j + 1]!]! : null;
        const before = d2(a, b) + (after === null ? 0 : d2(c, after));
        const now = d2(a, c) + (after === null ? 0 : d2(b, after));
        if (now < before - 1e-9) {
          for (let l = i, r = j; l < r; l++, r--) {
            const t = path[l]!;
            path[l] = path[r]!;
            path[r] = t;
          }
          improved = true;
        }
      }
    }
  }
  return path;
}

/** Nearest neighbour from `from`, then the 2-opt pass. The one entry point CAM calls. */
export function tourNearest(points: readonly TourPoint[], from: TourPoint = [0, 0]): number[] {
  return twoOptOrder(points, nearestNeighbourOrder(points, from));
}
