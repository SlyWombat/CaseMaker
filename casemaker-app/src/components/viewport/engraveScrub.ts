/**
 * §5.7 — the DESIGN ↔ AS-CUT slider, resolved against the preview the worker handed us.
 *
 * The slider is a VIEW control, not a job setting: it chooses which of the preview's cumulative
 * stock states to draw and never asks the worker for anything. `EngravePreview.tsx` draws the mesh
 * this returns, the legend draws the control, and both read the same function so the picture and
 * the words beside it cannot disagree about what position the slider is in.
 *
 * The right end is the finished preview (`preview.stock`). Every step before it is one of the
 * worker's `stages`: position 0 is the uncut design (the faced blank), and position k has cut every
 * depth up to `stages[k].depth`. Cuts only exist at fixed depths, so there is nothing to show
 * between two of them — the stock is identical, and a continuous slider would imply a depth of cut
 * the program never makes.
 *
 * This module is pure: no store, no three.js, no canvas. That is what lets the mapping be tested in
 * plain Node, and what keeps the control out of `EngravePanel` (the job editor's own geometry).
 */

import { mm } from '@/engine/cnc/engrave/depthBounds';
import type { EngravePreview } from '@/workers/sim/engravePreview';
import type { NodeMeshOutput } from '@/workers/geometry/meshOutput';

/** A resolved slider position and the stock it draws. */
export interface EngraveScrubState {
  /** The clamped slider position: 0 = the uncut design, `max` = as cut. */
  index: number;
  /** The right end. Zero when the preview has no cut to scrub — the control is then not drawn. */
  max: number;
  /** The deepest cut applied at this position, mm. 0 at the design end. */
  depth: number;
  /** True at the as-cut end (and when there is nothing to scrub at all). */
  atCut: boolean;
  /** The stock to draw at this position. Work frame, like every preview mesh. */
  mesh: NodeMeshOutput;
}

/**
 * Resolve `stage` (the store's slider position, or `null` for "as cut") against `preview`.
 *
 * A stored position can outlive the preview it was chosen on: the panel keeps the last picture on
 * screen while a newer one builds, and an edit can reduce the number of depths. The clamp is here,
 * so a stale index can only land on the nearest end rather than on an undefined stage.
 */
export function scrubStateAt(preview: EngravePreview, stage: number | null): EngraveScrubState {
  const max = preview.stages.length;
  const raw = stage === null || !Number.isFinite(stage) ? max : Math.trunc(stage);
  const index = Math.max(0, Math.min(raw, max));
  if (index >= max) {
    // The finished preview, including a job with no cuts at all (max = 0): `stock` is then the
    // faced blank, so every slider position would draw the same body and the control is hidden.
    return {
      index,
      max,
      depth: preview.floors.reduce((deepest, f) => Math.max(deepest, f.depth), 0),
      atCut: true,
      mesh: preview.stock,
    };
  }
  const at = preview.stages[index]!;
  return { index, max, depth: at.depth, atCut: false, mesh: at.mesh };
}

/** The position in words, for the legend's readout and the range input's accessible value. */
export function scrubWords(state: Pick<EngraveScrubState, 'index' | 'max' | 'depth'>): string {
  if (state.max === 0 || state.index === state.max) return 'as cut';
  if (state.index === 0) return 'design (uncut)';
  return `cut to ${mm(state.depth)} mm`;
}

/**
 * The floors the picture may draw at this position: a floor belongs to a cut that has happened, so
 * a floor deeper than the scrub position must not float inside solid stock. At the as-cut end every
 * floor is shown, exactly as it was before the slider existed.
 *
 * The epsilon is for depths that arrived by different arithmetic paths (a stage's depth and a
 * floor's depth are both numbers copied from the same cut, but a future stage builder could round);
 * it is far below the 0.001 mm the machine moves in, so it cannot pull in a floor one step deeper.
 */
export function floorsForScrub<T extends { depth: number }>(
  floors: readonly T[],
  state: Pick<EngraveScrubState, 'atCut' | 'depth'>,
): readonly T[] {
  if (state.atCut) return floors;
  return floors.filter((f) => f.depth <= state.depth + 1e-9);
}
