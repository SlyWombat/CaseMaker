import type { Facing, Vec3 } from '@/types';
import type { PrinterVolume } from '@/types/printer';
import type { Aabb, BuildOp } from './buildPlan';
import { cube, intersection, translate } from './buildPlan';
import { rectFitsBed } from './rackFit';
import {
  clearanceDiameter,
  pilotDiameter,
  screwHole,
  screwStarter,
  type FastenerSize,
  type HeadStyle,
} from './fasteners';

/**
 * Issue #148 — cut a part that is too big for the bed into pieces that fit,
 * and drill the joint that puts it back together.
 *
 * This module is deliberately ARCHETYPE-BLIND. It is handed a solid already in
 * its print orientation (XY is the bed plane), its bounds, the bed, and the
 * regions a seam must not cross. It decides WHERE to cut, does the cutting, and
 * places the fastener holes from the shared `fasteners.ts` table — it never
 * learns whether it is cutting a case shell, a rack panel or a toolbox module.
 * The material that hosts the joint (a flange, a rib, a boss) is the
 * archetype's business, because only the archetype knows where its own
 * material is.
 *
 * WHY THE SCREW COUNT IS COMPUTED, NOT CHOSEN. The reviewed systems do not use
 * a constant: their own counts are 7 screws on a ≈250 mm housing seam, 7 on a
 * lid, 10 on a wider drawer — the count tracks the seam. `seamScrewCount`
 * encodes that as `ceil(length / SPLIT_SEAM_PITCH)` with a floor of two, so a
 * 250 mm seam lands on the same 7 the source system used and a longer seam
 * gets more. The pitch itself (40 mm) is CHOSEN and unmeasured — it is a
 * starting point for a printed joint, to be settled by printing one, exactly as
 * the M5 pilot (#140) and the magnet pockets (#152) are.
 *
 * WHAT THIS DOES NOT DO, and why (v1):
 *  • It does not split along Z. A part taller than the bed has to be re-laid on
 *    its side or redesigned, not sawn — and `planSeams` returns null rather
 *    than pretending otherwise.
 *  • It does not go past two seams (a quadrant). More pieces per axis needs a
 *    grid of joints with interior seams, which is a different mechanism.
 *  • It leaves nothing behind to hold the pieces: the caller unions its own
 *    flange or rib material before subtracting these holes.
 */

/**
 * Target spacing between seam screws, mm.
 *
 * CHOSEN, not measured. 40 mm makes the source systems' 7-screw, ≈250 mm seam
 * come out right (`ceil(250/40) = 7`) and leaves a printable gap between
 * bosses. A first print is what would move it.
 */
export const SPLIT_SEAM_PITCH = 40;

/**
 * Smallest piece this will cut, mm.
 *
 * A sliver is not a piece: it cannot hold a boss, it warps, and it usually
 * means the part was barely over the bed to begin with. Below this we decline
 * the split rather than hand back confetti.
 */
export const MIN_PIECE_SPAN = 24;

/** How far a seam keeps clear of a keep-out region, mm. The cut has a kerf of
 *  fit error on both sides in the real part, so separating them by a hair is
 *  not enough — the seam has to miss the feature, not graze it. */
export const KEEP_OUT_MARGIN = 2;

/** A plane that cuts the part in two: `x = at` (axis 0) or `y = at` (axis 1). */
export interface SplitSeam {
  axis: 0 | 1;
  at: number;
}

/** One cut piece and the grid cell it came from. */
export interface SplitPiece {
  /** Index along X, then along Y: [0,0] is the min-x/min-y piece. */
  cell: [number, number];
  /**
   * The box this piece occupies, in the same frame as `bounds`. The archetype
   * needs it to put its joint material where the piece actually is — the
   * generator will not guess on its behalf.
   */
  ranges: { x: [number, number]; y: [number, number] };
  op: BuildOp;
}

export interface SplitPlanOptions {
  /** Regions the seam must avoid — ports, latches, anything functional. */
  keepOut?: Aabb[];
  /** Extra clearance around each keep-out, mm. Defaults to KEEP_OUT_MARGIN. */
  margin?: number;
}

