/**
 * The depth limit a two-colour blank actually has (#285): the compiled solid sliced on the
 * printer's own layer grid, rather than the nominal membrane arithmetic.
 *
 * `buildLayerStack` (#178) has existed with no `src/` caller since it was written, precisely
 * because the number it produces is a fact about the PRINT — a colour boundary and a pocket roof
 * land where the slicer's layers put them, not where the design says (decision 27). This module
 * is its caller, and this module is the one place that decides whether a job has colour layers at
 * all: `job.stock.colour` (#166 via `fromBadge.ts`; `stock.print` before #492), absent for every job
 * that is not a badge.
 *
 * WHAT IT REPLACES, and what it does not. The stack's `maxDepthAt` is the running intersection of
 * the layers from the engraved face down, so a point over a pocket is simply not solid in the
 * layers above the pocket's ceiling and the limit comes out shallower with no pocket rectangle
 * anywhere in the code. That is a better answer than `keepOutLimitAt`'s nominal one wherever the
 * two differ, because it is on the printer's own layer grid. So the two are not summed: when a job
 * has a print, this limit IS the void limit, and the analytic one is what a job without a print
 * keeps using. There is never a second owner of the number the verifier enforces.
 *
 * `maxDepthAt` is a BREACH depth — "how deep before the cutter reaches a void" — and the whole
 * first affected layer is left uncut, so the answer is already on a layer line. #345 subtracts the
 * job's `boundaryMargin` from it, which is the one rule every bound now follows: the floor stays
 * `boundaryMargin` clear of the plane it must not cross. Over solid stock the sacrificial limit,
 * which keeps `minFloor`, is the shallower of the two, so the two rules never contradict each
 * other; over a void the stack's answer is what the sliced blank actually gives.
 *
 * The sacrificial material is NOT in the stack, and must not be: `buildLayerStack` is told the
 * part's outline and the voids in it, and nothing else. A side strip or an under-board sits
 * outside that outline, where the stack reports no material at all — so `limit` returns the
 * sacrificial answer unchanged there rather than reading the stack's "nothing here" as "no
 * cutting".
 *
 * The colour split is NOT part of this limit, and deliberately so. A `reveal` label crosses the
 * split by design, so a limit the verifier refused every move below would refuse the whole point of
 * a two-colour blank. It is a `below` bound for such a label (and an `above` one for a `surface`
 * label), checked per item in `engraveGeometry.ts` as `item-depth-bound`; this module exposes the
 * split's depth as a plain number for that check and for the panel.
 *
 * The sacrificial limit is still composed in, exactly as `jobDepthLimit` composes it: a void is a
 * fact about the blank, the sacrificial material a fact about the setup, and whichever is
 * shallower at a point wins.
 *
 * WORKER-ONLY, mostly. `buildLayerStack` needs the Manifold toplevel, so `stackDepthLimit` runs
 * where the geometry does — the sim worker, beside `engraveGenerate`. The one exception is the
 * colour boundary itself, which is grid arithmetic and so needs no wasm at all: `colourBoundaryFor`
 * is pure and is what the non-stack callers use (#285 review).
 */

import type { EngraveJob } from '@/types/engraveJob';
import type { Mm } from '@/types/units';
import { buildLayerStack, printedLayerGridOf } from '@/engine/cnc/layerStack';
import { defaultBoundaryMargin, splitDepthOf, voidFloor } from '@/engine/cnc/engrave/depthBounds';
import type { PartPlan } from '@/engine/cnc/engrave/partPlan';
import { sacrificialDepthLimit, type DepthLimit } from '@/engine/cnc/verify';
import type { ManifoldToplevel } from '@/workers/geometry/evaluateOp';

/** Why the limit at a point is what it is, in the two states a value can be in. */
export type DepthLimitReason = 'void' | 'stock';

export interface StackDepthLimit {
  /** The verifier's limit: `min(sacrificial, stack.maxDepthAt)` at each (x, y). */
  limit: DepthLimit;
  /** The colour boundary, mm below the engraved face, ON a real layer line (#178). */
  boundary: Mm;
  /**
   * What binds at (x, y): `'void'` where the solid itself cuts the limit short — a pocket or
   * cavity the stack found — and `'stock'` where the limit is the stock's own floor (or the
   * sacrificial height) and nothing in the blank is in the way.
   */
  reasonAt(x: Mm, y: Mm): DepthLimitReason;
  /** Free the stack's cross-sections. Idempotent; call it as soon as the verifier is done. */
  dispose(): void;
}

const EPS = 1e-9;

/**
 * The layer grid the plan carries for a PRINTED job that states a layer height, or `null` for a job
 * that does not. The ONE gate: a laminate has no printed layers at all, and a printed blank without
 * a layer height has no grid to snap to — both keep their pre-#285 answer (#492). `split` is still
 * the plan's part-frame colour change (`thickness − capMm`), so the stack's own boundary arithmetic
 * is unchanged.
 */
