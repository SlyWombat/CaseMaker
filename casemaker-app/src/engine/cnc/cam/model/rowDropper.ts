/**
 * cam/model/rowDropper.ts — adaptive drop-cutter sampling along one raster row, §2/§3.4 of
 * `docs/design/cam-model-engine.md`.
 *
 * `clSurface()`'s own `dropCutter(x, y)` is a lazy point query; this is the PATH side of §2's
 * adaptive sampling it names but does not do itself (advisor's review on this slice): walk a
 * straight row from `from` to `to`, subdividing wherever the midpoint's own drop departs from the
 * straight-line (chord) interpolation by more than `surface.toleranceMm`, down to
 * `surface.minSpacingMm` — starting no coarser than `surface.maxSpacingMm`. At `minSpacingMm`, a
 * departure that still will not close is a real discontinuity, not a sampling gap: resolved as a
 * STAIRCASE (hold the SHALLOWER of the two known points across the whole stretch, stepping
 * vertically right at whichever end is the deeper one), never a diagonal that would dip under the
 * shallow side's own true height. `rough()` and `finish()` (#959/#960) both walk rows this way —
 * this is the one function, not duplicated per op.
 *
 * THE GUARANTEE, STATED EXACTLY (E's finding on #957, 2026-11-05): a segment is only ever sampled
 * at its own ends, midpoint and two quarter points — a=0, q1=0.25, m=0.5, q3=0.75, b=1 of the
 * segment's own span. The kink guard (below) catches a slope change AT one of those five points,
 * but a CL feature narrower than the segment's own span/4 can sit entirely between two adjacent
 * samples and never register at any of them — neither a chord departure nor a quarter-slope
 * change sees a bump that rises and falls again inside one quarter-segment. The bound this file
 * can actually promise is therefore: the chord dips by no more than `toleranceMm` for any feature
 * AT LEAST span/4 wide; a narrower feature is not bounded by tolerance at all and can dip by up to
 * its own full height. Doubling the sample count (quarter points of quarter points) would halve
 * the blind width at double the query cost per segment — not done here; this is a stated limit,
 * not a silent gap. `rowDropperNonCircular957.spec.ts`'s skipped "sub-span/4 ridge" case pins the
 * exact width this applies at.
 */

import type { ClSurface } from './clsurface';

export interface DroppedPoint {
  x: number;
  y: number;
  z: number;
}

// A stall guard (§6: no caps on geometry, this is not one) — 2^24 subdivisions of even the
// coarsest `maxSpacingMm` is already absurd; real surfaces close long before this.
const MAX_BISECT_DEPTH = 24;

// #957 — THE KINK GUARD (the manager's ruling, withdrawing the s²/(8R) ball bound: the CL is an
// upper envelope of contact families with upward kinks where the binding family switches — a
// V-bit riding off a thin rib's own edge, a ball crossing a knife edge's plate/flank seam — and a
// chord across one does not sag by a radius-derived bound, it sags by the SLOPE CHANGE itself.
// The four quarter-segment slopes (a-q1, q1-m, m-q3, q3-b) are the cheapest local read of that:
// a real kink shows up as a sharp change between adjacent ones, at a scale the departure check
// (sampled only at 0.25/0.5/0.75) can miss when the true worst point sits off those fractions —
// the rib's V-bit case dipped 0.005014 mm against the 0.005 mm tolerance at t=0.516, not 0.5.
// Below this slope-change, two adjacent quarter-slopes are close enough that the segment is
// smooth there and the departure check alone is trusted.
const KINK_SLOPE_CHANGE_MM_PER_MM = 0.05;

/** The surface's drop at `t` along a..b, or a throw: a null between two reachable points is a footprint notch. */
function dropAt(surface: ClSurface, a: DroppedPoint, b: DroppedPoint, t: number): DroppedPoint {
  const x = a.x + (b.x - a.x) * t;
  const y = a.y + (b.y - a.y) * t;
  const z = surface.dropCutter(x, y);
  // The manager's ruling on footprint vs links: a row is CUT only where `clSurface` answers; a
  // stretch where it leaves the footprint and re-enters is a LINK, handed to `link()`'s own
  // material-state read, never a straight chord guessed across it. `a` and `b` are both known
  // reachable (every caller — `dropRow`'s own endpoints, or the bisection's own recursion — only
  // ever bisects between two already-valid points), so a null HERE means the straight line
  // between them crosses OUT of the footprint somewhere in between: exactly the footprint notch
  // this rule exists to catch, not a reason to fall back on the chord and cut across it.
  if (z === null) {
    throw new Error(
      `cam/model/rowDropper: the row leaves the surface's own reach between (${a.x}, ${a.y}) and (${b.x}, ${b.y}) — a footprint notch, not a straight chord to guess across. The caller clips a row into separate footprint intervals and hands the gap between them to link(), per the manager's ruling on footprint vs links.`,
    );
  }
  return { x, y, z };
}

/**
 * #960 — THE ORGANIZER FOUND THIS: a segment was accepted when its MIDPOINT alone sat on the
 * chord. A CL kink off-centre (a ball rolling over a crease or a rim) can leave the midpoint on the
 * chord while the surface rises above it a quarter of the way along — the chord then dips under
 * the CL (worst 0.041 mm on the real organizer, 745 row segments). The segment is accepted only
 * when its midpoint AND both quarter points sit within tolerance; the quarter points become the
 * halves' own midpoints on recursion, so each accepted leaf costs two drops, not three.
 */
