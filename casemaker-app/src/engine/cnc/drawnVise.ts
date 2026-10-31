/**
 * #779 — THE DRAWN Z1 LOW-PROFILE VISE, as ONE model for every picture.
 *
 * The bed scene (machine coordinates), the engrave preview (work frame) and the Holding step's
 * top view all read the parts below, so they cannot disagree about the vise's shape. The model
 * follows Makera's own quick-start figures (`docs/market-research/raw/makera/
 * Z1-Accessories-Low-Profile-Vise.txt`; copies of the seven figures under
 * `docs/bench/img/2026-10-31-vise/`):
 *
 *   - a base plate that spans the bed's width (X) over its front part, sitting on the two
 *     4×11 locating pins, with three grooved rails running along X and six M5×20 screws down
 *     through its floor;
 *   - the FIXED jaw bar at the base's far-left (−X) edge — its inner face is the stock's left
 *     edge — with the soft jaw's ledge facing +X;
 *   - the MOVING jaw bar on its carrier, riding the rails at the stock's own length from the
 *     fixed face (two blocks: the jaw in front, the carrier behind);
 *   - the clamping screw along X at the carrier's front-right, turned with a long hex key from
 *     the right.
 *
 * THE STOCK MOVES INTO THE VISE; the vise does not move to the stock. In this module's canonical
 * frame the fixed jaw face is fixed at X = 0 and the base runs from its far-left edge to the
 * bed's right edge; a short stock simply leaves most of the base empty toward +X.
 *
 * CANONICAL FRAME — consumers translate it into their own:
 *   X = 0 at the fixed jaw's inner face (the stock's left edge), +X toward the moving jaw;
 *   Y = 0 at the jaw bar's front end (`jawStartY`), +Y along the bar;
 *   Z = 0 at the jaw tops, down negative.
 *
 *   - bed scene: translate by (placement.fixedJawFaceX, placement.jawStartY, measured jaw top);
 *   - engrave preview: translate by (−shift.left, vise.jawStartY, −vise.stockProud);
 *   - Holding's picture: project X/Y straight onto the page.
 *
 * PROVINENCE. Every figure is either a calipered product constant (`fixture.ts`'s {@link Z1_VISE})
 * or a LABELLED PROVISIONAL one — the base's plate, its rails, the carrier, the screws. A part
 * that rests on a measured figure is `measured`; one that contains an unmeasured figure is
 * `provisional` and drawn dashed, so a guess can never wear a reading's clothes. Nothing here
 * feeds a check: the obstacle model stays `viseEnvelope` (`fixture.ts`).
 *
 * With a measured jaw top the drawn base's bottom can lie a millimetre or two INSIDE the bed
 * plate's drawn top, because the bar's 20 mm height is PROVISIONAL and the bed's own top is the
 * #511 provisional −80. The parts are drawn as the model states them and the bed scene's plate is
 * a picture, not a check; the difference is bounded by the two provisional figures and vanishes
 * when the calipers replace them (#444).
 */

import type { Mm } from '@/types/units';
import type { Sacrificial, ViseParams } from '@/types/engraveJob';
import { LEDGE_STEP, LEDGE_WIDTH, VISE_BAR_HEIGHT, Z1_VISE } from './fixture';
import { noneSacrificial, viseJawShift } from './sacrificial';
import type { FixtureEnvelope } from './setup';

// ── The provisional base figures ────────────────────────────────────────────────────────────────
//
// Figure 1.5 shows the base as a plate spanning the table's full width, its left end carrying the
// fixed jaw's seat, and its front part carrying three grooved rails. None of its own dimensions
// has been calipered (#444), so each is an ESTIMATE read from that figure and drawn provisional.

