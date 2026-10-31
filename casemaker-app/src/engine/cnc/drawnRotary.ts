/**
 * #782 — THE DRAWN Z1 4TH-AXIS MODULE, as ONE model for every picture.
 *
 * Makera's own quick-start figures (`docs/market-research/raw/makera/Z1-Accessories-4Axis.txt`;
 * copies of the four figures under `docs/bench/img/2026-10-31-rotary/`) show:
 *
 *   - a long T-slot extrusion along X, on the two 4×11 locating pins — one under the headstock
 *     end and one under the tailstock end — with three M5×10 screws along its middle;
 *   - the HEADSTOCK at the left, an L: a vertical body carrying the spindle, with the stepper
 *     motor hanging off the FRONT (−Y) side, out beyond the extrusion;
 *   - a FOUR-JAW self-centring scroll chuck facing +X (Makera's page and the maintainer's
 *     correction 2026-10-30; the Carvera's sibling guide numbers four jaws too). Reverse jaws
 *     are fitted by default for larger work, standard jaws for small parts;
 *   - the TAILSTOCK at the right, sliding on the extrusion's rail, with a dead-centre cone
 *     facing −X and an adjustment knob on its +X end. It supports the free end when a job says
 *     `tailstock: true`, and parks at the rail's right end otherwise;
 *   - the A-axis zero is the CHUCK FACE (Makera: "the 0 position in X direction" at the chuck).
 *
 * CANONICAL FRAME — consumers translate it into their own:
 *   X = 0 at the chuck face, +X along the stock toward the tailstock;
 *   Y = 0 on the axis centreline, +Y away from the operator (the motor is at −Y);
 *   Z = 0 on the axis centreline, up positive.
 *
 *   - bed scene: translate by (chuck face machine X, axis machine Y, measured axis Z);
 *   - Holding's front view: project X and Z straight onto the page.
 *
 * PROVENANCE. The machine's own axis height is a reading (`datums.rotaryAxis`); the module's
 * other figures are ESTIMATES scaled from the four figures and are drawn provisional. Nothing
 * here feeds a check: the envelope and the keep-out bands stay `rotary/wrap.ts`.
 */

import type { Mm } from '@/types/units';
import type { RotaryJawMode } from '@/types/engraveJob';

// ── The PROVISIONAL module figures ─────────────────────────────────────────────────────────────
//
// Read from figure 1 (the top view) and figure 3 (the clamping view). None has been calipered
// (#238/#444); each is an ESTIMATE and every part it touches is drawn provisional.

