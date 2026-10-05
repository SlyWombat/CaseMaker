import type { Mm, Vec3 } from '@/types/units';
import type { Sacrificial, SacrificialSide, ViseParams } from '@/types/engraveJob';
import type { FixtureEnvelope, ObstacleBox } from './setup';
import type { JobFinding } from './engrave/jobSetup';
import { hasSacrificial, noneSacrificial, stripHeight, viseJawShift } from './sacrificial';

/**
 * The fixture as an obstacle envelope (#203, decision 28, `/Simulation.md` §1.1).
 *
 * The part is HELD by the vise; what the tool must not HIT is the vise. Those are two
 * different things (decision 28): `Workholding` says *how* the part is held, this envelope
 * says *what is in the way* and belongs in `Setup.fixture`, not inside the `Workholding` union.
 *
 * The envelope is an INPUT with provenance — a shipped **default**, a **saved** measurement,
 * or a fresh **measurement** — never a catalogue lookup presented as truth. Every box is
 * grown by `uncertainty` before any collision check (#204), so a default can never be mistaken
 * for a measurement.
 *
 * V1 models the Z1 low-profile vise as exactly TWO boxes: the fixed jaw and the moving jaw.
 * The slot, the lip over the top edge, the screws and the body are deliberately NOT modelled
 * — #208 photographs and calipers the real vise, and refines the boxes only where a box is
 * shown to be wrong.
 *
 * The work frame is the job frame (`/Simulation.md` §2, `toSetup`): origin at the stock's
 * top-front-left corner, +X to the right along the jaws' clamping direction, +Y away from the
 * operator, Z = 0 on the stock's top face with cuts at negative Z.
 */

/**
 * How far the box extends below the stock's underside, mm. It only has to be "far enough that
 * nothing can pass under it" (/Simulation.md §1.1: the holder-into-part check), so this is a
 * generous depth, not a measured body height.
 *
 * PROVISIONAL (#208): the real vise body is unmeasured.
 */
export const VISE_BODY_DEPTH = 20;

/**
 * The minimum stock gripped below the jaw tops, mm, below which the part can lift.
 *
 * PROVISIONAL (#208): a placeholder threshold; #208's measurements and test cuts replace it.
 */
export const GRIP_MIN = 3;

/**
 * Where a dimension came from is the whole point (decision 28), so the default uncertainty is
 * a function of the source, never a bare constant at the call site.
 *
 * PROVISIONAL (#208): both bands are guesses until the real vise is measured.
 */
export function uncertaintyFor(source: ViseParams['source']): Mm {
  return source === 'default' ? DEFAULT_UNCERTAINTY : SAVED_UNCERTAINTY;
}

/** A default is not a measurement: the jaws may be anywhere in this band. PROVISIONAL (#208). */
const DEFAULT_UNCERTAINTY: Mm = 2;
/** A measurement still carries caliper/mounting error. PROVISIONAL (#208). */
const SAVED_UNCERTAINTY: Mm = 0.5;

/**
 * The working height a normal blank stands proud of the jaw tops by default, mm: how much of
 * the stock is out of the jaws so the cutter can reach it. PROVISIONAL (#208 A5 measures the
 * value a real vise wants); this is the cap on the stock-derived default below.
 */
export const DEFAULT_STOCK_PROUD: Mm = 4;

/**
 * How far a stock of `thickness` stands proud of the jaw tops by default, mm — the HONEST
 * default (#231 item 2).
 *
 * `stockProud` is a job input (`ViseParams.stockProud`) and stays one; this is only the value a
 * NEW job starts from when there is no saved vise. It used to be a bare 4 mm, which is not a
 * truth: on a stock at or under 4 mm thick — the 3.81 mm badge blank #165 cuts — a flat 4 mm is
 * taller than the whole blank and `validateVise` refuses it outright
 * (`vise-stock-proud-exceeds-thickness`), so the job had to override the vise by hand.
 *
 * So the default tracks the stock: the part stands proud by HALF its own thickness — never more
 * than the 4 mm working height — so at least as much of it is in the jaws as above them, on any
 * blank. On the 12 mm default blank this is exactly the shipped 4 mm, so nothing that used the
 * default changes. It is still unmeasured (`source: 'default'`), so `validateVise` warns.
 */
export function defaultStockProud(thickness: Mm): Mm {
  return Math.min(DEFAULT_STOCK_PROUD, thickness / 2);
}

/**
 * The shipped default `ViseParams` for the Z1 low-profile vise, for a job that has no saved
 * measurement. Published NOWHERE (/Fabrication.md §7.3): jaw capacity, jaw length, jaw height,
 * the slot and lip, and the fixed jaw's offset from the anchor pins are all unmeasured, so
 * every number here is a PROVISIONAL (#208) placeholder.
 *
 * `stockProud` here is the shipped working height, correct for the 12 mm default blank. A job on
 * a DIFFERENT stock must resolve its default through `viseForNewJob` (below), never from this
 * constant: `DEFAULT_VISE` knows no stock, so its 4 mm would refuse a thin blank.
 *
 * NOTE (#203): this is the ONE place the five placeholder numbers live. `engrave/defaults.ts`
 * imports `DEFAULT_VISE` for a new job's vise, and `engraveJobStore` passes a saved
 * `ViseParams` back in through `defaultEngraveJob(vise)` when settings holds one.
 */
