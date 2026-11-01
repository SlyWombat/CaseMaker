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
 * #779 — THE MEASURED FRAME WINS. A registration writes the vise's place (`fixedJawFaceX`,
 * `jawStartY`, #600) into the active bed profile, and the plate is placed by it when the record
 * has it. Without one the relation comes from the LEFT locating pin and the drawn base's own
 * constants (`drawnVise.ts`'s `viseFrameFromPins`) — provisional, like the pins themselves
 * (#511). The stock's left edge is work X = 0 on the fixed jaw's face, and `jawStartY` decides
 * where along the 100 mm bar the clamp sits, so (with `viseJawShift`, #213 — a side strip moves
 * the jaw face off the part's edge):
 *
 *   machineX = workX + sacrificialShift.left + fixedJawFaceX
 *   machineY = workY − vise.jawStartY + jawStartY
 *
 * The bed plate's Z is NOT a machine read. The plate's top sits at the drawn vise's own base
 * bottom (`drawnVise.ts`: the jaw tops, less the provisional bar height and base thickness), so
 * the base reads as sitting ON the machine bed rather than floating above it or sinking into it.
 * The machine's own Z datum (bed top ≈ −80, `bedScene.ts`'s `BED_TOP_Z`) is not mapped here: it
 * needs a registration the engrave job does not carry, and "under the vise" is what the picture
 * asks for.
 *
 * PROVISIONAL, and stated as such where it is shown: the pin pair is #511's unmeasured placement
 * and the plate thickness is `bedScene.ts`'s `BED_PLATE_THICKNESS`, not a reading. Nothing here
 * feeds a gate; it is a picture.
 */

import type { SizedMachine } from './machine';
import type { Sacrificial, ViseParams } from '@/types/engraveJob';
import type { Mm } from '@/types/units';
import { VISE_FLOOR_DEPTH, Z1_VISE } from './fixture';
import { VISE_BASE_THICKNESS, viseFrameFromPins } from './drawnVise';
import { viseJawShift } from './sacrificial';
import { BED_PLATE_THICKNESS, PIN_PAIR } from './bedScene';
import type { ViseBedFrame } from '@/platform/locationClient';

/** One axis-aligned box, in the WORK frame, `{min, max}` like `viewportCamera`'s `SceneBox`. */
export interface BedPlateBox {
  min: [number, number, number];
  max: [number, number, number];
}

/** The machine's X of the vise's fixed jaw face with nothing measured: from the left pin. */
export const VISE_FIXED_FACE_MACHINE_X: Mm = viseFrameFromPins(PIN_PAIR[0]!).fixedJawFaceX;

/** The machine's Y of the jaw bar's centre with nothing measured: from the left pin. */
export const VISE_JAW_CENTER_MACHINE_Y: Mm =
  viseFrameFromPins(PIN_PAIR[0]!).jawStartY + Z1_VISE.jawLength / 2;

/**
 * The machine's bed plate (its usable work envelope) as one box in the WORK frame, sized from the
 * machine profile's own envelope and placed so the vise — already drawn at its work-frame position
 * by `viseBody` — sits on it at its real machine position.
 *
 * `frame` is the placement's recorded machine XY (measured by a registration, or typed), or null
 * to fall back to the pins plus the base's constants. The stock's length does not appear: the
 * plate is fixed on the machine, the vise is bolted down, and the mapping hangs on the fixed jaw
 * face and the bar's start — neither of which the stock's length moves.
 */
export function machineBedPlate(
  vise: ViseParams,
  sacrificial: Sacrificial,
  machine: SizedMachine,
  frame: ViseBedFrame | null = null,
): BedPlateBox {
  const shift = viseJawShift(sacrificial);
  const fromPins = viseFrameFromPins(PIN_PAIR[0]!);
  const fixedJawFaceX = frame?.fixedJawFaceX ?? fromPins.fixedJawFaceX;
  const jawStartY = frame?.jawStartY ?? fromPins.jawStartY;

  const xMin = machine.envelope.x.min - shift.left - fixedJawFaceX;
  const xMax = machine.envelope.x.max - shift.left - fixedJawFaceX;
  const yMin = machine.envelope.y.min - jawStartY + vise.jawStartY;
  const yMax = machine.envelope.y.max - jawStartY + vise.jawStartY;

  // The vise's drawn base bottom: the jaw tops (`−stockProud`) less the floor depth and the base
  // plate. `VISE_FLOOR_DEPTH` is the jaw-top-to-floor distance `drawnVise` draws the bars to.
  const topZ = -vise.stockProud - VISE_FLOOR_DEPTH - VISE_BASE_THICKNESS;

  return {
    min: [xMin, yMin, topZ - BED_PLATE_THICKNESS],
    max: [xMax, yMax, topZ],
  };
}
