/**
 * #1234 (planner v3 A7, stage 2) — THE FINISHING EDGE OVERRUN. Two pure helpers, no kernel of
 * their own: the caller passes the real Clipper2 offset/boolean, exactly as the pocket op takes
 * them.
 *
 * A ball touches a downhill surface on its downhill side, so to cut the surface right at the
 * stock's own edge its centre has to go PAST the edge, over air. `sidesReached` says which sides
 * of the stock the region's footprint actually reaches (its own boundary lies on the edge line);
 * `overrunFootprint` grows the footprint by the cutter's radius on the sides a caller has opened,
 * and only there. The caller owns the fixture answer (`ModelPlanInput.openEdges`, #1234/#1254): a region boundary on the
 * stock's edge is not by itself permission to leave it.
 */
import type { OffsetFn } from '@/engine/cnc/cam/pocket';
import type { Polygons } from '@/engine/cnc/cam/pocket';
import type { BooleanFn } from '@/engine/cnc/cam/engraveJob';

/** The stock's four sides in the work frame: x = 0, x = length, y = 0, y = width. */
export type StockSide = 'left' | 'right' | 'front' | 'back';

/**
 * Which sides of the stock the footprint reaches: a vertex within `tolMm` of that side's line.
 * The fit tolerance is the caller's own (`GOAL_FIT_TOLERANCE_MM` at the plan's call site) — a
 * region that stops short of the edge leaves stock beyond it that is not the part's to cut.
 */
export function sidesReached(
  footprint: Polygons,
  stock: { length: number; width: number },
  tolMm: number,
): StockSide[] {
  let left = false;
  let right = false;
  let front = false;
  let back = false;
  for (const ring of footprint) {
    for (const [x, y] of ring) {
      if (Math.abs(x) <= tolMm) left = true;
      if (Math.abs(x - stock.length) <= tolMm) right = true;
      if (Math.abs(y) <= tolMm) front = true;
      if (Math.abs(y - stock.width) <= tolMm) back = true;
    }
  }
  return [
    ...(left ? (['left'] as const) : []),
    ...(right ? (['right'] as const) : []),
    ...(front ? (['front'] as const) : []),
    ...(back ? (['back'] as const) : []),
  ];
}

/**
 * The footprint, grown past the stock's own edge by `radiusMm` on each side in `open`. Inside the
 * stock nothing changes; a side not in `open` gets nothing beyond it.
 *
 * Exactly: offset the footprint by the radius, keep only the part of that growth that lies past an
 * OPEN side (a keep rectangle covers the stock and extends `2 × radiusMm` past every closed side,
 * so growth beyond a closed side is removed with the rest), and union it back onto the footprint.
 * With no side open — or no radius — the footprint is returned as the same array.
 */
export function overrunFootprint(
  footprint: Polygons,
  stock: { length: number; width: number },
  radiusMm: number,
  open: readonly StockSide[],
  offset: OffsetFn,
  boolean: { union: BooleanFn; subtract: BooleanFn },
): Polygons {
  if (open.length === 0 || !(radiusMm > 0)) return footprint;
  const grown = offset(footprint, radiusMm);
  const outset = 2 * radiusMm;
  const minX = open.includes('left') ? 0 : -outset;
  const maxX = open.includes('right') ? stock.length : stock.length + outset;
  const minY = open.includes('front') ? 0 : -outset;
  const maxY = open.includes('back') ? stock.width : stock.width + outset;
  const keep: Polygons = [[[minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY]]];
  const beyond = boolean.subtract(grown, keep);
  if (beyond.length === 0) return footprint;
  return boolean.union(footprint, beyond);
}