function gridOf(
  plan: PartPlan,
  job: EngraveJob,
): { thickness: Mm; split: Mm; layerHeight: Mm; firstLayerHeight: Mm } | null {
  const { thickness, split } = plan.stock;
  const grid = printedLayerGridOf(job.stock);
  if (grid === undefined || split === undefined) return null;
  return {
    thickness,
    split,
    layerHeight: grid.layerHeight,
    firstLayerHeight: grid.firstLayerHeight ?? grid.layerHeight,
  };
}

/**
 * Where the job's colour plane is, mm below the engraved face, or `null` when the job states no
 * two-colour facts (#285 review/#492).
 *
 * PURE. A printed blank's answer is on a real layer line (`colourBoundaryDepthOf` snaps it); a
 * laminate's is its stated cap, unsnapped (#492). No Manifold toplevel either way: the boundary is
 * a rule about the layer grid or the stock entry, not a measurement of the solid, so this answers
 * off `colourBoundaryDepthFor` without a Manifold toplevel. `engraveRegions` used to build the whole
 * stack just to read this one number and free it again, keeping the wasm live twice per generate and
 * once per preview keystroke for a value the grid already holds.
 *
 * THE SNAP IS CORRECT — DO NOT "FIX" IT BACK TO THE RAW SUBTRACTION (#221 slice C review). For a
 * PRINTED blank the boundary describes the printed part, and a print is layer-quantised. The thick
 * acceptance fixture's model is 3.81 mm with the colour change at 3.0 mm, whose raw difference is
 * 0.81 mm; printed at 0.2 mm layers the part is 19 layers = 3.80 mm, with the colour change at
 * layer 15, so the film physically is 0.80 mm below the top. The raw 0.81 is the model's arithmetic
 * and never existed as material. Where the run sheet states the print facts it prints the resolved
 * value with the raw beside it ("colour plane 0.80 mm below the top, from the file's 0.81 on
 * 0.2 mm layers"); there is deliberately no finding for this. A laminate's cap is not snapped; it
 * is the stock entry's stated number (#492).
 */
export function colourBoundaryFor(_plan: PartPlan, job: EngraveJob): Mm | null {
  return splitDepthOf(job);
}

/**
 * The job's depth limit from the layer stack, or `null` when the job states no print — in which
 * case the caller keeps `jobDepthLimit`, byte-identically to before #285.
 *
 * `plan` must be the SAME `PartPlan` the caller is cutting from (`toPartPlan(job)`): the stack
 * reads its outline, thickness and voids, and a plan built from a different job would slice a
 * different blank.
 */
export function stackDepthLimit(
  tl: ManifoldToplevel,
  plan: PartPlan,
  job: EngraveJob,
  margin: Mm = defaultBoundaryMargin(job),
): StackDepthLimit | null {
  const grid = gridOf(plan, job);
  if (grid === null) return null;

  const stack = buildLayerStack(
    tl,
    {
      stock: {
        outline: plan.stock.outline,
        thickness: grid.thickness,
        split: grid.split,
        keepOuts: plan.stock.keepOuts,
      },
    },
    grid.layerHeight,
    grid.firstLayerHeight,
  );

  const sacrificial = sacrificialDepthLimit(job.stock, job.sacrificial, {
    minFloor: job.minFloor,
    breakthrough: job.breakthrough,
  });

  let disposed = false;
  return {
    limit(x, y) {
      const base = sacrificial(x, y);
      const solid = stack.maxDepthAt(x, y);
      // Outside the PART the stack reports nothing — it models the blank's outline and the voids
      // in it, and has never been told about sacrificial material. `0` there means "no material",
      // not "no cutting": the sacrificial limit deliberately puts a strip or a board beside the
      // part and lets the cutter onto it, so a point the stack is empty at must not tighten
      // anything. Where the sacrificial limit is genuinely 0 (over air) it is returned as it was.
      if (solid <= EPS) return base;
      // #345 — the ceiling is a bound like any other: the floor keeps the margin clear of it, and
      // the clamp at 0 (a ceiling nearer the face than the margin) says "do not cut here".
      return Math.min(base, voidFloor(solid, margin));
    },
    boundary: stack.colourBoundaryDepth,
    reasonAt(x, y) {
      const solid = stack.maxDepthAt(x, y);
      // Below the sacrificial height means the SOLID stopped the cutter, not the setup: the stack
      // is shallower there than `thickness − minFloor` (or the strip's height) because a void took
      // the material out. That is the honest test — asking `keepOutLimitAt` instead would name a
      // void that a deeper one overlaps, or one that does not bind this point at all.
      return solid > EPS && solid < sacrificial(x, y) - EPS ? 'void' : 'stock';
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      stack.dispose();
    },
  };
}
