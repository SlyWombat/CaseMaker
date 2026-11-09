/**
 * #962 — THE FINISH'S MATERIAL FIELD PAST ITS FOOTPRINT, RED-FIRST.
 *
 * The manager's hold on the first attempt: answering the region's own `zTop` past the footprint is
 * not an upper bound on the real material there. A low region can sit beside a wall or land that
 * stands HIGHER, and B's disc-aware down-leg floor (61ea3dd6) samples the cutter's whole disc at
 * the landing — a disc overlapping that higher neighbour would floor at `zTop` and rapid into it.
 *
 * The honest answer past the footprint is the design's own top at that XY (the plan supplies it
 * from the goal/mesh heightfield), with the stock top as the last resort where even the design is
 * silent. This case pins the field directly: the low region's CL inside, the WALL's top just past
 * the edge (inside the cutter's radius), the stock top where the mesh says nothing. Before the
 * fix every outside point answered `zTop` — the low region's own top — which is below the wall.
 */

import { describe, expect, it } from 'vitest';

import { finishMaterial, type FinishOpOptions } from '../../src/engine/cnc/cam/model/ops/finish';
import type { ClSurface } from '../../src/engine/cnc/cam/model/clsurface';
import { linkIsClear, type MaterialField } from '../../src/engine/cnc/cam/model/linking';

const LEVEL_Z = -2;
const REGION_TOP = -2; // the low region's own zTop — what the held first attempt answered outside
const WALL_TOP = 3; // a wall just past the footprint, HIGHER than the region
const STOCK_TOP = 8; // where even the design is silent, the only bound left

/** The CL surface answers inside the low region's footprint [0,10]² and nowhere else. */
const clSurface: ClSurface = {
  dropCutter: (x, y) => (x >= 0 && x <= 10 && y >= 0 && y <= 10 ? -2.5 : null),
  toleranceMm: 0.005,
  minSpacingMm: 0.1,
  minSpacingSource: 'derived',
  minSpacingFromStepOverMm: 1,
  maxSpacingMm: 0.5,
  sampleCount: 0,
};

/**
 * The design's top: the low ground inside the region, a 3 mm-high wall in x ∈ [10, 12] — its face
 * 0.5 mm past the footprint edge, well inside the ⌀6 ball's 3 mm radius of any edge-flush landing
 * — and silent past x = 12 (outside the part's mesh, where only the stock top can be claimed).
 */
const materialTopAt = (x: number, _y: number): number | null => {
  if (x >= 10 && x <= 12) return WALL_TOP;
  if (x >= 0 && x <= 10) return -2;
  return null;
};

function field(overrides: Partial<Pick<FinishOpOptions, 'materialTopAt' | 'stockTopZMm'>> = {}): ReturnType<typeof finishMaterial> {
  return finishMaterial(
    { clSurface, materialTopAt, stockTopZMm: STOCK_TOP, ...overrides },
    LEVEL_Z,
  );
}

describe('#962 — the finish field past the footprint is the design top, never the region top', () => {
  it('inside the reach it is the level, else the CL, exactly as before', () => {
    const topAt = field().topAt;
    expect(topAt(5, 5)).toBe(Math.max(LEVEL_Z, -2.5)); // the CL, above the level
    expect(topAt(9.9, 9.9)).toBe(Math.max(LEVEL_Z, -2.5));
  });

  it('a wall just past the footprint (within the cutter radius) answers the WALL top, not the region top', () => {
    const topAt = field().topAt;
    expect(topAt(10.5, 5), 'the disc reaches this wall; a floor at the region top would rapid into it').toBe(WALL_TOP);
    expect(topAt(10.5, 5)).not.toBe(REGION_TOP);
    expect(topAt(11.9, 9)).toBe(WALL_TOP); // still the wall, still inside the ball's radius of the edge
  });

  it('where even the design is silent, the stock top is the bound', () => {
    expect(field().topAt(20, 5)).toBe(STOCK_TOP);
    expect(field().topAt(20, 5)).not.toBe(REGION_TOP);
  });

  it('with no design source the field states nothing past the footprint (the safe old default)', () => {
    const topAt = field({ materialTopAt: undefined, stockTopZMm: undefined }).topAt;
    expect(topAt(10.5, 5)).toBe(Number.POSITIVE_INFINITY);
  });
});

/**
 * B's repro on the review thread: a ⌀6 ball FEEDING at z = −5 past a footprint edge, with a real
 * wall at z = 0 outside it. The held fallback answered the region's own top (below the feed) at
 * the wall, so `linkIsClear` — which reads the same field — approved a STAY-DOWN FEED straight
 * through the wall, not just the down-leg rapid. The fixed field answers the wall's own design
 * top there, and the link is refused.
 */
describe("#962 — B's repro: a stay-down feed through a taller neighbour is refused", () => {
  const FEED_Z = -5;
  const REGION_TOP_HELD = -5; // the held answer: the low region's own top
  const WALL_TOP = 0;
  const BALL_R = 3;

  /** The low region's CL: below the feed z, answering only inside [0,10]². */
  const lowCl: ClSurface = {
    dropCutter: (x, y) => (x >= 0 && x <= 10 && y >= 0 && y <= 10 ? -5.5 : null),
    toleranceMm: 0.005,
    minSpacingMm: 0.1,
    minSpacingSource: 'derived',
    minSpacingFromStepOverMm: 1,
    maxSpacingMm: 0.5,
    sampleCount: 0,
  };
  const wallTop = (x: number, _y: number): number | null => (x >= 10 && x <= 12 ? WALL_TOP : null);

  /** The HELD field, written out: the CL inside, the region's own top everywhere else. */
  const heldField: MaterialField = {
    topAt: (x, y) => {
      const cl = lowCl.dropCutter(x, y);
      return cl !== null ? Math.max(FEED_Z - 1, cl) : REGION_TOP_HELD;
    },
  };
  const fixedField = finishMaterial({ clSurface: lowCl, materialTopAt: wallTop, stockTopZMm: 8 }, FEED_Z - 1);
  const link = {
    from: { x: 9.5, y: 5, z: FEED_Z },
    to: { x: 11, y: 5, z: FEED_Z },
    opts: (material: MaterialField) => ({
      material,
      clearanceZ: 5,
      tool: { radiusMm: BALL_R },
      feeds: { feed: 500, plungeFeed: 200 },
    }),
  };

  it('the held answer APPROVES the feed through the wall (the bug B found)', () => {
    expect(linkIsClear(link.from, link.to, link.opts(heldField))).toBe(true);
  });

  it('the fixed field REFUSES it — the wall is above the feed z', () => {
    expect(fixedField.topAt(10.5, 5)).toBe(WALL_TOP);
    expect(linkIsClear(link.from, link.to, link.opts(fixedField))).toBe(false);
  });
});