/** The base extrusion's length along X, mm — it spans the two pins, 5 mm past each. */
export const ROTARY_BASE_LENGTH: Mm = 195;
/** How far the base's left end runs past the chuck face, mm. */
export const ROTARY_BASE_LEFT: Mm = 45;
/** The base's width across Y, mm — wide enough to cover the two pins' own Y offset. */
export const ROTARY_BASE_WIDTH: Mm = 70;
/** The base's height, mm, and the axis's height above the base's top. */
export const ROTARY_BASE_HEIGHT: Mm = 25;
export const ROTARY_AXIS_ABOVE_BASE: Mm = 35;
/** The T-slot grooves drawn along the base's top: two, 8 mm wide. */
export const ROTARY_SLOT_WIDTH: Mm = 8;
/** The headstock body's run along X (behind the chuck face), mm, and its half-width in Y. */
export const ROTARY_HEADSTOCK_DEPTH: Mm = 40;
export const ROTARY_HEADSTOCK_HALF_Y: Mm = 28;
/** The headstock body's top above the axis, and its bottom at the base's top, mm. */
export const ROTARY_HEADSTOCK_TOP: Mm = 25;
/** The motor's box: how far it hangs forward of the base and how far along X it runs. */
export const ROTARY_MOTOR_HALF_Y: Mm = 35;
export const ROTARY_MOTOR_OUT_Y: Mm = 70;
export const ROTARY_MOTOR_DEPTH: Mm = 35;
export const ROTARY_MOTOR_TOP: Mm = 10;
export const ROTARY_MOTOR_BOTTOM: Mm = -20;
/** The chuck's body: its length along +X from the face, and its radius (⌀80 envelope). */
export const ROTARY_CHUCK_DEPTH: Mm = 25;
export const ROTARY_CHUCK_RADIUS: Mm = 40;
/** A jaw's cross-section, its protrusion past the chuck face, and reverse jaws' extra step. */
export const ROTARY_JAW_SIZE: Mm = 12;
export const ROTARY_JAW_PROTRUSION: Mm = 22;
export const ROTARY_REVERSE_STEP: Mm = 6;
/** The tailstock: its body's length, half-width, the cone's length, and the knob's. */
export const ROTARY_TAILSTOCK_LENGTH: Mm = 35;
export const ROTARY_TAILSTOCK_HALF: Mm = 22;
export const ROTARY_CONE_LENGTH: Mm = 10;
export const ROTARY_CONE_HALF: Mm = 3;
export const ROTARY_KNOB_LENGTH: Mm = 10;
export const ROTARY_KNOB_HALF: Mm = 6;
/** The jaws' rest radius when there is no stock to close on, mm — the chuck near closed. */
export const ROTARY_JAW_REST_RADIUS: Mm = 8;
/** The axis height above the bed's top when nothing has measured it, mm. PROVISIONAL. */
export const ROTARY_DEFAULT_AXIS_HEIGHT: Mm = 40;
/**
 * Where the module sits with nothing measured, from the LEFT locating pin (the one under the
 * headstock end): the base's left end is 5 mm past the pin, so the chuck face is at
 * pin + (45 − 5) = pin + 40. PROVISIONAL, like the pins themselves (#511).
 */
export const ROTARY_CHUCK_FACE_FROM_LEFT_PIN_X: Mm = 40;

// ── The parts ───────────────────────────────────────────────────────────────────────────────────

/** What a drawn part is, so a consumer can colour or label it without parsing ids. */
export type DrawnRotaryRole =
  | 'base'
  | 'slot'
  | 'headstock'
  | 'motor'
  | 'chuck'
  | 'jaw'
  | 'tailstock'
  | 'tailstock-cone'
  | 'tailstock-knob'
  | 'axis';

/** One box in the canonical frame, with what it is and how sure the drawing is of it. */
export interface DrawnRotaryPart {
  id: string;
  label: string;
  role: DrawnRotaryRole;
  min: [number, number, number];
  max: [number, number, number];
  /** `measured` only when the part rests on a reading; everything not calipered is provisional. */
  provenance: 'measured' | 'provisional';
}

export interface DrawnRotaryInput {
  /** The stock's diameter, mm — the jaws close on it. Null/absent: the jaws' rest radius. */
  stockDiameterMm?: number | null;
  /** The cuttable length from the chuck face, mm — the tailstock meets its far end. */
  stickoutMm?: number | null;
  /** Which jaws are fitted; reverse jaws carry a deeper step (Makera's default for larger work). */
  jawMode?: RotaryJawMode;
  /** Whether the tailstock is in (true) or parked at the rail's right end (false). */
  tailstock?: boolean;
}

/** The base's right end in the canonical frame, mm. */
export const ROTARY_BASE_RIGHT: Mm = ROTARY_BASE_LENGTH - ROTARY_BASE_LEFT;

/**
 * The module's parts, in the canonical frame, in DRAW ORDER: the base, its slots, the headstock
 * and motor, the chuck, its four jaws, the tailstock (body, cone, knob), and the axis line last.
 */
