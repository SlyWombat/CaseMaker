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
 *   - `depthForIntent` — the state the user pressed, turned into a depth: clear of the split by one
 *     printed layer, or by the margin in force when that is further. One layer is as close as a
 *     state can get to the plane it means while staying on the printer's grid; the margin is what the
 *     app's own checker will hold the floor to, so a state that ignored it would write a depth
 *     `item-depth-bound` then refuses (#170 review).
 *   - `floorColour` — a depth, turned back into the colour it lands in. The PREVIEW needs this one
 *     for every floor, including the many whose label states no intent at all.
 *
 * The boundary itself is not computed here. It is the layer stack's answer
 * (`colourBoundaryDepthFor`, #285/#345) and `splitDepthOf` is the one function that asks for it;
 * a second number kept beside this one is exactly what #345 spent an issue removing.
 */

import type { Mm } from '@/types/units';
import type { EngraveJob, EngraveLabel } from '@/types/engraveJob';
import { printedLayerGridOf } from '@/engine/cnc/layerStack';
import { deeper, shallower, splitDepthOf } from './depthBounds';

/** The three states the schema carries: the two a control can press, and "no statement". */
export type DepthIntent = NonNullable<EngraveLabel['depthIntent']>;

/** The two colours a two-colour blank has, as decision 20 names them. */
export type FloorColour = 'top' | 'bottom';

/**
 * The blank's colour split as the CONTROL needs it: where the boundary is, and how far off it each
 * state writes its floor.
 *
 * Both numbers, together, because neither is any use to a two-state control alone — and because
 * asking for them separately at two call sites is how a depth comes to be written from a boundary
 * measured against a different step.
 */
export interface LabelSplit {
  /** Where the colour boundary lands below the engraved face, mm, ON a real layer line (#285). */
  depth: Mm;
  /**
   * How far clear of the boundary each state writes its floor, mm: ONE PRINTED LAYER
   * (`print.layerHeight`), or the margin in force when that is further — `max(layerHeight,
   * boundaryMargin)`, never less than either (#170 review).
   *
   * The layer is the unit the printer can hold, and at the shipped margin the two are the same
   * number, which is why one layer was the whole rule to begin with. They part on a job carrying a
   * margin of its own: a printed blank's dome makes `recommendMargins` offer more than one layer, and
   * `checkBounds` then holds every floor to that larger number whatever the grid says. Stepping by
   * the layer alone writes a floor INSIDE the margin — a depth `item-depth-bound` refuses and the
   * worker drops, while the #362 row beside it states the larger one.
   *
   * DEGENERATE where the margin wins: the floor is then no longer on a layer line, because the
   * boundary is a grid line and the step is not a multiple of the grid. That is deliberate — the
   * margin is a Z-error budget rather than a slicing fact, and a floor the printer would place
   * correctly is worth more than one it can name a layer for.
   */
  step: Mm;
}

/**
 * This job's split for the two-state control, or `null` when the blank states no print (#166/#285).
 *
 * `null` is not an error and not a missing measurement: a blank that declares no print has, as far
 * as the app holds any, no colour boundary — so it has no two outcomes to offer and the control is
 * not shown. That is why this returns the pair rather than the depth alone: the step is the same
 * fact's other half, and a caller that had the depth without it would have to go and find a layer
 * height somewhere, which is a second opinion about the blank in hand.
 *
 * `boundaryMargin` is the margin IN FORCE for this job (`effectiveMargins`), and it is REQUIRED for
 * the reason `LabelDepthInputs.boundaryMargin` is: `checkBounds` will hold every floor this control
 * writes to that number, and a default guessed here would be a second, invisible opinion about it —
 * one that agrees with the checker only while the job runs on the shipped default.
 *
 * The layer in that `max` is the blank's REGULAR one (`print.layerHeight`), which is not always the
 * grid's: a boundary can land on the FIRST layer's line, and that layer is its own size (decision
 * 27). A split sitting there puts each state's floor at that line ± a regular layer, so NEITHER one
 * is on the grid. Degenerate, and stated rather than corrected: the first line is a slicing fact, the
 * step is the layer the plate is overwhelmingly built from, and a control that stepped by 0.3 near
 * the face and 0.2 elsewhere would be keeping a second grid — the thing this module exists not to do.
 */
export function jobSplit(job: Pick<EngraveJob, 'stock'>, boundaryMargin: Mm): LabelSplit | null {
  const depth = splitDepthOf(job);
  if (depth === null) return null;
  // A laminate has no printed layer: the margin in force IS its step (#492). A printed blank steps
  // by its regular layer, or the larger margin.
  const grid = printedLayerGridOf(job.stock);
  return { depth, step: Math.max(grid?.layerHeight ?? 0, boundaryMargin) };
}

/**
 * The depth a stated intent means: a floor clear of the colour split on that state's side of it
 * (decision 20), by one printed layer or the margin in force, whichever is further.
 *
 * `surface` stays in the top colour, so the floor sits ABOVE the boundary by `at.step`; `reveal` comes
 * through to the bottom one, so it sits BELOW. A whole step, and not "as near as can be expressed":
 * the boundary is itself a layer line, so a floor a hair off it is a floor the printer may place on
 * the wrong side, and the whole point of the state is which side the colour shows. Where the margin
 * is the larger of the two it is the margin that sets the step — see `LabelSplit.step`.
 *
 * The step is applied in the DIRECTION OF THE BOUND and quantised that way (`deeper` going down,
 * `shallower` coming up), not to the nearest thousandth. `depth + step` is `rel`-free only in exact
 * arithmetic: `1.2 + 0.331` is `1.5310000000000001` to a float and the checker's own plane is the
 * rounded one, so a nearest-rounding that also stepped by the layer alone was the write that made
 * `item-depth-bound` refuse the app's own button (#362's epsilon review, and this one).
 *
 * A boundary within one step of the engraved face leaves no room for a top-colour floor, and this
 * returns 0 rather than a negative depth — a negative depth is not a depth, and the app's own
 * findings say what is wrong with a blank that thin. The OTHER end is deliberately unclamped: the
 * ceiling is `thickness − minFloor`, a job field this function is not given, and the row already
 * marks a depth past it (`maxDepth`).
 *
 * `custom` is not accepted. An intent that says nothing about the colour has no depth to mean, so
 * the caller narrows to the two states that do before it gets here.
 */
export function depthForIntent(intent: 'reveal' | 'surface', at: LabelSplit): Mm {
  const depth =
    intent === 'reveal' ? deeper(at.depth + at.step) : shallower(at.depth - at.step);
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
