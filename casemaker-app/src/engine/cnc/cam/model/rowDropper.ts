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

function bisect(surface: ClSurface, a: DroppedPoint, b: DroppedPoint, depth: number, out: DroppedPoint[]): void {
  const segLen = Math.hypot(b.x - a.x, b.y - a.y);
  if (segLen <= 1e-9) {
    out.push(b);
    return;
  }
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  const mz = surface.dropCutter(mx, my);
  // The manager's ruling on footprint vs links: a row is CUT only where `clSurface` answers; a
  // stretch where it leaves the footprint and re-enters is a LINK, handed to `link()`'s own
  // material-state read, never a straight chord guessed across it. `a` and `b` are both known
  // reachable (every caller — `dropRow`'s own endpoints, or this function's own recursion — only
  // ever bisects between two already-valid points), so a null HERE means the straight line
  // between them crosses OUT of the footprint somewhere in between: exactly the footprint notch
  // this rule exists to catch, not a reason to fall back on the chord and cut across it.
  if (mz === null) {
    throw new Error(
      `cam/model/rowDropper: the row leaves the surface's own reach between (${a.x}, ${a.y}) and (${b.x}, ${b.y}) — a footprint notch, not a straight chord to guess across. The caller clips a row into separate footprint intervals and hands the gap between them to link(), per the manager's ruling on footprint vs links.`,
    );
  }
  const chordZ = (a.z + b.z) / 2;
  const departure = Math.abs(mz - chordZ);
  if (departure <= surface.toleranceMm) {
    out.push(b);
    return;
  }
  if (segLen / 2 <= surface.minSpacingMm || depth >= MAX_BISECT_DEPTH) {
    // A real discontinuity at the finest spacing this surface states. Hold the SHALLOWER of the
    // two known ends across the whole stretch, stepping vertically right at whichever end is the
    // DEEPER one — never a diagonal, which could dip the tool under the shallow side's own true
    // height partway across (exactly the gouge a smooth interpolation would risk here).
    if (a.z >= b.z) {
      // a is shallow (or equal): hold a's Z laterally all the way to b's own XY, THEN drop.
      out.push({ x: b.x, y: b.y, z: a.z });
      out.push(b);
    } else {
      // b is shallow: rise to b's Z right at a's own XY, so the whole stretch after that is level.
      out.push({ x: a.x, y: a.y, z: b.z });
      out.push(b);
    }
    return;
  }
  const mid: DroppedPoint = { x: mx, y: my, z: mz };
  bisect(surface, a, mid, depth + 1, out);
  bisect(surface, mid, b, depth + 1, out);
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
    bisect(surface, prev, next, 0, out);
    prev = next;
  }
  return out;
}
