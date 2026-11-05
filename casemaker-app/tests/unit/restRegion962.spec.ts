/**
 * #962 — A COVERAGE REST CUTS THE STANDING CELLS, NOT THE CLEARED FLOOR AROUND THEM.
 *
 * The tray's ⌀3.175 coverage rest at the integration tip spent 601 s of feed over cells the
 * primary's own sweep had already taken below the 0.1 mm band (1,752 of its 1,766 feed moves),
 * against 7.8 s over cells the leftover actually marks as standing. The mask reaches the op; its
 * DILATION is the problem: the rest's region is the leftover mask grown by
 * `2r + stepOver + 0.25` (≈3.4 mm on the tray's ⌀3.175), and the pocket rings fill that grown
 * region — most of every ring is over cleared floor.
 *
 * The criterion pinned here: every rest feed point lies within the cutter's own radius (plus the
 * 0.25 mm margin the region carries) of a cell the leftover marks as standing — a point farther
 * than that cannot have its disc touch standing material, so feeding there is pure air travel —
 * and the standing strip is still cut. The dilation itself is 2r + 0.25, not r: `pocketLoops`
 * erodes by r before it rings, and a strip grown only to r leaves a region narrower than the
 * cutter's diameter and emits NO toolpath at all — the first fix at r lost six of the tray's
 * seven rest passes and 0.31 points of coverage.
 */
import { describe, expect, it } from 'vitest';

import { makeClipperOffset, makeClipperSubtract, makeClipperUnion } from '@/engine/cnc/cam/engraveJob';
import type { FeatureTree, PocketNode } from '@/engine/cnc/cam/model/features';
import { planPocketsForTree, type PlanPocketsResult } from '@/engine/cnc/cam/model/plan';
import { Z1 } from '@/engine/cnc/machine';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import { tl } from './helpers/manifoldExec';

const FLAT6: Tool = flatEndMill(6, { number: 1, id: 'flat-6', name: 'flat-6' });
const FLAT3175: Tool = flatEndMill(3.175, { number: 2, id: 'flat-3.175', name: 'flat-3.175' });

/** A 40 x 20 plate with one 36 x 16 pocket whose floor stands at −2. */
function tree(): FeatureTree {
  const outline: [number, number][][] = [[[0, 0], [40, 0], [40, 20], [0, 20]]];
  const pocket: [number, number][][] = [[[2, 2], [38, 2], [38, 18], [2, 18]]];
  const node: PocketNode = {
    id: 'p', floorZ: -2, mouthZ: 0, open: false, through: false,
    region: pocket, floors: [{ polygons: pocket, area: 576 }],
    islands: [], children: [], remainder: [], narrowest: 16,
  };
  return {
    frame: { up: [0, 0, 1], stockTop: 0, partTop: 0, partBottom: -2 },
    levels: [-2],
    top: { z: 0, floors: [], area: 0 },
    contour: { outline, area: 800, zTo: -2, frees: true, shoulders: [] },
    pockets: [node],
    rims: [], remainder: [], unreachable: [],
    report: { source: 'mesh', patches: 1, planarArea: 800, remainderArea: 0, tolerances: {} as never, slivers: [], notes: [] },
  };
}

/** The standing strip the leftover marks: a 4 x 2 mm island at (10, 9) — everything else cleared. */
const STRIP: [number, number][][] = [[[10, 9], [14, 9], [14, 11], [10, 11]]];
const STRIP_AREA = 8;

function plan(mask: [number, number][][]): PlanPocketsResult {
  const inStrip = (x: number, y: number): boolean => x >= 10 && x <= 14 && y >= 9 && y <= 11;
  return planPocketsForTree(tree(), {
    offset: makeClipperOffset(tl),
    houseFlats: [FLAT6, FLAT3175],
    stepDownMm: 1.0,
    feeds: { feedMmPerMin: 1000, plungeFeedMmPerMin: 300 },
    rapid: Z1.rapidEstimate,
    toolChangeSeconds: 12,
    spindleRpm: 12000,
    air: true,
    boolean: { union: makeClipperUnion(tl), subtract: makeClipperSubtract(tl) },
    // The #961 coverage rank: a candidate that leaves less of the goal standing wins.
    goalCoverage: (irs) => (irs.length >= 3 ? { leftoverCells: 10, coveredCells: 5000, cellAreaMm2: 0.01 } : { leftoverCells: 100, coveredCells: 5000, cellAreaMm2: 0.01 }),
    restRegion: () => mask,
  });
}

function restFeeds(result: PlanPocketsResult): { x: number; y: number }[] {
  const rest = result.ops.filter((op) => op.outcome.cutter === 'flat-3.175' || op.outcome.ir.tool.id === 'flat-3.175');
  return rest.flatMap((op) => op.outcome.ir.operations.flatMap((o) => o.moves.filter((m) => m.kind === 'feed').map((m) => ({ x: m.x, y: m.y }))));
}

describe('#962 — a coverage rest feeds only where the leftover stands', () => {
  it('builds a rest step for the leftover mask, and every feed point is within r of a standing cell', () => {
    const result = plan(STRIP);
    const feeds = restFeeds(result);
    expect(feeds.length, `ops: ${result.ops.map((o) => `${o.kind}:${o.outcome.ir.tool.id ?? o.outcome.cutter}`).join(', ')}`).toBeGreaterThan(0);
    const r = 3.175 / 2;
    const reach = r + 0.25;
    let far = 0;
    let worst = 0;
    for (const p of feeds) {
      const dx = p.x < 10 ? 10 - p.x : p.x > 14 ? p.x - 14 : 0;
      const dy = p.y < 9 ? 9 - p.y : p.y > 11 ? p.y - 11 : 0;
      const d = Math.hypot(dx, dy);
      if (d > reach + 1e-6) far++;
      if (d > worst) worst = d;
    }
    expect(far, `${far} of ${feeds.length} rest feed points are farther than the disc's reach ${reach} from the standing strip (worst ${worst.toFixed(2)} mm) — the rest is cutting cleared floor`).toBe(0);
  });

  it('the standing strip is still cut: a feed point lands on or beside it', () => {
    const result = plan(STRIP);
    const feeds = restFeeds(result);
    const onStrip = feeds.some((p) => p.x >= 10 - 1e-6 && p.x <= 14 + 1e-6 && p.y >= 9 - 1e-6 && p.y <= 11 + 1e-6);
    expect(onStrip, 'the rest never reached the cell the leftover marks as standing').toBe(true);
    expect(STRIP_AREA).toBe(8);
  });
});