function bisect(surface: ClSurface, a: DroppedPoint, b: DroppedPoint, mid: DroppedPoint | null, depth: number, out: DroppedPoint[]): void {
  const segLen = Math.hypot(b.x - a.x, b.y - a.y);
  if (segLen <= 1e-9) {
    out.push(b);
    return;
  }
  const m = mid ?? dropAt(surface, a, b, 0.5);
  const q1 = dropAt(surface, a, b, 0.25);
  const q3 = dropAt(surface, a, b, 0.75);
  const chord = (t: number): number => a.z + (b.z - a.z) * t;
  const departure = Math.max(Math.abs(m.z - chord(0.5)), Math.abs(q1.z - chord(0.25)), Math.abs(q3.z - chord(0.75)));
  // #957 — THE KINK GUARD: even when every sampled point sits on the chord, the four quarter
  // slopes may say the TRUE surface bends sharply somewhere between them — exactly where the
  // departure check's own fixed fractions (0.25 / 0.5 / 0.75) do not look. A real kink forces
  // one more subdivision regardless of `departure`, so the next level's own quarter points land
  // closer to where the bend actually is.
  const quarterLen = segLen / 4;
  const slope = (z0: number, z1: number): number => (z1 - z0) / quarterLen;
  const s1 = slope(a.z, q1.z);
  const s2 = slope(q1.z, m.z);
  const s3 = slope(m.z, q3.z);
  const s4 = slope(q3.z, b.z);
  const kink = Math.max(Math.abs(s2 - s1), Math.abs(s3 - s2), Math.abs(s4 - s3));
  const noRoomLeft = segLen / 2 <= surface.minSpacingMm || depth >= MAX_BISECT_DEPTH;
  // A real kink only MATTERS while there is still room to refine: ordinary curvature (a ball
  // rolling off a step's own radius, a ramp) shows the same kind of slope change at a coarse
  // scale and resolves it away on its own as segments shrink — re-sampling at the next level's
  // own finer quarter points, not the staircase, is the right response. At the finest spacing
  // this surface states, the departure check (not the slope change) is what decides: it is the
  // actual proven bound, and there is nothing left to re-sample that would resolve the kink
  // further.
  if (departure <= surface.toleranceMm && (kink <= KINK_SLOPE_CHANGE_MM_PER_MM || noRoomLeft)) {
    out.push(b);
    return;
  }
  if (noRoomLeft) {
    // A real discontinuity at the finest spacing this surface states — never a diagonal, which
    // could dip the tool under the high side partway across. Hold the HIGHEST height known on the
    // stretch (either end, or a sample between them) across it, stepping vertically at each end.
    const hold = Math.max(a.z, b.z, m.z, q1.z, q3.z);
    if (hold > a.z) out.push({ x: a.x, y: a.y, z: hold });
    if (hold > b.z) out.push({ x: b.x, y: b.y, z: hold });
    out.push(b);
    return;
  }
  bisect(surface, a, m, q1, depth + 1, out);
  bisect(surface, m, b, q3, depth + 1, out);
}

/**
 * #957/#960 — DIRECTION-CANONICAL (D's organizer finding): the #962 alternation walks the same
 * row from either end depending on its parity, and the bisection's own knife-edge accept/reject
 * decisions (`departure`/`kink` against a fixed tolerance) are sensitive enough to floating-point
 * order that the two directions could land on different sides of the threshold at the same real
 * point — a coarser grid flips which rows walk which way, and eight of the organizer's cells
 * read 0.10–0.26 mm differently depending on it. `dropRow` always computes in ONE canonical
 * direction (lower `x`, `y` breaking ties, first) and reverses the point array for the opposite
 * request — the row's own geometry is identical either way, only which end is asked for first.
 */
export function dropRow(surface: ClSurface, from: readonly [number, number], to: readonly [number, number]): DroppedPoint[] {
  const canonicalFirst = from[0] < to[0] || (from[0] === to[0] && from[1] <= to[1]);
  if (canonicalFirst) return dropRowCanonical(surface, from, to);
  return dropRowCanonical(surface, to, from).reverse();
}

function dropRowCanonical(surface: ClSurface, from: readonly [number, number], to: readonly [number, number]): DroppedPoint[] {
  const z0 = surface.dropCutter(from[0], from[1]);
  const z1 = surface.dropCutter(to[0], to[1]);
  if (z0 === null || z1 === null) {
    throw new Error(
      `cam/model/rowDropper: dropRow's own endpoint${z0 === null && z1 === null ? 's' : ''} must be within the surface's reach (${z0 === null ? 'from' : 'to'} = null) — the caller decides the row's own extent, not this function`,
    );
  }
  const a: DroppedPoint = { x: from[0], y: from[1], z: z0 };
  const b: DroppedPoint = { x: to[0], y: to[1], z: z1 };
  const out: DroppedPoint[] = [a];
  const dist = Math.hypot(b.x - a.x, b.y - a.y);
  if (dist <= 1e-9) return out;
  const steps = Math.max(1, Math.ceil(dist / surface.maxSpacingMm));
  let prev = a;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const x = a.x + (b.x - a.x) * t;
    const y = a.y + (b.y - a.y) * t;
    const z = i === steps ? b.z : surface.dropCutter(x, y);
    if (z === null) {
      throw new Error(`cam/model/rowDropper: a maxSpacing sample at (${x}, ${y}) fell outside the surface's reach — the row crosses the footprint's own edge mid-span, the caller's own clipping to fix`);
    }
    const next: DroppedPoint = { x, y, z };
    bisect(surface, prev, next, null, 0, out);
    prev = next;
  }
  return out;
}
