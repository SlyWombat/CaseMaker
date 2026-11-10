/**
 * #1073 — THE FLIP CHOICE, DERIVED WHERE IT IS PRINTED.
 *
 * The document stores exactly what the operator chose — `setups[i].flip = { method, axis }` — and
 * what the blank is: `stock.squareCorners`. Everything else about the flip follows from those two
 * records and is computed here, never stored. 6b's ruling: a stored derived boolean is wrong the
 * day the stock record changes.
 *
 * THE FENCED CORNER. In the seated (side-1) work frame the corners are FL (0,0), FR (W,0),
 * BL (0,H), BR (W,H), and the fence is the corner at (0,0). A flip is a 180° turn about a
 * horizontal axis, so side 2's fence corner is whichever side-1 corner that turn carries to (0,0):
 *
 *   - left↔right (x → W − x, z → −z, the bracket's own RY180): side 1's FR lands there;
 *   - front↔back (y → H − y, z → −z, RX180): side 1's BL lands there.
 *
 * The corner is a function of the AXIS alone — the method decides how the part is freed, not how
 * the blank turns — and it is never FL, because no 180° turn about a horizontal axis fixes a
 * corner.
 *
 * WHETHER IT IS SQUARE. The blank states its square corners in the Holding step, in this same
 * seated frame; absent states all four square (a dimensioned blank). The fenced corner on side 2
 * is square iff the side-1 corner that lands there is one of them — so a blank with one right
 * angle seated in side 1's fence reads `squareInFence: false` under EITHER axis (A's §2), and the
 * graphic, the sheet and the vendor method's refusal all say so from this one answer.
 */

import { orient, orientationOf, type Mat } from '@/engine/cnc/setups/orient';
import type { Orientation } from '@/engine/cnc/setups/types';
import type { SetupFlip, StockCorner } from '@/types/engraveJob';

/** The blank's stated square corners in the seated work frame; `undefined` reads all four. */
export type StatedSquareCorners = readonly StockCorner[] | undefined;

/** Canonical order — the corners are printed and read in one order. */
export const STOCK_CORNERS: readonly StockCorner[] = ['FL', 'FR', 'BL', 'BR'];

/**
 * #1073 — THE LOCATING BORE'S DIAMETER, mm. The bore is not a drill's own size: it is HELICAL
 * INTERPOLATION of an owned flat (the maintainer's shop is 1/8 in only — #977), and ⌀6 is the
 * hole the wired V2's ⌀2 tip enters with room to touch its walls from the centre. The hold's
 * `diameterMm` is this bore; the cutter is whatever flat bores it.
 */
export const FLIP_BORE_DIAMETER_MM = 6;

/** The corners the blank states as square: the stated set, deduped and canonically ordered, or all
 *  four when the stock states none. Always a fresh array. */
export function squareCornersOf(stated: StatedSquareCorners): StockCorner[] {
  if (stated === undefined) return [...STOCK_CORNERS];
  const set = new Set(stated);
  return STOCK_CORNERS.filter((c) => set.has(c));
}

/** The side-1 corner of the seated blank that ends in the fence on side 2, from the flip axis. */
export function fenceCornerFor(axis: SetupFlip['axis']): StockCorner {
  return axis === 'left-right' ? 'FR' : 'BL';
}

export interface FlipFenceFacts {
  /** The side-1 corner of the seated blank that ends in the fence on side 2. */
  fenceCorner: StockCorner;
  /** Whether `fenceCorner` is one of the blank's square corners. */
  squareInFence: boolean;
  /** Every square corner of the blank, canonical order (all four when the stock states none). */
  squareCorners: StockCorner[];
}

/**
 * The flip's fence facts, from the stock's stated square corners and the chosen axis. Pure and
 * total: it answers for any stock record, including one that states nothing (all four square) or
 * an empty list (no square corner).
 */
export function flipFenceFacts(
  stock: { squareCorners?: readonly StockCorner[] },
  flip: Pick<SetupFlip, 'axis'>,
): FlipFenceFacts {
  const squareCorners = squareCornersOf(stock.squareCorners);
  const fenceCorner = fenceCornerFor(flip.axis);
  return { fenceCorner, squareInFence: squareCorners.includes(fenceCorner), squareCorners };
}

/**
 * #1073 — THE FLIP'S TURN, as the machine makes it: the stock→machine half turn a hand performs
 * when it turns the blank over. left↔right is RY180 (x → −x, z → −z), front↔back is RX180
 * (y → −y, z → −z); both are proper rotations, never mirrors. Read from `orient`, the one place
 * that decides which axis a bottom-up mount turns about, so this cannot drift from the setup
 * engine's own matrices: the bracket's half turn IS left↔right and the vise's IS front↔back
 * (`flipAxisOf` states the same pairing).
 */
export function flipMatrix(axis: SetupFlip['axis']): Mat {
  const turned = orient('bottom', { kind: axis === 'left-right' ? 'bracket' : 'vise' }, { x: 1, y: 1, z: 1 });
  if (!turned.ok) throw new Error(`a bottom-up ${axis} flip must be holdable: ${turned.reason}`);
  return turned.matrix;
}

/**
 * #1073 — the orientation record a flipped setup carries: which stock face sits at each machine
 * face. `top`/`bottom` swap under either axis; left↔right swaps the left/right pair, front↔back
 * the front/back pair. Derived from the same matrix the goal and the holes go through.
 */
export function flipOrientation(axis: SetupFlip['axis']): Orientation {
  return orientationOf(flipMatrix(axis));
}

/**
 * #1073 — THE STORED PINS WHEN THE AXIS CHANGES. The holes are physical and fixed in side 1;
 * the setup's work frame is a reflection of it, so a pin's side-1 position is recovered through
 * the OLD axis's reflection and placed through the NEW one (each reflection is an involution of
 * the same box: x → L − x, or y → W − y).
 */
