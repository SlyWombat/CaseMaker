/**
 * #962 — THE ROUGH/SKIN MATERIAL FIELD PAST ITS GRID, RED-FIRST.
 *
 * `rough.ts`'s two material fields (the rough's target grid and the skin's standing grid) reported
 * `+Infinity` for anything outside the sampled grid. That is safe but expensive: B's disc-aware
 * down-leg floor (61ea3dd6) samples the cutter's whole disc at the landing, and every sample past
 * the grid's edge turns the rapid-to-floor split into a full plunge. The answer past the grid must
 * be a TRUE upper bound — the design's top there (the plan's goal/mesh heightfield), then the
 * stock top — never the region's own top, which a wall beside a low region can out-top (the
 * finish's own held fix, and the reason this helper is shared by both ops).
 */

import { describe, expect, it } from 'vitest';

import { gridMaterial } from '../../src/engine/cnc/cam/model/ops/rough';

const GRID_TOP = -2; // the low region's own target, the held answer if it had used zTop
const WALL_TOP = 3; // a wall just past the grid's edge, HIGHER than the region
const STOCK_TOP = 8; // where even the design is silent

/** The grid: answers inside [0,10]² and nowhere else, like `targetAt` past its bounds. */
const core = (x: number, _y: number): number | null => (x >= 0 && x <= 10 ? GRID_TOP : null);
/** The design: the low ground inside, a 3 mm wall in x ∈ [10, 12], silent past x = 12. */
const materialTopAt = (x: number, _y: number): number | null => (x >= 10 && x <= 12 ? WALL_TOP : null);

describe('#962 — the rough/skin field past its grid is the design top, never Infinity or the region top', () => {
  it('inside the grid it is the grid value, exactly as before', () => {
    const field = gridMaterial(core, { materialTopAt, stockTopZMm: STOCK_TOP });
    expect(field.topAt(5, 5)).toBe(GRID_TOP);
  });

  it('a wall just past the grid answers the WALL top — not Infinity (the old answer), not the region top', () => {
    const field = gridMaterial(core, { materialTopAt, stockTopZMm: STOCK_TOP });
    expect(field.topAt(10.5, 5)).toBe(WALL_TOP);
    expect(field.topAt(10.5, 5)).not.toBe(Number.POSITIVE_INFINITY);
    expect(field.topAt(10.5, 5)).not.toBe(GRID_TOP);
  });

  it('where even the design is silent, the stock top is the bound', () => {
    const field = gridMaterial(core, { materialTopAt, stockTopZMm: STOCK_TOP });
    expect(field.topAt(20, 5)).toBe(STOCK_TOP);
  });

  it('with no sources the field states nothing past the grid (the safe old default)', () => {
    const field = gridMaterial(core, {});
    expect(field.topAt(10.5, 5)).toBe(Number.POSITIVE_INFINITY);
  });
});
