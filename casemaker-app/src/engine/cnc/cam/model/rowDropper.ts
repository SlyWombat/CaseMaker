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
  if (departure <= surface.toleranceMm) {
    out.push(b);
    return;
  }
  if (segLen / 2 <= surface.minSpacingMm || depth >= MAX_BISECT_DEPTH) {
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
 * The dropped points along the straight line from `from` to `to`, against `surface` — `from`
 * itself included as the first point. Both ends' own Z is read from `surface.dropCutter`, never
 * stated by the caller, so the path and the surface it was dropped against cannot disagree.
 * Throws if either end is outside the surface's own reach — the CALLER decides the row's own
 * extent (typically the region's footprint, intersected with the raster's own bounds), not this
 * function; a row that would cross out of reach partway is the caller's own clipping to get right.
 */
export function dropRow(surface: ClSurface, from: readonly [number, number], to: readonly [number, number]): DroppedPoint[] {
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