export const DEFAULT_VISE: ViseParams = {
  stockProud: DEFAULT_STOCK_PROUD, // PROVISIONAL (#208): how far the top face stands above the jaw tops.
  fixedJawThickness: 15, // PROVISIONAL (#208): fixed jaw (LEFT, /Fabrication.md §7.3) width in X.
  movingJawThickness: 15, // PROVISIONAL (#208): moving jaw width in X.
  jawLength: 80, // PROVISIONAL (#208): jaw length in Y.
  jawStartY: -10, // PROVISIONAL (#208): jaw start relative to the stock's front edge (Y).
  source: 'default',
  uncertainty: DEFAULT_UNCERTAINTY,
};

/**
 * The vise a NEW `EngraveJob` starts from: the saved `ViseParams` from settings when one
 * exists, otherwise the shipped default. This is the seam the panel (#205) resolves a new job
 * through, so a saved measurement is picked up without retyping it.
 *
 * A job on a non-default stock passes `stock` so the shipped default's `stockProud` is derived
 * from that stock (#231 item 2) instead of the flat 4 mm that refuses a blank at or under 4 mm.
 * A SAVED or measured vise is never re-derived — the user's number is kept exactly, even when it
 * would refuse the stock, so the panel can still show why. Omitting `stock` keeps the shipped
 * value, so every pre-#231 caller is unchanged.
 *
 * The returned object is a copy — the caller may patch it without mutating settings.
 */
export function viseForNewJob(
  saved?: ViseParams,
  stock?: { thickness: Mm },
): ViseParams {
  if (saved) return { ...saved };
  if (!stock) return { ...DEFAULT_VISE };
  return { ...DEFAULT_VISE, stockProud: defaultStockProud(stock.thickness) };
}

/**
 * The Z1 low-profile vise as two obstacle boxes, in the WORK frame, mm. Returned UN-INFLATED:
 * consumers grow each box by `envelope.uncertainty` before checking (decision 28).
 *
 * The fixed jaw is the LEFT jaw (/Fabrication.md §7.3), so it sits at work X <= 0 with its
 * face on x = 0; the moving jaw sits at work X >= length with its face on x = length. Both
 * jaws' TOPS are at `Z = -stockProud` — below the stock's top face by however much the stock
 * stands proud. In Y the jaws span `[jawStartY, jawStartY + jawLength]`.
 *
 * `sacrificial` moves the FACES outward (#213 §2): when the job has material between the jaw
 * and the part (`viseJawShift`), the fixed jaw's face moves from x = 0 to
 * `−max(left strip thickness, under.overhang.left)` and the moving jaw's from x = L to
 * `L + max(right strip thickness, under.overhang.right)`. The jaw BODY keeps its thickness, so
 * the whole box translates outward. Absent (or no material) is the pre-#213 envelope exactly:
 * faces on the part's own edges.
 */
export function viseEnvelope(
  stock: { length: Mm; width: Mm; thickness: Mm },
  vise: ViseParams,
  sacrificial: Sacrificial = noneSacrificial(),
): FixtureEnvelope {
  const { length, thickness } = stock;
  const jawMinY = vise.jawStartY;
  const jawMaxY = vise.jawStartY + vise.jawLength;
  const boxMinZ = -(thickness + VISE_BODY_DEPTH);
  const jawTopZ = -vise.stockProud;
  const shift = viseJawShift(sacrificial);
  const boxes: ObstacleBox[] = [
    {
      id: 'vise-fixed-jaw',
      label: 'Vise fixed jaw (left)',
      min: [-shift.left - vise.fixedJawThickness, jawMinY, boxMinZ],
      // `0 - shift.left`, not `-shift.left`: the latter is `-0` when there is no shift, and a
      // `-0` bound makes boxesOverlap's strict `<` comparisons and the tests disagree about zero.
      max: [0 - shift.left, jawMaxY, jawTopZ],
    },
    {
      id: 'vise-moving-jaw',
      label: 'Vise moving jaw (right)',
      min: [length + shift.right, jawMinY, boxMinZ],
      max: [length + shift.right + vise.movingJawThickness, jawMaxY, jawTopZ],
    },
  ];
  // `measuredAt` is copied through with the provenance: the envelope must be able to say WHEN it
  // was measured, not only that it was (#203).
  return { boxes, source: vise.source, uncertainty: vise.uncertainty, measuredAt: vise.measuredAt };
}

/**
 * The ISO date (`YYYY-MM-DD`) for `ViseParams.measuredAt` / `FixtureEnvelope.measuredAt`. Takes
 * `now` so it stays pure and testable; the stores pass the clock when a measurement is recorded
 * ("Save as my vise" / "I just measured these", #203).
 */