export function drawnRotary(input: DrawnRotaryInput = {}): DrawnRotaryPart[] {
  const diameter = input.stockDiameterMm ?? null;
  const radius = diameter !== null && diameter > 0 ? diameter / 2 : ROTARY_JAW_REST_RADIUS;
  const stickout = input.stickoutMm ?? null;
  const jawMode = input.jawMode ?? 'reverse-inner';
  const tailstock = input.tailstock ?? false;
  const reverse = jawMode !== 'standard';
  const provisional = 'provisional' as const;

  const baseTop = -ROTARY_AXIS_ABOVE_BASE;
  const baseBottom = baseTop - ROTARY_BASE_HEIGHT;
  const parts: DrawnRotaryPart[] = [];
  const addPart = (
    id: string,
    label: string,
    role: DrawnRotaryRole,
    min: [number, number, number],
    max: [number, number, number],
    provenance: 'measured' | 'provisional' = provisional,
  ): void => {
    parts.push({ id, label, role, min, max, provenance });
  };

  // 1. The base extrusion, spanning both pins.
  addPart(
    'rotary-base',
    '4th-axis base extrusion',
    'base',
    [-ROTARY_BASE_LEFT, -ROTARY_BASE_WIDTH / 2, baseBottom],
    [ROTARY_BASE_RIGHT, ROTARY_BASE_WIDTH / 2, baseTop],
  );

  // 2. The T-slots, drawn as shallow grooves along X on the base's top.
  for (const [i, offset] of [-ROTARY_BASE_WIDTH / 4, ROTARY_BASE_WIDTH / 4].entries()) {
    addPart(
      `rotary-slot-${i + 1}`,
      '4th-axis base T-slot',
      'slot',
      [-ROTARY_BASE_LEFT + 6, offset - ROTARY_SLOT_WIDTH / 2, baseTop],
      [ROTARY_BASE_RIGHT - 6, offset + ROTARY_SLOT_WIDTH / 2, baseTop + 1],
    );
  }

  // 3. The headstock body: an L's vertical at the base's left end, from the base's top past the axis.
  addPart(
    'rotary-headstock',
    '4th-axis headstock',
    'headstock',
    [-ROTARY_BASE_LEFT, -ROTARY_HEADSTOCK_HALF_Y, baseTop],
    [-ROTARY_HEADSTOCK_DEPTH, ROTARY_HEADSTOCK_HALF_Y, ROTARY_HEADSTOCK_TOP],
  );

  // 4. The stepper motor, hanging off the FRONT (−Y) of the headstock, beyond the base.
  addPart(
    'rotary-motor',
    '4th-axis stepper motor',
    'motor',
    [-ROTARY_BASE_LEFT, -ROTARY_MOTOR_OUT_Y, ROTARY_MOTOR_BOTTOM],
    [-ROTARY_BASE_LEFT + ROTARY_MOTOR_DEPTH, -ROTARY_MOTOR_HALF_Y, ROTARY_MOTOR_TOP],
  );

  // 5. The chuck body, facing +X from the chuck face.
  addPart(
    'rotary-chuck',
    '4th-axis four-jaw chuck',
    'chuck',
    [0, -ROTARY_CHUCK_RADIUS, -ROTARY_CHUCK_RADIUS],
    [ROTARY_CHUCK_DEPTH, ROTARY_CHUCK_RADIUS, ROTARY_CHUCK_RADIUS],
  );

  // 6. The four jaws, on the scroll: one per cardinal side, their inner faces ON the stock's
  //    radius (that is what self-centring means), protruding past the chuck's face. Reverse jaws
  //    are deeper outward, not closer in — their step keeps the same grip diameter.
  const jawOuter = radius + ROTARY_JAW_SIZE + (reverse ? ROTARY_REVERSE_STEP : 0);
  const jawX0 = -2;
  const jawX1 = ROTARY_JAW_PROTRUSION;
  const half = ROTARY_JAW_SIZE / 2;
  const jaws: Array<[string, string, [number, number, number], [number, number, number]]> = [
    // Each names the side it grips; the four index around the scroll.
    ['rotary-jaw-1', '4th-axis chuck jaw (back)', [jawX0, radius, -half], [jawX1, jawOuter, half]],
    ['rotary-jaw-2', '4th-axis chuck jaw (front)', [jawX0, -jawOuter, -half], [jawX1, -radius, half]],
    ['rotary-jaw-3', '4th-axis chuck jaw (top)', [jawX0, -half, radius], [jawX1, half, jawOuter]],
    ['rotary-jaw-4', '4th-axis chuck jaw (bottom)', [jawX0, -half, -jawOuter], [jawX1, half, -radius]],
  ];
  for (const [id, label, min, max] of jaws) addPart(id, label, 'jaw', min, max);

  // 7. The tailstock: at the stock's far end when it is in, else parked at the base's right end.
  const tailX = tailstock
    ? stickout !== null && stickout > 0
      ? stickout
      : ROTARY_BASE_RIGHT - ROTARY_TAILSTOCK_LENGTH
    : ROTARY_BASE_RIGHT - ROTARY_TAILSTOCK_LENGTH;
  // The cone faces −X and its tip meets the stock's free end at X = tailX.
  addPart(
    'rotary-tailstock-cone',
    '4th-axis tailstock centre',
    'tailstock-cone',
    [tailX - ROTARY_CONE_LENGTH, -ROTARY_CONE_HALF, -ROTARY_CONE_HALF],
    [tailX, ROTARY_CONE_HALF, ROTARY_CONE_HALF],
  );
  addPart(
    'rotary-tailstock',
    '4th-axis tailstock',
    'tailstock',
    [tailX, -ROTARY_TAILSTOCK_HALF, baseTop],
    [tailX + ROTARY_TAILSTOCK_LENGTH, ROTARY_TAILSTOCK_HALF, ROTARY_TAILSTOCK_HALF + 10],
  );
  addPart(
    'rotary-tailstock-knob',
    '4th-axis tailstock knob',
    'tailstock-knob',
    [tailX + ROTARY_TAILSTOCK_LENGTH, -ROTARY_KNOB_HALF, -ROTARY_KNOB_HALF],
    [tailX + ROTARY_TAILSTOCK_LENGTH + ROTARY_KNOB_LENGTH, ROTARY_KNOB_HALF, ROTARY_KNOB_HALF],
  );

  // 8. The A axis itself, as a thin square bar along X from the chuck face to the tailstock.
  addPart(
    'rotary-axis',
    '4th-axis A axis',
    'axis',
    [0, -2, -2],
    [Math.max(tailX, 10), 2, 2],
  );

  return parts;
}