/** The base plate's length along X, mm: the table's own 200 mm width (figure 1.5). PROVISIONAL. */
export const VISE_BASE_LENGTH: Mm = 200;
/** How far the base runs past the fixed jaw's OUTER face at its left end, mm. PROVISIONAL. */
export const VISE_BASE_LEFT_MARGIN: Mm = 10;
/** How far the base runs past the bars at the front and back, mm. PROVISIONAL. */
export const VISE_BASE_Y_MARGIN: Mm = 8;
/** The base plate's thickness below the bars' floor, mm. PROVISIONAL. */
export const VISE_BASE_THICKNESS: Mm = 5;
/**
 * The base's right end in the canonical frame, mm: the 200 mm plate less the left margin and the
 * fixed jaw's own bar width. A stock near the base's left end leaves this whole run empty — the
 * picture's point.
 */
export const VISE_BASE_RIGHT_X: Mm = VISE_BASE_LENGTH - VISE_BASE_LEFT_MARGIN - Z1_VISE.fixedJawThickness;
/** The base's left end in the canonical frame, mm (the jaw's outer face less the margin). */
export const VISE_BASE_LEFT_X: Mm = -VISE_BASE_LEFT_MARGIN - Z1_VISE.fixedJawThickness;

/** The grooved rails across the base's top, mm — three, as figure 1.5 shows. PROVISIONAL. */
export const VISE_RAIL_COUNT = 3;
export const VISE_RAIL_WIDTH: Mm = 10;
/** How far a rail's land stands above the base's top, mm — a drawing height. PROVISIONAL. */
export const VISE_RAIL_RISE: Mm = 1.5;
/** The rails' fractions of the bar's length (Y): the stock's own line, and one either side. */
export const VISE_RAIL_Y_FRACTIONS: readonly number[] = [0.2, 0.5, 0.8];

/** The jaw carrier behind the moving jaw, mm — its length along X and how far its top sits below. */
export const VISE_CARRIER_WIDTH: Mm = 30;
/** PROVISIONAL: the carrier's top is this far below the jaw tops, mm. */
export const VISE_CARRIER_TOP_DROP: Mm = 5;

/** The clamping screw's square stand-in, mm — and its short run past the base's right end. */
export const VISE_SCREW_SIZE: Mm = 5;
/**
 * How far the clamping screw's end runs past the base's right end, mm — a stand-in for the long
 * hex key the operator turns it with (figure 2.2). Kept short so the picture frames the VISE:
 * the key is a tool, not part of the fixture. PROVISIONAL.
 */
export const VISE_SCREW_OVERRUN: Mm = 15;
/** A lock screw's drawn head, mm. PROVISIONAL. */
export const VISE_LOCK_SCREW_SIZE: Mm = 4;
/** An M5 base screw's countersunk head, mm — the manual's six M5×20. */
export const VISE_BASE_SCREW_SIZE: Mm = 5;

/**
 * The opening the drawing uses when there is no stock and the fixture has no measured
 * `maxOpening`: the moving jaw parked 60 mm from the fixed face. PROVISIONAL, drawn dashed
 * "provisional opening".
 */
export const VISE_PARKED_OPENING: Mm = 60;

/**
 * Where the vise is when nothing has measured it: the fixed jaw's face sits this far right of
 * the LEFT locating pin, mm, and the bar's front end this far along +Y from the same pin.
 *
 * The base's left edge is 5 mm left of the pin (figure 1.2's pin sits just inside the base's
 * corner) and the jaw's outer face is `VISE_BASE_LEFT_MARGIN` + the bar's 10 mm right of that
 * edge, so the FACE is pin + 15. The pin is level with the bar's front end less 0 mm in Y —
 * level with it. PROVISIONAL, like the pins themselves (#511).
 */
export const VISE_FACE_FROM_LEFT_PIN_X: Mm = 15;
export const VISE_BAR_START_FROM_LEFT_PIN_Y: Mm = 0;

// ── The parts ───────────────────────────────────────────────────────────────────────────────────

/** What a drawn part is, so a consumer can colour or label it without parsing ids. */
export type DrawnViseRole =
  | 'base'
  | 'rail'
  | 'fixed-jaw'
  | 'fixed-ledge'
  | 'moving-jaw'
  | 'moving-ledge'
  | 'carrier'
  | 'clamp-screw'
  | 'lock-screw'
  | 'base-screw';