export function todayISODate(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** Grow every bound of a box by `by` mm on every side. Negative `by` shrinks it. */
export function inflate(box: ObstacleBox, by: Mm): ObstacleBox {
  return {
    ...box,
    min: [box.min[0] - by, box.min[1] - by, box.min[2] - by] as Vec3,
    max: [box.max[0] + by, box.max[1] + by, box.max[2] + by] as Vec3,
  };
}

/**
 * True when the two boxes' INTERIORS overlap on all three axes. Boxes that merely touch — one
 * bound equal on a single axis — do NOT overlap, so a jaw seated flush against the stock is
 * not a collision.
 */
export function boxesOverlap(a: ObstacleBox, b: ObstacleBox): boolean {
  return (
    a.min[0] < b.max[0] &&
    b.min[0] < a.max[0] &&
    a.min[1] < b.max[1] &&
    b.min[1] < a.max[1] &&
    a.min[2] < b.max[2] &&
    b.min[2] < a.max[2]
  );
}

/**
 * How much material each jaw actually bears on, mm (#213 §2). `vise-grip-shallow` judges the
 * grip on what is really clamped, not on the raw stock: a side strip between the jaw and the
 * part is what the jaw grips, and an under-board whose overhang carries the jaw face out past
 * the part is what it grips too. The jaw face sits on `−max(strip thickness, board overhang)`
 * (`viseJawShift`), so whichever of the two is thicker is the one bearing on the face.
 *
 * A jaw can only reach as high as its top — `thickness − stockProud` above the part's bottom —
 * so a strip taller than that is gripped to the jaw top only, and a shorter one over its whole
 * height. An under-board lies entirely below the part's underside, within the jaw's full height,
 * so it is gripped over its own thickness.
 */
function grippedHeights(
  stock: { thickness: Mm },
  vise: ViseParams,
  sacrificial: Sacrificial,
): { left: Mm; right: Mm } {
  const partGrip = stock.thickness - vise.stockProud;
  const side = (strip: SacrificialSide | null, overhang: Mm): Mm => {
    // The strip bears when it is at least as thick as the board's overhang, else the board edge.
    if (strip && strip.thickness >= overhang) {
      return Math.min(stripHeight(strip, stock.thickness), partGrip);
    }
    const under = sacrificial.under;
    if (under && overhang > 0) return under.thickness;
    return partGrip; // the jaw is against the part itself
  };
  return {
    left: side(sacrificial.sides.left, sacrificial.under?.overhang.left ?? 0),
    right: side(sacrificial.sides.right, sacrificial.under?.overhang.right ?? 0),
  };
}

/**
 * Pure checks on the vise as data, before any geometry (#203). Codes the findings with the
 * same `JobFinding` the job validators use, so a panel can render them together.
 *
 * The grip check (`vise-grip-shallow`) is judged on the sacrificial stack (#213 §2): pass the
 * job's `Sacrificial` and it evaluates what the jaws actually grip, not the raw stock. Omitting
 * it is exactly the pre-#213 check — a job with no sacrificial material is unchanged.
 */
export function validateVise(
  stock: { length: Mm; width: Mm; thickness: Mm },
  vise: ViseParams,
  sacrificial: Sacrificial = noneSacrificial(),
): JobFinding[] {
  const findings: JobFinding[] = [];
  const { width, thickness } = stock;

  if (vise.stockProud <= 0) {
    findings.push({
      severity: 'error',
      code: 'vise-stock-not-proud',
      message:
        `The stock stands ${vise.stockProud} mm above the jaw tops — at or below the surface ` +
        `being cut, so the tool would run into the jaws.`,
    });
  }

  if (vise.stockProud >= thickness) {
    findings.push({
      severity: 'error',
      code: 'vise-stock-proud-exceeds-thickness',
      message:
        `The stock stands ${vise.stockProud} mm above the jaw tops on a ${thickness} mm stock ` +
        `— nothing is left in the jaws.`,
    });
  }

  // What the jaws grip: the weaker of the two jaws, the side that lets go first.
  const gripped = grippedHeights(stock, vise, sacrificial);
  const grip = Math.min(gripped.left, gripped.right);
  if (grip < GRIP_MIN) {
    const what = hasSacrificial(sacrificial) ? 'the material between the jaws' : 'the stock';
    findings.push({
      severity: 'warning',
      code: 'vise-grip-shallow',
      message:
        `Only ${grip} mm of ${what} is gripped below the jaw tops; under ${GRIP_MIN} mm ` +
        `the part can lift (PROVISIONAL threshold, #208).`,
    });
  }

  // The jaw's Y span, intersected with the stock's own Y range [0, width].
  const covered = Math.max(
    0,
    Math.min(vise.jawStartY + vise.jawLength, width) - Math.max(vise.jawStartY, 0),
  );
  if (covered < width / 2) {
    findings.push({
      severity: 'warning',
      code: 'vise-jaw-short',
      message:
        `The jaws span Y ${vise.jawStartY} to ${vise.jawStartY + vise.jawLength}, covering ` +
        `${covered} mm of the stock's ${width} mm width — less than half.`,
    });
  }

  if (vise.source === 'default') {
    findings.push({
      severity: 'warning',
      code: 'vise-default',
      message: 'Vise dimensions are unmeasured defaults (#208); collisions cannot be trusted yet.',
    });
  }

  return findings;
}
