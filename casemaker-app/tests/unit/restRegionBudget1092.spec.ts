/**
 * #1092 (0f's land14 ruling) — THE REST TIP FIELD IS PER REGION, AND THE BUDGET STILL BITES.
 *
 * A drop-tip field is O(covered cells × the cutter's stencil). Built over the WHOLE goal at the
 * harness's 0.1 mm pitch it is over the 300 M budget for a ⌀3.175 rest on the set B tray's own grid
 * (1,361 × 1,061 cells) and on the #959 organizer — which refused every rest region there (the
 * land14 red: "rest: 7 regions could not be cut … over the 300000000 budget"). 0f's ruling: build
 * it on each rest REGION's bbox + 2r (reading goal cells out to the stencil's reach), keep the
 * budget check for a pathological region, never coarsen the grid and never raise the budget.
 *
 * This spec pins the arithmetic both ways: the whole goal is over budget (why per-region exists),
 * a pocket-scale region is under it (the tray and organizer plan again), and a pathologically
 * large region still refuses — the stated `rest-region-over-budget` finding, not a silent skip.
 */
import { describe, expect, it } from 'vitest';

import { DEFAULT_MAX_FINISH_TIP_OPS, stencilCellsFor } from '@/engine/cnc/cam/dropTip';

const PITCH = 0.1;
/** The set B tray's own goal grid (`goal-hf.mts` header: 1,361 × 1,061 at 0.1 mm). */
const TRAY_GOAL_CELLS = 1361 * 1061;
const REST_R = 3.175 / 2;

/** The crop a region's field is built on: bbox + 2 × (2r + pitch) margin, at the goal pitch. */
const cropCells = (regionMm: number): number => {
  const margin = 2 * REST_R + PITCH;
  const side = Math.ceil((regionMm + 2 * margin) / PITCH) + 1;
  return side * side;
};

describe('#1092 — the rest tip field is per region and the budget still applies', () => {
  it('the whole goal is over budget for a ⌀3.175 rest on the tray grid — why the field is per region', () => {
    const wholeGoal = TRAY_GOAL_CELLS * stencilCellsFor(REST_R, PITCH);
    expect(wholeGoal).toBeGreaterThan(DEFAULT_MAX_FINISH_TIP_OPS);
  });

  it('a pocket-scale rest region (40 mm and 50 mm bboxes) is inside the budget on the tray and the organizer', () => {
    for (const [name, regionMm] of [['tray pockets', 40], ['organizer pockets', 50]] as const) {
      const ops = cropCells(regionMm) * stencilCellsFor(REST_R, PITCH);
      expect(ops, `${name}: ${ops} evaluations for a ${regionMm} mm region`).toBeLessThanOrEqual(DEFAULT_MAX_FINISH_TIP_OPS);
    }
  });

  it('a pathologically large region still refuses — the stated finding, not a silent skip', () => {
    const ops = cropCells(200) * stencilCellsFor(REST_R, PITCH);
    expect(ops).toBeGreaterThan(DEFAULT_MAX_FINISH_TIP_OPS);
  });
});