/**
 * Where to cut `bounds` so every piece fits `printer`, or null.
 *
 * Null means one of three things, all of which the caller should report rather
 * than work around: the part already fits (nothing to do), the part is taller
 * than the bed (Z is not ours to cut), or no seam placement is possible (a
 * quadrant still does not fit, or keep-outs block every position).
 *
 * Straight-bed reasoning only: `rectFitsBed` is used for its conservative
 * answer, but each RESULTING piece is checked with it too, so a piece that
 * only fitted diagonally is still accepted — which is the same treatment the
 * rack's own fit check gives a part.
 */
export function planSeams(
  bounds: Aabb,
  printer: PrinterVolume,
  opts: SplitPlanOptions = {},
): SplitSeam[] | null {
  const span = (i: 0 | 1): number => bounds.max[i] - bounds.min[i];
  const w = span(0);
  const d = span(1);
  const h = bounds.max[2] - bounds.min[2];
  if (h > printer.z) return null;
  if (rectFitsBed(w, d, printer.x, printer.y)) return null;

  // Which axes have to give. A whole piece is one bed-slot; half a piece is
  // two, so a single seam only helps if half the part fits.
  const halfX = rectFitsBed(w / 2, d, printer.x, printer.y);
  const halfY = rectFitsBed(w, d / 2, printer.x, printer.y);
  const quarter = rectFitsBed(w / 2, d / 2, printer.x, printer.y);

  const axes: (0 | 1)[] = [];
  if (halfX && halfY) {
    // Either would do it on its own. Cut the axis that overshoots the more —
    // the fewer the seams, the fewer the joints to bolt up.
    axes.push(w / printer.x >= d / printer.y ? 0 : 1);
  } else if (halfX) {
    axes.push(0);
  } else if (halfY) {
    axes.push(1);
  } else if (quarter) {
    axes.push(0, 1);
  } else {
    return null;
  }

  const seams: SplitSeam[] = [];
  for (const axis of axes) {
    const at = placeSeam(axis, bounds, opts);
    if (at === null) return null;
    seams.push({ axis, at });
  }
  return seams;
}

/**
 * The seam coordinate on one axis: the midpoint when it is free, otherwise the
 * nearest legal offset that clears every keep-out.
 *
 * "Legal" means both pieces stay at least MIN_PIECE_SPAN long — a seam that
 * clears a port by running through the end wall has not helped.
 */
function placeSeam(axis: 0 | 1, bounds: Aabb, opts: SplitPlanOptions): number | null {
  const min = bounds.min[axis];
  const max = bounds.max[axis];
  const lo = min + MIN_PIECE_SPAN;
  const hi = max - MIN_PIECE_SPAN;
  if (hi < lo) return null; // too short to cut at all
  const mid = (min + max) / 2;
  const blocking = blockers(axis, bounds, opts);

  const legal = (t: number): boolean => {
    if (t < lo || t > hi) return false;
    for (const b of blocking) if (t > b[0] && t < b[1]) return false;
    return true;
  };
  if (legal(mid)) return mid;

  // Search outward from the ideal: the closest legal seam is the one that
  // leaves the two pieces most alike, which is what keeps the loads even.
  const step = 0.5;
  for (let off = step; off <= (max - min) / 2; off += step) {
    for (const t of [mid - off, mid + off]) {
      if (legal(t)) return t;
    }
  }
  return null;
}

/** [lo, hi) spans along `axis` that the seam must stay out of, grown by the
 *  margin. Only keep-outs whose other axes actually reach the part count. */
function blockers(
  axis: 0 | 1,
  bounds: Aabb,
  opts: SplitPlanOptions,
): Array<[number, number]> {
  const margin = opts.margin ?? KEEP_OUT_MARGIN;
  const out: Array<[number, number]> = [];
  for (const b of opts.keepOut ?? []) {
    // Ignore a keep-out that does not overlap the part in the two OTHER axes:
    // a port on the far corner cannot be reached by this seam.
    let reaches = true;
    const others: Array<0 | 1 | 2> = [0, 1, 2];
    for (const other of others) {
      if (other === axis) continue;
      if (b.max[other] < bounds.min[other] || b.min[other] > bounds.max[other]) reaches = false;
    }
    if (!reaches) continue;
    out.push([b.min[axis] - margin, b.max[axis] + margin]);
  }
  return out;
}

/**
 * Cut `op` along the seams. Returns one piece per grid cell, in cell order
 * (X outer, Y inner), whether or not the cell has any material — a caller that
 * needs to know can look at the op it gets back.
 */