/**
 * How sure the drawing is of a part. `measured` rests only on calipered/vendor/measured figures;
 * `provisional` contains at least one unmeasured figure and is drawn dashed by every consumer.
 */
export type DrawnViseProvenance = 'measured' | 'provisional';

/** One box in the canonical frame, with what it is and how sure the drawing is of it. */
export interface DrawnVisePart {
  id: string;
  label: string;
  role: DrawnViseRole;
  min: [number, number, number];
  max: [number, number, number];
  provenance: DrawnViseProvenance;
}

export interface DrawnViseInput {
  /**
   * The distance between the jaw faces, mm — the stock's length when there is a stock (plus any
   * sacrificial shift, which the caller folds in). A caller with no stock passes the parked
   * opening and `openingKnown: false`.
   */
  openingMm: Mm;
  /**
   * Whether the opening is the STOCK's own length (measured/asserted) or a parked position. A
   * parked opening draws the moving jaw and its ledge provisional.
   */
  openingKnown?: boolean;
  /**
   * Whether the whole vise is at a KNOWN place (a measured registration, or a job already holding
   * this stock). With no measurement the fixed jaw is drawn at the pins' provisional position and
   * every part that depends on that place is provisional.
   */
  placementKnown?: boolean;
  /** The fixed jaw's own width, mm — the product's 10 mm unless a saved vise says otherwise. */
  fixedJawThickness?: Mm;
  /** The moving jaw's own width, mm. */
  movingJawThickness?: Mm;
  /** The bar's length along Y, mm — the product's 100 mm. */
  jawLength?: Mm;
}

/**
 * The vise's parts, in the canonical frame, in DRAW ORDER: the two jaw bars first (the preview's
 * `fixture[0]`/`fixture[1]` contract), then the ledges, the carrier, the base and rails, and the
 * screws last.
 */
