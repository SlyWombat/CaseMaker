/**
 * #557 — the machine's usable work area (the bed plate the vise mounts on), positioned in the
 * WORK frame so the vise reads as seated on it at its real machine position.
 *
 * The engrave preview draws the vise and the stock in the WORK frame (origin at the stock's
 * top-front-left corner, `/Simulation.md` §2). The machine's bed is the 200 × 200 envelope in
 * MACHINE coordinates (X/Y in [-200, 0], Z in [-100, 0] — the Z1 homes to MAX, `machine.ts`). To
 * draw the bed under the vise the two frames must be related, and the relation is where the vise
 * is bolted to the bed.
 *
 * The vise's REAL position is the machine's locating-pin pair — the same provisional placement the
 * Machines card's picture uses (`bedScene.ts`'s `PIN_PAIR`, #511): its fixed jaw face sits at the
 * pins' X and the jaw's Y-centre at the pins' Y-midpoint. The stock is clamped in that vise with
 * its left edge at the fixed jaw face and `jawStartY` deciding where along the jaw bar the clamp
 * sits, so (with `sacrificialShift` from `viseJawShift`, #213 — a side strip moves the jaw face off
 * the part's edge):
 *
 *   machineX = workX + sacrificialShift.left + pinX
 *   machineY = workY − (jawStartY + jawLength / 2) + pinYMid
 *
 * The bed plate's Z is NOT a machine read. The plate's top sits one vise-bed-thickness below the
 * drawn vise's rails (`viseBody`, #508), so the vise's own provisional base plate reads as sitting
 * ON the machine bed rather than floating above it or sinking into it. The machine's own Z datum
 * (bed top ≈ −80, `bedScene.ts`'s `BED_TOP_Z`) is not mapped here: it needs a registration the
 * engrave job does not carry, and "under the vise" is what the picture asks for.
 *
 * PROVISIONAL, and stated as such where it is shown: the pin pair is #511's unmeasured placement
 * and the plate thickness is `bedScene.ts`'s `BED_PLATE_THICKNESS`, not a reading. Nothing here
 * feeds a gate; it is a picture.
 */

import type { MillProfile } from './machine';
import type { Sacrificial, ViseParams } from '@/types/engraveJob';
import type { Mm } from '@/types/units';
import { VISE_BAR_HEIGHT, VISE_BODY_DEPTH, VISE_BED_THICKNESS } from './fixture';
import { viseJawShift } from './sacrificial';
import { BED_PLATE_THICKNESS, PIN_PAIR } from './bedScene';

/** One axis-aligned box, in the WORK frame, `{min, max}` like `viewportCamera`'s `SceneBox`. */
export interface BedPlateBox {
  min: [number, number, number];
  max: [number, number, number];
}

/** The machine's X of the vise's fixed jaw face — the locating pins' X (they agree: −100). */
export const VISE_FIXED_FACE_MACHINE_X: Mm = PIN_PAIR[0]![0]!;

/** The machine's Y of the vise jaw's centre — the pins' Y-midpoint (provisional, #511). */
export const VISE_JAW_CENTER_MACHINE_Y: Mm = (PIN_PAIR[0]![1]! + PIN_PAIR[1]![1]!) / 2;

/**
 * The machine's bed plate (its usable work envelope) as one box in the WORK frame, sized from the
 * machine profile's own envelope and placed so the vise — already drawn at its work-frame position
 * by `viseBody` — sits on it at its real machine position.
 *
 * The stock's length does not appear: the plate is fixed on the machine, the vise is bolted at the
 * pins, and the mapping hangs on the fixed jaw face (work X = 0, the stock's left edge) and the jaw
 * centre (work Y = `jawStartY + jawLength / 2`) — neither of which the stock's length moves.
 */
export function machineBedPlate(
  vise: ViseParams,
  sacrificial: Sacrificial,
  machine: MillProfile,
): BedPlateBox {
  const shift = viseJawShift(sacrificial);
  const pinX = VISE_FIXED_FACE_MACHINE_X;
  const pinYMid = VISE_JAW_CENTER_MACHINE_Y;
  const jawCentreY = vise.jawStartY + vise.jawLength / 2;

  const xMin = machine.envelope.x.min - shift.left - pinX;
  const xMax = machine.envelope.x.max - shift.left - pinX;
  const yMin = machine.envelope.y.min + jawCentreY - pinYMid;
  const yMax = machine.envelope.y.max + jawCentreY - pinYMid;

  // The vise's own rails end at `railBottomZ = −stockProud − VISE_BAR_HEIGHT − VISE_BODY_DEPTH`
  // (`viseBody`); its base plate sits one `VISE_BED_THICKNESS` below that. The machine plate's top
  // is that same level, so the vise's base reads as resting on it.
  const topZ = -vise.stockProud - VISE_BAR_HEIGHT - VISE_BODY_DEPTH - VISE_BED_THICKNESS;

  return {
    min: [xMin, yMin, topZ - BED_PLATE_THICKNESS],
    max: [xMax, yMax, topZ],
  };
}
