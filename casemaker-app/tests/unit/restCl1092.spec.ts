/**
 * #1092 (0f's two-space rule) — THE STRIP, RED-FIRST AT THE MECHANISM.
 *
 * The rule: a coverage rest's region is CUTTER-CENTRE space — the previous cutter's standing
 * material (material space, its stamp above the pass level) reached within the rest cutter's
 * radius, intersected with the rest cutter's own admissible centres (CL space: its tip over the
 * GOAL at or below the pass level). It is traced WITHOUT `pocketLoops`' radius inset — the region
 * already is where the centre goes.
 *
 * Set B's wall-foot strip is the case that must survive: a pocket floor meets a vertical wall and
 * the rest's disc runs TANGENT — CL at `wall − r`, tip at the floor. The old material-space mask
 * was inset twice (the rounder's 2r + 0.25 dilation, then `pocketLoops`' r erosion), which is why
 * every rule that trimmed a mask cell moved the strip.
 *
 * This fixture is the mechanism in its simplest form: a 40 x 20 x 12 pocket, previous cutter
 * ⌀6 flat, rest ⌀3.175 flat at the floor. The caller hands the rest the centre-space region the
 * rest cutter may occupy — the pocket inset by r — and the trace must ring it directly: every
 * feed point at wall − r (within half a cell), none closer, and every wall reached.
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
const R = 3.175 / 2;

/** A 40 x 20 plate with one 36 x 16 pocket whose floor stands at −12, walls vertical. */
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

/** The rest cutter's centre space over this pocket: the pocket inset by its own radius. */
const CENTRES: [number, number][][] = [[[2 + R, 2 + R], [38 - R, 2 + R], [38 - R, 18 - R], [2 + R, 18 - R]]];

function plan(): PlanPocketsResult {
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
    goalCoverage: (irs) => (irs.length >= 3 ? { leftoverCells: 10, coveredCells: 5000, cellAreaMm2: 0.01 } : { leftoverCells: 100, coveredCells: 5000, cellAreaMm2: 0.01 }),
    restRegion: () => CENTRES,
  });
}

function restFeeds(result: PlanPocketsResult): { x: number; y: number; z: number }[] {
  return result.ops
    .filter((op) => op.outcome.ir.tool.id === 'flat-3.175')
    .flatMap((op) => op.outcome.ir.operations.flatMap((o) => o.moves.filter((m) => m.kind === 'feed').map((m) => ({ x: m.x, y: m.y, z: m.z }))));
}

describe('#1092 (0f) — the rest strip: CL at wall − r, tangent, without an inset', () => {
  it('the rest posts moves at wall − r along every wall and never closer', () => {
    const feeds = restFeeds(plan());
    expect(feeds.length, 'the rest emitted no moves').toBeGreaterThan(0);
    // The pocket's four walls: x = 2 and 38, y = 2 and 18.
    const HALF_CELL = 0.06; // half a 0.1 mm cell + float slack
    const dist = (p: { x: number; y: number }): number => Math.min(p.x - 2, 38 - p.x, p.y - 2, 18 - p.y);
    // NO move may stand closer to a wall than the cutter's radius — that is the disc entering the
    // wall. (Inner rings farther in are the pass's own step-over, and are fine: the acceptance
    // names the OUTERMOST ring, which the four wall checks below pin.)
    const tooClose = feeds.filter((p) => dist(p) < R - HALF_CELL);
    expect(tooClose, `${tooClose.length} rest moves stand closer to a wall than the cutter's radius ${R} (the disc would enter the wall)`).toHaveLength(0);
    // Every wall is actually reached by the outer ring (the tangent strip is cleaned on all sides).
    for (const [name, test] of [
      ['left', (p: { x: number }) => p.x - 2 <= R + HALF_CELL],
      ['right', (p: { x: number }) => 38 - p.x <= R + HALF_CELL],
      ['front', (p: { y: number }) => p.y - 2 <= R + HALF_CELL],
      ['back', (p: { y: number }) => 18 - p.y <= R + HALF_CELL],
    ] as const) {
      expect(feeds.some(test), `the ${name} wall's strip was not reached`).toBe(true);
    }
  });
});
