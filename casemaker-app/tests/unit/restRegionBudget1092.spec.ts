/**
 * #1092 (0f's rulings on land14) — THE REST TIP FIELD IS PER REGION, AND THE BUDGET STILL BITES.
 *
 * A drop-tip field was O(covered cells × the cutter's stencil). Built over the WHOLE goal at the
 * harness's 0.1 mm pitch that broke the 300 M budget for a ⌀3.175 rest on the set B tray's own grid
 * (1,361 × 1,061 cells) and on the #959 organizer — which refused every rest region there (the
 * land14 red: "rest: 7 regions could not be cut … over the 300000000 budget"). 0f's ruling: build
 * it on each rest REGION's bbox + 2r (reading goal cells out to the disc's reach), keep the budget
 * check for a pathological region, never coarsen the grid and never raise the budget.
 *
 * #1092 (0f's fast-dilation ruling, 2026-11-09) — the FLAT field is now the exact row dilation
 * (bit-identity pinned in dropTipFast1092), whose unit is GRID CELLS × ROWS IN THE DISC: 33 rows
 * for ⌀3.175 at 0.1 mm, not the 853-cell stencil. The row ceiling is calibrated to the same
 * wall-clock as the stencil's 300 M (150 M cell-rows ≈ 300 M stencil evaluations, ~1.5 s measured);
 * under it the whole tray goal fits, so the per-region crop is a work/memory saver rather than a
 * budget necessity. A pathologically large region still refuses, and that refusal is a STATED
 * finding.
 */
import { describe, expect, it } from 'vitest';

import { discRowCountFor, stencilCellsFor, tipFieldOpsFor } from '@/engine/cnc/cam/dropTip';
import { KNOWN_DEFAULTS } from '@/platform/defaultsClient';

// #1207 — the two tip-op budgets are shop keys now; the tests run at the recommendations.
const DEFAULT_MAX_FINISH_TIP_OPS = KNOWN_DEFAULTS['finish.maxTipOps']!.fallback;
const DEFAULT_MAX_FINISH_TIP_ROW_OPS = KNOWN_DEFAULTS['finish.maxTipRowOps']!.fallback;

const PITCH = 0.1;
/** The set B tray's own goal grid (`goal-hf.mts` header: 1,361 × 1,061 at 0.1 mm). */
const TRAY_NX = 1361;
const TRAY_NY = 1061;
const TRAY_GOAL_CELLS = TRAY_NX * TRAY_NY;
const REST_R = 3.175 / 2;
const FLAT = { radius: REST_R, ball: false };
const ROWS = discRowCountFor(REST_R, PITCH);

/** The crop a region's field is built on: bbox + 2 × (2r + pitch) margin, at the goal pitch. */
const cropSide = (regionMm: number): number => {
  const margin = 2 * REST_R + PITCH;
  return Math.ceil((regionMm + 2 * margin) / PITCH) + 1;
};
const cropOps = (wMm: number, hMm: number): number => cropSide(wMm) * cropSide(hMm) * ROWS;

describe('#1092 — the rest tip field is per region and the budget still applies', () => {
  it('the dilation unit is 33 rows (not the 853-cell stencil), and the whole tray goal now fits it', () => {
    expect(ROWS).toBe(33);
    expect(tipFieldOpsFor(FLAT, TRAY_NX, TRAY_NY, TRAY_GOAL_CELLS, PITCH)).toBeLessThanOrEqual(DEFAULT_MAX_FINISH_TIP_ROW_OPS);
    // The old stencil unit is exactly why the per-region crop landed: it refuses this grid.
    expect(TRAY_GOAL_CELLS * stencilCellsFor(REST_R, PITCH)).toBeGreaterThan(DEFAULT_MAX_FINISH_TIP_OPS);
  });

  it('pocket-scale regions are far inside the budget — including the organizer’s two refused regions', () => {
    for (const [name, regionMm] of [['tray pockets', 40], ['organizer pockets', 50]] as const) {
      const ops = cropOps(regionMm, regionMm);
      expect(ops, `${name}: ${ops} evaluations for a ${regionMm} mm region`).toBeLessThanOrEqual(DEFAULT_MAX_FINISH_TIP_ROW_OPS);
    }
    // The #1092 red: pocket-15 (101 × 66 mm bbox) and pocket-16 (101 × 101 mm) were refused under
    // the old unit (6.7e8 / 9.9e8); in the dilation unit both plan.
    expect(cropOps(101, 66), 'pocket-15').toBeLessThanOrEqual(DEFAULT_MAX_FINISH_TIP_ROW_OPS);
    expect(cropOps(101, 101), 'pocket-16').toBeLessThanOrEqual(DEFAULT_MAX_FINISH_TIP_ROW_OPS);
  });

  it('a pathologically large region (300 mm) still refuses — the stated finding, not a silent skip', () => {
    expect(cropOps(300, 300)).toBeGreaterThan(DEFAULT_MAX_FINISH_TIP_ROW_OPS);
  });
});
