import type { Mm } from '@/types';
import type { BuildOp } from './buildPlan';
import { difference, roundedRectPrism, translate } from './buildPlan';
import type { StackConnectorParams } from '@/types';

/**
 * Issue #854 item 2 — REGISTRATION, the companion of the stacking connector.
 *
 * The dovetail connector RETAINS: its key locks two parts together and resists
 * sliding apart. It does not make a stack SQUARE, and #149's header says so.
 * This is the other half: a telescoping pair that registers each case on the
 * one below before any key goes in.
 *
 *   • The LID's top face carries a raised RIDGE ring, just inside the case
 *     wall.
 *   • The SHELL's floor underside carries a matching GROOVE ring — the
 *     "skirt" is the floor and wall left OUTSIDE the groove — wide enough for
 *     the ridge plus a sliding clearance on each side.
 *
 * The groove is slightly DEEPER than the ridge is tall, so a stacked case
 * seats face-on-face (floor underside on the lid's top) and the ridge only
 * ever squares it laterally. Registration gives no retention and no vertical
 * clamping, exactly as the reviewed system separates the two (#149, behaviour
 * 1): a stack still needs keys to stay together, and a registered stack is not
 * held down by the skirt.
 *
 * PROVISIONAL, like every stacking number: the ridge width and the clearance
 * are chosen, not measured; the stacking-connector coupon is where they would
 * be settled. The ridge height follows the FLOOR, because that is what the
 * groove is cut into — a thin floor gets a shallow ridge rather than a floor
 * with its underside sliced through.
 */

/** Ridge thickness across the ring, mm. */
export const STACK_RIDGE_W: Mm = 1.6;
/** Gap between the case wall and the ridge's outer face, mm. */
export const STACK_RIDGE_INSET: Mm = 0.5;
/** Sliding clearance per side between ridge and groove, mm. */
export const STACK_RIDGE_CLEARANCE: Mm = 0.2;
/** How much deeper the groove is than the ridge is tall, mm — the face datum. */
export const STACK_GROOVE_RELIEF: Mm = 0.05;
/** Material the groove must leave under the floor's underside... i.e. keep the
 *  floor whole: the groove is cut UP into the floor, so the floor's remaining
 *  section is `floorThickness − depth`; never less than this, mm. */
export const STACK_FLOOR_KEEP: Mm = 0.6;

/** Ridge height for a given floor thickness, mm — shallow on a thin floor. */
export function stackRidgeHeight(floorThickness: Mm): Mm {
  return Math.max(0.5, Math.min(2.0, floorThickness - STACK_FLOOR_KEEP));
}

/** Groove depth for a given floor thickness, mm — the ridge plus the face datum. */
export function stackGrooveDepth(floorThickness: Mm): Mm {
  return stackRidgeHeight(floorThickness) + STACK_GROOVE_RELIEF;
}

export interface StackRegisterFrame {
  /** The case's outer envelope, mm. */
  outerX: Mm;
  outerY: Mm;
  cornerRadius: Mm;
  wallThickness: Mm;
  floorThickness: Mm;
  /** The lid's top face in the LID's own (local) Z — `LidDims.z`. */
  lidTopZ: Mm;
}

/** True when the project asks for registration. */
export function stackRegisterWanted(p: StackConnectorParams | undefined): boolean {
  return p?.register === true;
}

/**
 * The ring's inner/outer rectangles, in case coordinates: the outer face sits
 * `wallThickness + STACK_RIDGE_INSET` in from the envelope, the ring is
 * `STACK_RIDGE_W` thick. `grow` widens it outward/inward by a clearance.
 */
function ringRects(f: StackRegisterFrame, grow = 0): { x0: number; y0: number; x1: number; y1: number; r: number } {
  const o0 = f.wallThickness + STACK_RIDGE_INSET - grow;
  return {
    x0: o0,
    y0: o0,
    x1: f.outerX - o0,
    y1: f.outerY - o0,
    r: Math.max(0, f.cornerRadius - o0),
  };
}

/** One ring prism: outer rounded rect minus inner rounded rect, extruded z0..z1.
 *  Null for a case too small to hold the ring — the caller skips it. */
function ring(
  outer: { x0: number; y0: number; x1: number; y1: number; r: number },
  thickness: number,
  z0: number,
  z1: number,
): BuildOp | null {
  const w = outer.x1 - outer.x0;
  const d = outer.y1 - outer.y0;
  if (w <= 2 * thickness || d <= 2 * thickness) return null;
  const ringOuter = translate([outer.x0, outer.y0, z0], roundedRectPrism(w, d, z1 - z0, outer.r));
  const ringInner = translate(
    [outer.x0 + thickness, outer.y0 + thickness, z0 - 1],
    roundedRectPrism(w - 2 * thickness, d - 2 * thickness, z1 - z0 + 2, Math.max(0, outer.r - thickness)),
  );
  return difference([ringOuter, ringInner]);
}

/** The lid's ridge, in LID-LOCAL coordinates (`lidTopZ` is the lid's own top). */
export function buildStackRidge(f: StackRegisterFrame): BuildOp | null {
  const h = stackRidgeHeight(f.floorThickness);
  return ring(ringRects(f), STACK_RIDGE_W, f.lidTopZ, f.lidTopZ + h);
}

/**
 * The floor's groove, as a CUTTER in case coordinates: wider than the ridge by
 * the clearance on each side, and deeper than the ridge by the face relief.
 * Cut up from just under the floor's underside so the cut opens cleanly.
 */
export function buildStackGroove(f: StackRegisterFrame): BuildOp | null {
  const depth = stackGrooveDepth(f.floorThickness);
  const width = STACK_RIDGE_W + 2 * STACK_RIDGE_CLEARANCE;
  return ring(ringRects(f, STACK_RIDGE_CLEARANCE), width, -0.5, depth);
}
