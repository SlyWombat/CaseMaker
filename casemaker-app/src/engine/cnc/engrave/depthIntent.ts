/**
 * The two-state depth control's arithmetic (#170, decision 20): what depth a stated intent means,
 * and which colour a floor lands in.
 *
 * Decision 20 (`/Fabrication.md` §4) is the control: a two-colour blank has exactly TWO outcomes
 * for a floor — it stays in the top colour or it comes through the bottom one — so the control
 * offers those two states and a numeric override, never a slider. Its 2026-10-06 caveat is why the
 * states are a statement of INTENT and not a rule the app enforces: with a flat-bottomed cutter the
 * floor of the cut IS a depth, so the states can be turned into one; a V-bit couples depth to
 * stroke width (#221), and when that lands the intent is `colour: top | bottom` and the STRATEGY
 * owns the depth.
 *
 * So this module holds two small, opposite readings, and nothing else:
 *
 *   - `depthForIntent` — the state the user pressed, turned into a depth: one printed layer on
 *     their side of the split. That is as close as a state can get to the plane it means while
 *     staying clear of it, and a printed layer is the only unit the printer can hold.
 *   - `floorColour` — a depth, turned back into the colour it lands in. The PREVIEW needs this one
 *     for every floor, including the many whose label states no intent at all.
 *
 * The boundary itself is not computed here. It is the layer stack's answer
 * (`colourBoundaryDepthFor`, #285/#345) and `splitDepthOf` is the one function that asks for it;
 * a second number kept beside this one is exactly what #345 spent an issue removing.
 */

import type { Mm } from '@/types/units';
import type { EngraveJob, EngraveLabel } from '@/types/engraveJob';
import { roundDepth, splitDepthOf } from './depthBounds';

/** The three states the schema carries: the two a control can press, and "no statement". */
export type DepthIntent = NonNullable<EngraveLabel['depthIntent']>;

/** The two colours a two-colour blank has, as decision 20 names them. */
export type FloorColour = 'top' | 'bottom';

/**
 * The blank's colour split as the CONTROL needs it: where the boundary is, and how tall one of the
 * printed layers either side of it is.
 *
 * Both numbers, together, because neither is any use to a two-state control alone — and because
 * asking for them separately at two call sites is how a depth comes to be written from a boundary
 * measured against a different layer height.
 */
export interface LabelSplit {
  /** Where the colour boundary lands below the engraved face, mm, ON a real layer line (#285). */
  depth: Mm;
  /** The blank's printed layer height, mm — the step each state moves off the boundary. */
  layerHeight: Mm;
}

/**
 * This job's split for the two-state control, or `null` when the blank states no print (#166/#285).
 *
 * `null` is not an error and not a missing measurement: a blank that declares no print has, as far
 * as the app holds any, no colour boundary — so it has no two outcomes to offer and the control is
 * not shown. That is why this returns the pair rather than the depth alone: the layer height is the
 * same fact's other half, and a caller that had the depth without it would have to go and find a
 * layer height somewhere, which is a second opinion about the blank in hand.
 */
export function jobSplit(job: Pick<EngraveJob, 'stock'>): LabelSplit | null {
  const depth = splitDepthOf(job);
  const print = job.stock.print;
  if (depth === null || print === undefined) return null;
  return { depth, layerHeight: print.layerHeight };
}

/**
 * The depth a stated intent means: one printed layer on that side of the colour split (decision 20).
 *
 * `surface` stays in the top colour, so the floor sits one layer ABOVE the boundary; `reveal` comes
 * through to the bottom one, so it sits one layer BELOW. One layer, and not "as near as can be
 * expressed": the boundary is itself a layer line, so a floor a hair off it is a floor the printer
 * may place on the wrong side, and the whole point of the state is which side the colour shows.
 *
 * A boundary within one layer of the engraved face leaves no room for a top-colour floor, and this
 * returns 0 rather than a negative depth — a negative depth is not a depth, and the app's own
 * findings say what is wrong with a blank that thin. The OTHER end is deliberately unclamped: the
 * ceiling is `thickness − minFloor`, a job field this function is not given, and the row already
 * marks a depth past it (`maxDepth`).
 *
 * The answer is quantised to the thousandth (`roundDepth`): both operands are layer lines the grid
 * builds as sums (`0.2 + 3 × 0.2`), so `0.8 − 0.2` comes back as `0.6000000000000001`, and the row
 * shows an unrounded depth in a number field while the checker judges it against the plane it
 * misses by a trillionth.
 *
 * `custom` is not accepted. An intent that says nothing about the colour has no depth to mean, so
 * the caller narrows to the two states that do before it gets here.
 */
export function depthForIntent(
  intent: 'reveal' | 'surface',
  boundaryDepth: Mm,
  layerHeight: Mm,
): Mm {
  const depth = roundDepth(
    intent === 'reveal' ? boundaryDepth + layerHeight : boundaryDepth - layerHeight,
  );
  return depth > 0 ? depth : 0;
}

/**
 * Which colour a floor lands in — `'top'` while it stops short of the split, `'bottom'` once it
 * reaches it — or `null` when the blank states no split and there is no second colour to be in.
 *
 * A floor EXACTLY at the boundary reads as `'bottom'`, and that is not a tie-break: the boundary is
 * the plane at which the top colour ends, so a cut that stops there has removed every layer of top
 * colour over its footprint and the bottom colour is what shows. Both states write a whole layer
 * clear of the plane (`depthForIntent`), so the exact case is a typed override's — and it is the
 * one the eye reads as "through".
 *
 * Read off the DEPTH, never off the label's `depthIntent`: the intent is what the user meant, the
 * depth is what the job will do, and when the two disagree `item-depth-bound` is the finding that
 * says so (#345). A preview that coloured by intent would draw the picture the user hoped for
 * rather than the one the cutter leaves.
 */
export function floorColour(depth: Mm, splitDepth: Mm | null): FloorColour | null {
  if (splitDepth === null) return null;
  return depth >= splitDepth ? 'bottom' : 'top';
}
