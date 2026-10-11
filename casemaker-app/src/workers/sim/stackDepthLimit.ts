/**
 * The depth limit a two-colour blank actually has (#285): the compiled solid sliced on the
 * printer's own layer grid, rather than the nominal membrane arithmetic.
 *
 * `buildLayerStack` (#178) has existed with no `src/` caller since it was written, precisely
 * because the number it produces is a fact about the PRINT — a colour boundary and a pocket roof
 * land where the slicer's layers put them, not where the design says (decision 27). This module
 * is its caller, and this module is the one place that decides whether a job has colour layers at
 * all: `job.stock.print` (#166 via `fromBadge.ts`), absent for every job that is not a badge.
 *
 * WHAT IT REPLACES, and what it does not. The stack's `maxDepthAt` is the running intersection of
 * the layers from the engraved face down, so a point over a pocket is simply not solid in the
 * layers above the pocket's ceiling and the limit comes out shallower with no pocket rectangle
 * anywhere in the code. That is a better answer than `keepOutLimitAt`'s nominal one wherever the
 * two differ, because it is on the printer's own layer grid. So the two are not summed: when a job
 * has a print, this limit IS the void limit, and the analytic one is what a job without a print
 * keeps using. There is never a second owner of the number the verifier enforces.
 *
 * It is a BREACH limit, where the analytic one is a FLOOR limit. `maxDepthAt` answers "how deep
 * before the cutter reaches a void", so the whole first affected layer is left uncut and the
 * job's `minFloor` is not subtracted again — the margin and the floor would be two answers to one
 * question. Over solid stock the sacrificial limit, which does keep `minFloor`, is the shallower
 * of the two, so the two rules never contradict each other; over a void the stack's answer is
 * what the sliced blank actually gives.
 *
 * The sacrificial material is NOT in the stack, and must not be: `buildLayerStack` is told the
 * part's outline and the voids in it, and nothing else. A side strip or an under-board sits
 * outside that outline, where the stack reports no material at all — so `limit` returns the
 * sacrificial answer unchanged there rather than reading the stack's "nothing here" as "no
 * cutting".
 *
 * The colour boundary is NOT part of this limit, and deliberately so. A `reveal` label crosses
 * the boundary by design, so a boundary the verifier refused every move below would refuse the
 * whole point of a two-colour blank. It is enforced per item against the item's own
 * `depthIntent`, as `item-wrong-colour` (`engraveGeometry.ts`), and this module exposes it as a
 * plain number for that check and for the panel.
 *
 * The sacrificial limit is still composed in, exactly as `jobDepthLimit` composes it: a void is a
 * fact about the blank, the sacrificial material a fact about the setup, and whichever is
 * shallower at a point wins.
 *
 * WORKER-ONLY. `buildLayerStack` needs the Manifold toplevel, so this runs where the geometry
 * does — the sim worker, beside `engraveGenerate`. The main thread never builds a stack.
 */

import type { EngraveJob } from '@/types/engraveJob';
import type { Mm } from '@/types/units';
import { buildLayerStack } from '@/engine/cnc/layerStack';
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
 * The job's depth limit from the layer stack, or `null` when the job states no print — in which
 * case the caller keeps `jobDepthLimit`, byte-identically to before #285.
 *
 * `plan` must be the SAME `PartPlan` the caller is cutting from (`toPartPlan(job)`): the stack
 * reads its outline, thickness and voids, and a plan built from a different job would slice a
 * different blank.
 */
export function stackDepthLimit(tl: ManifoldToplevel, plan: PartPlan, job: EngraveJob): StackDepthLimit | null {
  const print = job.stock.print;
  const { split, layerHeight, firstLayerHeight } = plan.stock;
  if (print === undefined || split === undefined || layerHeight === undefined) return null;

  const stack = buildLayerStack(
    tl,
    {
      stock: {
        outline: plan.stock.outline,
        thickness: plan.stock.thickness,
        split,
        keepOuts: plan.stock.keepOuts,
      },
    },
    layerHeight,
    firstLayerHeight ?? layerHeight,
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
      return Math.min(base, solid);
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
