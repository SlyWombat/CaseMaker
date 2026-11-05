/**
 * #964 — TOOL-CHANGE BATCHING, RED-FIRST. The curved pipeline plans region by region (rough,
 * [rest], finish, pencil, then the next region's rough again), alternating the flat and the ball
 * once per remainder region with no actual ordering choice behind it — F measured this as 14
 * alternations / 29 tool changes on the tray (#964, comment 6649404153), about 2,651 s of real
 * machine time. `batchSameCutterRuns` (`sequence.ts`) groups same-cutter ops back together
 * wherever nothing depends on the gap between them.
 *
 * Two layers:
 *   A. The function itself, on hand-built mock ops — the exact shape of the problem (alternating
 *      cutters across independent regions) and the two invariants the issue named: a same-region
 *      pair never reverses, and a sentinel (the freeing contour) never moves.
 *   B. The real `planCurvedForTree` output on a two-region tree — confirms the alternation is
 *      real on actual ops, and that running them through `batchSameCutterRuns` collapses the
 *      program count without changing which moves exist (the "coverage/cut-into unchanged"
 *      check available without a real goal/STEP: the SET of posted moves, not their grouping,
 *      is what cut-into and coverage are computed from).
 */

import { describe, expect, it } from 'vitest';

import { batchSameCutterRuns } from '../../src/engine/cnc/cam/model/sequence';
import { tl } from './helpers/manifoldExec';
import { makeClipperOffset } from '../../src/engine/cnc/cam/engraveJob';
import { planCurvedForTree } from '../../src/engine/cnc/cam/model/plan';
import type { FeatureTree } from '../../src/engine/cnc/cam/model/features';
import { flatEndMill, type Tool } from '../../src/engine/cnc/tool';
import type { RapidEstimate } from '../../src/engine/cnc/cam/ir';
import type { Polygons } from '../../src/engine/cnc/cam/pocket';

// ---------------------------------------------------------------------------------------------
// A. batchSameCutterRuns() itself, on mock ops.
// ---------------------------------------------------------------------------------------------

interface MockOp { id: string; cutter: string; region: string; sentinel?: boolean }
const op = (id: string, cutter: string, region: string, sentinel = false): MockOp => ({ id, cutter, region, sentinel });

/** Counts RUNS the same way `planModelCam` builds `programs`: a run starts when the cutter key
 * changes from the previous op. */
function runCount(ops: readonly MockOp[]): number {
  let runs = 0;
  let last: string | null = null;
  for (const o of ops) {
    if (o.cutter !== last) { runs++; last = o.cutter; }
  }
  return runs;
}

describe('#964 batchSameCutterRuns — the function itself', () => {
  it('two independent regions, each rough(flat)+finish(ball)+pencil(ball): 4 runs become 2', () => {
    const ops = [
      op('r1-rough', 'flat', 'r1'), op('r1-finish', 'ball', 'r1'), op('r1-pencil', 'ball', 'r1'),
      op('r2-rough', 'flat', 'r2'), op('r2-finish', 'ball', 'r2'), op('r2-pencil', 'ball', 'r2'),
    ];
    expect(runCount(ops)).toBe(4); // flat, ball-ball, flat, ball-ball

    const batched = batchSameCutterRuns(ops, (o) => o.cutter, (o) => o.sentinel === true);
    expect(runCount(batched)).toBe(2); // flat-flat, ball-ball-ball-ball

    // Same-region order is never reversed: r1's own rough still comes before r1's own finish,
    // r2's rough before r2's finish, for every region independently.
    const indexOf = (id: string): number => batched.findIndex((o) => o.id === id);
    expect(indexOf('r1-rough')).toBeLessThan(indexOf('r1-finish'));
    expect(indexOf('r1-finish')).toBeLessThan(indexOf('r1-pencil'));
    expect(indexOf('r2-rough')).toBeLessThan(indexOf('r2-finish'));
    expect(indexOf('r2-finish')).toBeLessThan(indexOf('r2-pencil'));

    // The SET is unchanged — nothing added, nothing dropped, nothing duplicated.
    expect(batched.map((o) => o.id).sort()).toEqual(ops.map((o) => o.id).sort());
  });

  it('a rest step on a DIFFERENT (smaller) cutter, same region as the primary rough, keeps its own order', () => {
    const ops = [
      op('r1-rough', 'flat-6', 'r1'), op('r1-rest', 'flat-3', 'r1'), op('r1-finish', 'ball', 'r1'),
      op('r2-rough', 'flat-6', 'r2'), op('r2-finish', 'ball', 'r2'),
    ];
    const batched = batchSameCutterRuns(ops, (o) => o.cutter, () => false);
    const indexOf = (id: string): number => batched.findIndex((o) => o.id === id);
    // r1's own rough -> rest -> finish stays in that relative order even though rest is its own cutter group.
    expect(indexOf('r1-rough')).toBeLessThan(indexOf('r1-rest'));
    expect(indexOf('r1-rest')).toBeLessThan(indexOf('r1-finish'));
  });

  it('the freeing contour (a sentinel) never moves, even when it shares a cutter with earlier ops', () => {
    const ops = [
      op('r1-rough', 'flat', 'r1'), op('r1-finish', 'ball', 'r1'),
      op('r2-rough', 'flat', 'r2'), op('r2-finish', 'ball', 'r2'),
      op('freeing-contour', 'flat', 'contour', true),
    ];
    const batched = batchSameCutterRuns(ops, (o) => o.cutter, (o) => o.sentinel === true);
    expect(batched[batched.length - 1]!.id).toBe('freeing-contour');
    expect(runCount(batched)).toBe(3); // flat-flat, ball-ball, flat(contour) — never merged into the first flat group
  });
});