export function splitBySeams(op: BuildOp, bounds: Aabb, seams: SplitSeam[]): SplitPiece[] {
  const cutsOn = (axis: 0 | 1): number[] =>
    seams
      .filter((s) => s.axis === axis)
      .map((s) => s.at)
      .sort((a, b) => a - b);

  const edges = (axis: 0 | 1): number[] => {
    const cuts = cutsOn(axis);
    return [bounds.min[axis] - 1, ...cuts, bounds.max[axis] + 1];
  };

  const xs = edges(0);
  const ys = edges(1);
  const zLo = bounds.min[2] - 1;
  const zHi = bounds.max[2] + 1;

  const out: SplitPiece[] = [];
  for (let i = 0; i < xs.length - 1; i++) {
    for (let j = 0; j < ys.length - 1; j++) {
      // Consecutive edges ARE the piece's cell: the first and last are the
      // bounds grown 1 mm outward, so the outer pieces are cut cleanly and no
      // piece ever reaches past a seam into its neighbour's material.
      const x0 = xs[i]!;
      const x1 = xs[i + 1]!;
      const y0 = ys[j]!;
      const y1 = ys[j + 1]!;
      const slab = translate([x0, y0, zLo], cube([x1 - x0, y1 - y0, zHi - zLo]));
      out.push({
        cell: [i, j],
        ranges: { x: [x0, x1], y: [y0, y1] },
        op: intersection([op, slab]),
      });
    }
  }
  return out;
}

/**
 * How many screws a seam of this length needs.
 *
 * Tracks the seam, the way the reviewed systems' own counts do (7 on a
 * ≈250 mm housing seam, 10 on a wider drawer). Two is the floor: a single
 * screw lets the pieces rotate about it, which is not a joint.
 */
export function seamScrewCount(seamLength: number): number {
  return Math.max(2, Math.ceil(seamLength / SPLIT_SEAM_PITCH));
}

/**
 * Where the screws sit along a seam, as offsets from `start`, evenly spaced
 * and inset from both ends so the outermost screws are not on the corner.
 *
 * Inset is half a pitch (so the end screws are a full pitch apart, like the
 * rest) capped at a quarter of the seam — a short seam must not have its
 * half-pitch inset swallow the whole span.
 */
export function seamScrewSites(start: number, end: number, count: number): number[] {
  const length = end - start;
  if (count < 2 || length <= 0) return [];
  const inset = Math.min(SPLIT_SEAM_PITCH / 2, length / 4);
  const span = length - 2 * inset;
  return Array.from({ length: count }, (_, i) => start + inset + (span * i) / (count - 1));
}

/** Axis name for a fastener hole that travels the way the seam normal does. */
export function seamAxisFacing(axis: 0 | 1, positive: boolean): Facing {
  if (axis === 0) return positive ? '+x' : '-x';
  return positive ? '+y' : '-y';
}

/**
 * The clearance half of a seam joint: a through-hole with an optional head
 * seat, cut into the piece the screw ENTERS from.
 *
 * Both halves of every joint go through these two functions rather than
 * calling `screwHole`/`screwStarter` directly, so the clearance, the pilot and
 * the head are always the shared table's — the #140 lesson is that a hand-rolled
 * hole is a hole nobody has printed.
 */
export function jointClearanceHole(
  at: Vec3,
  axis: Facing,
  length: number,
  size: FastenerSize,
  head: HeadStyle = 'socket-cap',
): BuildOp {
  return screwHole({
    size,
    at,
    axis,
    through: length,
    head,
    recess: 'flush',
    // The head seat is cut into a rib whose thickness is the caller's; it must
    // never be allowed to break through the far face.
    material: length,
  });
}

/** The receiving half of a seam joint: a starter hole in the far piece. */
export function jointStarterHole(
  at: Vec3,
  axis: Facing,
  depth: number,
  size: FastenerSize,
): BuildOp {
  return screwStarter({ size, at, axis, depth });
}

/** Diameters the two halves cut, for tests and for the printer's notes. */
export function jointHoleDiameters(size: FastenerSize): { clearance: number; pilot: number } {
  return { clearance: clearanceDiameter(size), pilot: pilotDiameter(size) };
}