export function drawnVise(input: DrawnViseInput): DrawnVisePart[] {
  const opening = Math.max(0, input.openingMm);
  const openingKnown = input.openingKnown ?? true;
  const placementKnown = input.placementKnown ?? true;
  const fixedW = input.fixedJawThickness ?? Z1_VISE.fixedJawThickness;
  const movingW = input.movingJawThickness ?? Z1_VISE.movingJawThickness;
  const jawLength = input.jawLength ?? Z1_VISE.jawLength;

  const jawTop = 0;
  const jawBottom = -VISE_BAR_HEIGHT;
  const baseTop = jawBottom;
  const baseBottom = baseTop - VISE_BASE_THICKNESS;
  const baseYMin = -VISE_BASE_Y_MARGIN;
  const baseYMax = jawLength + VISE_BASE_Y_MARGIN;
  const carrierInnerX = opening + movingW;
  const carrierOuterX = carrierInnerX + VISE_CARRIER_WIDTH;
  const placed: DrawnViseProvenance = placementKnown ? 'measured' : 'provisional';
  const moving: DrawnViseProvenance = placementKnown && openingKnown ? 'measured' : 'provisional';
  const provisional = 'provisional' as const;

  const parts: DrawnVisePart[] = [];
  const addPart = (
    id: string,
    label: string,
    role: DrawnViseRole,
    min: [number, number, number],
    max: [number, number, number],
    provenance: DrawnViseProvenance,
  ): void => {
    parts.push({ id, label, role, min, max, provenance });
  };

  // 1–2. The two jaw bars, faces on X = 0 and X = opening. First, in that order.
  addPart(
    'vise-fixed-jaw',
    'Vise fixed jaw (left)',
    'fixed-jaw',
    [-fixedW, 0, jawBottom],
    [0, jawLength, jawTop],
    placed,
  );
  addPart(
    'vise-moving-jaw',
    'Vise moving jaw (right)',
    'moving-jaw',
    [opening, 0, jawBottom],
    [opening + movingW, jawLength, jawTop],
    moving,
  );

  // 3–4. The soft jaws' ledges: 1.9 mm in from each face, their tops 3.1 mm below the jaw tops.
  addPart(
    'vise-fixed-ledge',
    'Vise fixed-jaw ledge',
    'fixed-ledge',
    [0, 0, jawTop - LEDGE_STEP - LEDGE_STEP],
    [LEDGE_WIDTH, jawLength, jawTop - LEDGE_STEP],
    placed,
  );
  addPart(
    'vise-moving-ledge',
    'Vise moving-jaw ledge',
    'moving-ledge',
    [opening - LEDGE_WIDTH, 0, jawTop - LEDGE_STEP - LEDGE_STEP],
    [opening, jawLength, jawTop - LEDGE_STEP],
    moving,
  );

  // 5. The carrier behind the moving jaw — the block that rides the rails.
  addPart(
    'vise-carrier',
    'Vise jaw carrier',
    'carrier',
    [carrierInnerX, 0, jawBottom],
    [carrierOuterX, jawLength, jawTop - VISE_CARRIER_TOP_DROP],
    provisional,
  );

  // 6. The base plate, under every jaw: the bed's width along X, the bars plus a margin in Y.
  addPart(
    'vise-base',
    'Vise base plate',
    'base',
    [VISE_BASE_LEFT_X, baseYMin, baseBottom],
    [VISE_BASE_RIGHT_X, baseYMax, baseTop],
    provisional,
  );

  // 7. The grooved rails along X, across the base's front part.
  const railInset = 6;
  const railY = (fraction: number): number => jawLength * fraction;
  for (let i = 0; i < VISE_RAIL_COUNT; i++) {
    const cy = railY(VISE_RAIL_Y_FRACTIONS[i] ?? 0.5);
    addPart(
      `vise-rail-${i + 1}`,
      `Vise rail ${i + 1}`,
      'rail',
      [VISE_BASE_LEFT_X + railInset, cy - VISE_RAIL_WIDTH / 2, baseTop],
      [VISE_BASE_RIGHT_X - railInset, cy + VISE_RAIL_WIDTH / 2, baseTop + VISE_RAIL_RISE],
      provisional,
    );
  }

  // 8. The clamping screw (the manual's "screw 2"), along X at the carrier's front-right, with
  //    the hex key that turns it from the right.
  const screwY = VISE_SCREW_SIZE + 1; // its centre, just behind the bar's front edge
  const screwZ = jawBottom + VISE_BAR_HEIGHT / 2;
  addPart(
    'vise-clamp-screw',
    'Vise clamping screw',
    'clamp-screw',
    [carrierInnerX + 2, screwY - VISE_SCREW_SIZE / 2, screwZ - VISE_SCREW_SIZE / 2],
    [VISE_BASE_RIGHT_X + VISE_SCREW_OVERRUN, screwY + VISE_SCREW_SIZE / 2, screwZ + VISE_SCREW_SIZE / 2],
    provisional,
  );

  // 9. The two lock screws the operator loosens: one on the carrier (1), one on the moving jaw (3).
  for (const [id, label, cx] of [
    ['vise-carrier-lock', 'Vise carrier lock screw', (carrierInnerX + carrierOuterX) / 2],
    ['vise-jaw-lock', 'Vise moving-jaw lock screw', opening + movingW / 2],
  ] as const) {
    addPart(
      id,
      label,
      'lock-screw',
      [cx - VISE_LOCK_SCREW_SIZE / 2, jawLength / 2 - VISE_LOCK_SCREW_SIZE / 2, jawTop - 2],
      [cx + VISE_LOCK_SCREW_SIZE / 2, jawLength / 2 + VISE_LOCK_SCREW_SIZE / 2, jawTop],
      provisional,
    );
  }

  // 10. The six M5×20 base screws, countersunk through the rails' floor: two rows of three.
  const columns = [0.12, 0.45, 0.8];
  for (const [row, fraction] of [0.12, 0.88].entries()) {
    for (const [i, column] of columns.entries()) {
      const cx = VISE_BASE_LEFT_X + (VISE_BASE_RIGHT_X - VISE_BASE_LEFT_X) * column;
      const cy = jawLength * fraction;
      addPart(
        `vise-base-screw-${row * columns.length + i + 1}`,
        'Vise base screw',
        'base-screw',
        [cx - VISE_BASE_SCREW_SIZE / 2, cy - VISE_BASE_SCREW_SIZE / 2, baseTop],
        [cx + VISE_BASE_SCREW_SIZE / 2, cy + VISE_BASE_SCREW_SIZE / 2, baseTop + 1],
        provisional,
      );
    }
  }

  return parts;
}