export function flipPinsForAxis(
  pins: readonly { x: number; y: number }[],
  stock: { length: number; width: number },
  from: SetupFlip['axis'],
  to: SetupFlip['axis'],
): { x: number; y: number }[] {
  const toSide1 = (p: { x: number; y: number }) => ({
    x: from === 'left-right' ? stock.length - p.x : p.x,
    y: from === 'front-back' ? stock.width - p.y : p.y,
  });
  const toFrame = (p: { x: number; y: number }) => ({
    x: to === 'left-right' ? stock.length - p.x : p.x,
    y: to === 'front-back' ? stock.width - p.y : p.y,
  });
  return pins.map((p) => toFrame(toSide1(p)));
}

/**
 * #1073 — SIDE 2'S Z0, CARRIED, IN MACHINE TERMS (6b's amendment A).
 *
 * "Z0₂ = Z0₁ − T" hides the frame. Side 1's registration gives the blank's top touch; the seat is
 * the bed datum the seat press measures; side 1 may have faced `facing₁` off the top. After the
 * turn, the blank's faced old top is the face ON THE SEAT, so side 2's top — the old bottom, the
 * rough underside nobody touches — sits at:
 *
 *     side 2's top (machine Z) = seat + T_measured − facing₁
 *
 * where `T_measured` is side 1's top touch less the seat. The SAME arithmetic for the frame and
 * the vendor method: both put the blank's/part's old bottom on the same seat.
 *
 * The corner Z touches on side 2 are the CHECK of the carried value, never its source: they must
 * read the carried number within the surface tolerance, and a touch outside the band STOPS with
 * the number — a chip under the blank is what it finds. Z0 is never re-derived from the rough
 * face.
 */
export interface FlipZ0Input {
  /** The bed's seat datum, machine Z — the datum the seat press measures. */
  seatMm: number;
  /** Side 1's top touch less the seat, mm. */
  thicknessMm: number;
  /** Side 1's facing depth, mm — 0 by default (plastic never faces). */
  facingMm?: number;
  /** The surface tolerance the corner Z check is judged within, mm. */
  toleranceMm?: number;
  /**
   * #1189 — the probe's `M491` reference at the side-1 run that measured the top this is carried
   * from. The sum above is a raw machine Z in that seating; the tip-referenced height
   * (`topMachineZ − probeRefZ`) is what survives a probe refit. Null/absent on a side-1 run from
   * before the key: the corner Z band is then not checked.
   */
  probeRefZ?: number | null;
}

export interface FlipZ0 {
  seatMm: number;
  thicknessMm: number;
  facingMm: number;
  /** Side 2's top in MACHINE Z, as the side-1 seating read it: seat + T_measured − facing₁. */
  topMachineZ: number;
  /** #1189 — the probe reference that raw value was measured at; null on a pre-upgrade record. */
  probeRefZ: number | null;
  /**
   * #1189 — the probe-INDEPENDENT top: `topMachineZ − probeRefZ`. Today's expected raw top is
   * `topTipRefMm + today's M491`, so the corner Z check survives a probe refit. Null without a
   * reference (the check is then skipped, and the run says so).
   */
  topTipRefMm: number | null;
  /** The band the side-2 corner Z touches must land in; null without a stated tolerance. */
  checkBand: { minMm: number; maxMm: number } | null;
  /** What the sheet prints: the three numbers, the sum, the carry shorthand and the check rule. */
  words: string[];
}

const fmt2 = (n: number): string => n.toFixed(2).replace('-', '−');

export function flipZ0(input: FlipZ0Input): FlipZ0 {
  const seatMm = input.seatMm;
  const thicknessMm = input.thicknessMm;
  const facingMm = input.facingMm ?? 0;
  const topMachineZ = Math.round((seatMm + thicknessMm - facingMm) * 1000) / 1000;
  const tolerance = input.toleranceMm;
  const checkBand =
    tolerance === undefined || !(tolerance > 0)
      ? null
      : { minMm: Math.round((topMachineZ - tolerance) * 1000) / 1000, maxMm: Math.round((topMachineZ + tolerance) * 1000) / 1000 };
  const words = [
    `Z0 on side 2 is carried from side 1, never touched on the rough underside — carried from side 1: ` +
      `Z0₁ − ${fmt2(thicknessMm)} mm. In machine terms side 2’s top sits at seat ${fmt2(seatMm)} + ` +
      `measured thickness ${fmt2(thicknessMm)} − side 1’s facing ${fmt2(facingMm)} = ${fmt2(topMachineZ)} mm.`,
    checkBand === null
      ? 'The corner Z touches on side 2 are the CHECK of that carried value, not its source: a reading outside ' +
        'the surface tolerance stops with the number — a chip under the blank is what it finds. Z0 is never ' +
        're-derived from the rough face.'
      : `The corner Z touches on side 2 are the CHECK of that carried value, not its source: each must read ` +
        `${fmt2(topMachineZ)} ± ${fmt2(tolerance!)} mm (${fmt2(checkBand.minMm)} to ${fmt2(checkBand.maxMm)}). ` +
        'A reading outside that band stops with the number — a chip under the blank is what it finds. Z0 is ' +
        'never re-derived from the rough face.',
  ];
  const probeRefZ = input.probeRefZ ?? null;
  return {
    seatMm,
    thicknessMm,
    facingMm,
    topMachineZ,
    probeRefZ,
    topTipRefMm: probeRefZ === null ? null : Math.round((topMachineZ - probeRefZ) * 1000) / 1000,
    checkBand,
    words,
  };
}