/** Translate a part's two corners into the consumer's frame — the one mapping every caller uses. */
export function translateRotaryPart(
  part: DrawnRotaryPart,
  by: readonly [number, number, number],
): { min: [number, number, number]; max: [number, number, number] } {
  return {
    min: [part.min[0] + by[0], part.min[1] + by[1], part.min[2] + by[2]],
    max: [part.max[0] + by[0], part.max[1] + by[1], part.max[2] + by[2]],
  };
}

/** The machine frame the module is placed at: the chuck face X, the axis Y and the axis Z. */
export interface RotaryPlacement {
  chuckFaceX: Mm;
  axisY: Mm;
  axisZ: Mm;
}

/**
 * Where the module sits on the machine.
 *
 * The axis height is the MEASURED datum when the profile has one (`datums.rotaryAxis`, #238) and
 * the bed's top plus the provisional 40 mm when it does not. The datum's own XY, when recorded,
 * places the module; otherwise the LEFT locating pin plus the base's constants does, and the
 * axis sits midway between the two pins in Y — the base is wide enough to cover their offset.
 */
export function rotaryPlacement(args: {
  datum: { value: Mm; at: readonly [Mm, Mm] | null } | null;
  pins: readonly (readonly [Mm, Mm])[];
  surfaceTopZ: Mm;
}): RotaryPlacement {
  const leftPin = args.pins[0] ?? [-200, -135];
  const rightPin = args.pins[1] ?? [-10, -105];
  const pinMidY = (leftPin[1] + rightPin[1]) / 2;
  return {
    chuckFaceX: args.datum?.at?.[0] ?? leftPin[0] + ROTARY_CHUCK_FACE_FROM_LEFT_PIN_X,
    axisY: args.datum?.at?.[1] ?? pinMidY,
    axisZ: args.datum?.value ?? args.surfaceTopZ + ROTARY_DEFAULT_AXIS_HEIGHT,
  };
}