/** Translate a part's two corners into the consumer's frame — the one mapping every caller uses. */
export function translateVisePart(
  part: DrawnVisePart,
  by: readonly [number, number, number],
): { min: [number, number, number]; max: [number, number, number] } {
  return {
    min: [part.min[0] + by[0], part.min[1] + by[1], part.min[2] + by[2]],
    max: [part.max[0] + by[0], part.max[1] + by[1], part.max[2] + by[2]],
  };
}

/**
 * The vise's position when nothing has measured it: the fixed jaw's face and the bar's front
 * end, from the LEFT locating pin of the pair (the one under the base's left end). PROVISIONAL —
 * see {@link VISE_FACE_FROM_LEFT_PIN_X}.
 */
export function viseFrameFromPins(pin: readonly [number, number]): { fixedJawFaceX: Mm; jawStartY: Mm } {
  return {
    fixedJawFaceX: pin[0] + VISE_FACE_FROM_LEFT_PIN_X,
    jawStartY: pin[1] + VISE_BAR_START_FROM_LEFT_PIN_Y,
  };
}

/**
 * The jaw top when no datum has measured it, machine Z: the bed's top plus the base plate and
 * the bar. PROVISIONAL, composed only from labelled provisional figures.
 */
export const VISE_DRAWN_TOTAL_HEIGHT: Mm = VISE_BASE_THICKNESS + VISE_BAR_HEIGHT;

/**
 * The vise as the engrave preview DRAWS it, in the WORK frame (origin at the stock's
 * top-front-left corner, Z = 0 at the stock's top face) — the canonical parts above, translated
 * by the job's own assertions:
 *
 *   work X = canonical X − shift.left      (a sacrificial strip moves the fixed jaw outward)
 *   work Y = canonical Y + vise.jawStartY  (where the stock is clamped along the 100 mm bar)
 *   work Z = canonical Z − vise.stockProud (the jaw tops sit below the stock's top by this much)
 *
 * The opening is the stock's length plus both shifts, so the moving jaw's face lands exactly on
 * the part's (or its strip's) right edge. PROVISIONAL figures are translated through like the
 * rest; the preview draws every fixture box in its own grey, so a provisional part never claims
 * to be a measurement there — the bed scene, which colours by provenance, is the one that
 * separates them.
 *
 * Deliberately NOT `viseEnvelope`: the envelope is the conservative obstacle model whose boxes
 * run `VISE_BODY_DEPTH` below the stock and grow with its thickness, which is right for checks
 * and wrong for a picture. The drawn parts read no stock thickness at all — `stock` is
 * `{ length }`, a type-level promise — so a thick blank cannot grow the jaws.
 */
export function viseBody(
  stock: { length: Mm },
  vise: ViseParams,
  sacrificial: Sacrificial = noneSacrificial(),
): FixtureEnvelope {
  const shift = viseJawShift(sacrificial);
  const opening = stock.length + shift.left + shift.right;
  const parts = drawnVise({
    openingMm: opening,
    openingKnown: true,
    placementKnown: true,
    fixedJawThickness: vise.fixedJawThickness,
    movingJawThickness: vise.movingJawThickness,
    jawLength: vise.jawLength,
  });
  const by = [-shift.left, vise.jawStartY, -vise.stockProud] as const;
  return {
    boxes: parts.map((part) => {
      const b = translateVisePart(part, by);
      return { id: part.id, label: part.label, min: b.min, max: b.max };
    }),
    source: vise.source,
    uncertainty: vise.uncertainty,
    measuredAt: vise.measuredAt,
  };
}