// ---------------------------------------------------------------------------------------------
// B. The real planCurvedForTree output, two regions — confirms the alternation is real, and
//    that batching changes grouping, never content.
// ---------------------------------------------------------------------------------------------

const RAPID: RapidEstimate = { xyMmPerMin: 1200, zMmPerMin: 600, accelMmPerS2: 150, source: 'test fixture' };
const flat: Tool = flatEndMill(6, { number: 1, id: 'flat-6', name: 'flat-6' });
const ball: Tool = { ...flatEndMill(6, { number: 2, id: 'ball-6', name: 'ball-6' }), shape: 'ball', typeText: 'Ball Nose' };

function twoRegionTree(): { tree: FeatureTree; geometry: { triangles: { positions: Float32Array; indices: Uint32Array; triangleCount: number; bbox: { min: [number, number, number]; max: [number, number, number] } } } } {
  // Two separate flat floors, side by side, well apart — no interaction, each its own remainder
  // region, so nothing but the (removed) per-region loop order relates them.
  const Z = -5;
  const M = 15;
  const x0 = 0 - M, x1 = 80 + M, y0 = 0 - M, y1 = 20 + M;
  const geometry = {
    triangles: {
      positions: Float32Array.from([
        x0, y0, Z, x1, y0, Z, x1, y1, Z,
        x0, y0, Z, x1, y1, Z, x0, y1, Z,
      ]),
      indices: Uint32Array.from([0, 1, 2, 3, 4, 5]),
      triangleCount: 2,
      bbox: { min: [x0, y0, Z] as [number, number, number], max: [x1, y1, 0] as [number, number, number] },
    },
  };
  const fp1: Polygons = [[[0, 0], [30, 0], [30, 20], [0, 20]]];
  const fp2: Polygons = [[[50, 0], [80, 0], [80, 20], [50, 20]]];
  const tree: FeatureTree = {
    frame: { up: [0, 0, 1], stockTop: 0, partTop: 0, partBottom: Z },
    levels: [Z],
    top: { z: 0, floors: [], area: 0 },
    contour: { outline: [[[0, 0], [80, 0], [80, 20], [0, 20]]], area: 80 * 20, zTo: Z, frees: true, shoulders: [] },
    pockets: [],
    rims: [],
    remainder: [
      { id: 'r1', footprint: fp1, area: 30 * 20, zTop: 0, zBottom: Z, triangles: new Uint32Array(), slopeDeg: [0, 0], slopeMedianDeg: 0, in: 'top' },
      { id: 'r2', footprint: fp2, area: 30 * 20, zTop: 0, zBottom: Z, triangles: new Uint32Array(), slopeDeg: [0, 0], slopeMedianDeg: 0, in: 'top' },
    ],
    unreachable: [],
    report: { source: 'mesh', patches: 1, planarArea: 1200, remainderArea: 1200, tolerances: {} as never, slivers: [], notes: [] },
  };
  return { tree, geometry };
}

describe('#964 — the curved pipeline really does alternate across independent regions', () => {
  it('two unrelated flat floors post rough/finish/pencil alternating flat,ball,ball,flat,ball,ball — and batching collapses it to 2 runs without changing which ops exist', () => {
    const { tree, geometry } = twoRegionTree();
    const result = planCurvedForTree(tree, {
      geometry, offset: makeClipperOffset(tl), flat, ball,
      stepDownMm: 1.5, bandMm: 0.3, finishScallopMm: 0.1,
      feeds: { feedMmPerMin: 900, plungeFeedMmPerMin: 250 }, rapid: RAPID, spindleRpm: 12000, air: true,
      safeZMm: 5, hopZMm: 1, edgeBreak: { legMm: 0 }, toolNumberFor: (t) => t.number ?? 1,
    });

    const kinds = result.ops.map((o) => `${o.kind}:${o.region.id}`);
    expect(kinds, `ops: ${kinds.join(', ')}`).toEqual(
      expect.arrayContaining(['rough:r1', 'finish:r1', 'rough:r2', 'finish:r2']),
    );
    // RED, naturally: the per-region loop alternates — rough/finish/pencil for r1, THEN r2's.
    const cutterSeq = result.ops.map((o) => o.outcome.cutter);
    const runsBefore = (() => {
      let n = 0, last: string | null = null;
      for (const c of cutterSeq) { if (c !== last) { n++; last = c; } }
      return n;
    })();
    expect(runsBefore).toBeGreaterThanOrEqual(4); // flat, ball(+pencil), flat, ball(+pencil)

    // GREEN: batching groups them, same cutter-key function plan.ts itself uses.
    const batched = batchSameCutterRuns(result.ops, (o) => o.outcome.cutter, (o) => o.kind === 'contour');
    let runsAfter = 0, last: string | null = null;
    for (const o of batched) { if (o.outcome.cutter !== last) { runsAfter++; last = o.outcome.cutter; } }
    expect(runsAfter).toBe(2); // every flat op together, every ball op together
    expect(runsAfter).toBeLessThan(runsBefore);

    // The SET of ops (by kind + region, which is what the moves and therefore coverage/cut-into
    // are keyed on) is exactly the same — batching regroups, it does not add, drop or duplicate.
    const beforeSet = result.ops.map((o) => `${o.kind}:${o.region.id}`).sort();
    const afterSet = batched.map((o) => `${o.kind}:${o.region.id}`).sort();
    expect(afterSet).toEqual(beforeSet);
    // And every op's own posted moves are byte-identical objects (same outcome.ir reference) —
    // batching reorders the ARRAY, it never touches an op's own planned content.
    for (const o of result.ops) expect(batched).toContain(o);
  }, 60_000);
});
