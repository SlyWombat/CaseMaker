/**
 * #964 — TOOL-CHANGE BATCHING, RED-FIRST. The curved pipeline plans region by region (rough,
 * [rest], finish, pencil, then the next region's rough again), alternating the flat and the ball
 * once per remainder region with no actual ordering choice behind it — F measured this as 14
 * alternations / 29 tool changes on the tray (#964, comment 6649404153), about 2,651 s of real
 * machine time. `batchSameCutterRuns` (`sequence.ts`) groups same-cutter ops back together
 * wherever nothing depends on the gap between them.
 *
 * Three layers:
 *   A. The function itself, on hand-built mock ops — the exact shape of the problem (alternating
 *      cutters across independent regions) and the two invariants the issue named: a same-region
 *      pair never reverses, and a sentinel (the freeing contour) never moves.
 *   B. The real `planCurvedForTree` output on a two-region tree — confirms the alternation is
 *      real on actual ops, and that running them through `batchSameCutterRuns` collapses the
 *      program count without changing which moves exist (the "coverage/cut-into unchanged"
 *      check available without a real goal/STEP: the SET of posted moves, not their grouping,
 *      is what cut-into and coverage are computed from).
 *   C. STEP-free END TO END, through `planModelCam` itself (the manager's review on comment
 *      6650143721: composition-by-construction is fine as reasoning, but the call site deserves
 *      its own test) — a real Manifold-recognised part (`buildRandomPart('scooped', ...)`) whose
 *      shoulder/through-hole/contour all share the flat and whose bowl needs the ball, so the
 *      natural `ops` order alternates flat/ball/flat before batching ever runs, and the posted
 *      `programs` must still end with the freeing contour's own moves.
 */

import { describe, expect, it } from 'vitest';

import { batchSameCutterRuns } from '../../src/engine/cnc/cam/model/sequence';
import { tl } from './helpers/manifoldExec';
import { makeClipperOffset } from '../../src/engine/cnc/cam/engraveJob';
import { planCurvedForTree, planModelCam, type ModelPlanInput } from '../../src/engine/cnc/cam/model/plan';
import type { FeatureTree } from '../../src/engine/cnc/cam/model/features';
import { flatEndMill, type Tool } from '../../src/engine/cnc/tool';
import type { RapidEstimate } from '../../src/engine/cnc/cam/ir';
import type { Polygons } from '../../src/engine/cnc/cam/pocket';
import { buildRandomPart } from '../tools/randomParts';

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
const flat: Tool = flatEndMill(6, { number: 1, id: 'flat-6', name: 'flat-6', fluteLength: 30 });
const ball: Tool = { ...flatEndMill(6, { number: 2, id: 'ball-6', name: 'ball-6', fluteLength: 30 }), shape: 'ball', typeText: 'Ball Nose' };

function twoRegionTree(): { tree: FeatureTree; geometry: { triangles: { positions: Float32Array; indices: Uint32Array; triangleCount: number; bbox: { min: [number, number, number]; max: [number, number, number] } } } } {
  // Two separate floors, side by side, well apart — no interaction, each its own remainder
  // region, so nothing but the (removed) per-region loop order relates them. A CONSTANT SLOPE
  // (this fixture's own earlier fix, 68db15ed, for #964's item 4a review) is no longer enough:
  // the skim's own run/region tours (#962) and the coverage rest (#961) together reach a plane
  // closely enough that the ball's finish again emits nothing — the same fixture-premise defect,
  // one level up the stack (the manager's 961x960-rt finding). A PLANE, tilted or not, is exactly
  // what a flat tool can conform to without limit as the stepover tightens; real CURVATURE is
  // not — a wavy floor (amplitude 1 mm, one full period every 15 mm, so even a single ⌀6 flat
  // pass straddles a full rise-and-fall) leaves a scallop no stepover closes, well above the
  // 0.3 mm band, so the ball's finish always has real, curvature-driven leftover to take.
  const Z0 = -5;
  const AMPLITUDE = 1;
  const WAVELENGTH = 15;
  const M = 15;
  const x0 = 0 - M, x1 = 80 + M, y0 = 0 - M, y1 = 20 + M;
  const zAt = (x: number): number => Z0 - (AMPLITUDE / 2) * (1 - Math.cos((2 * Math.PI * x) / WAVELENGTH));
  const N = 100; // segments across x — under 1.2 mm each, far finer than the ⌀6 flat's 3 mm radius
  const positions: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i <= N; i++) {
    const x = x0 + ((x1 - x0) * i) / N;
    const z = zAt(x);
    positions.push(x, y0, z, x, y1, z);
  }
  for (let i = 0; i < N; i++) {
    const a = 2 * i, b = 2 * i + 1, c = 2 * (i + 1), d = 2 * (i + 1) + 1;
    indices.push(a, c, b, b, c, d);
  }
  const geometry = {
    triangles: {
      positions: Float32Array.from(positions),
      indices: Uint32Array.from(indices),
      triangleCount: indices.length / 3,
      bbox: { min: [x0, y0, Z0 - AMPLITUDE] as [number, number, number], max: [x1, y1, Z0] as [number, number, number] },
    },
  };
  const fp1: Polygons = [[[0, 0], [30, 0], [30, 20], [0, 20]]];
  const fp2: Polygons = [[[50, 0], [80, 0], [80, 20], [50, 20]]];
  // The wave's own slope range: 0 at its crests/troughs, up to atan(amplitude x pi / wavelength)
  // at its steepest — both regions span exactly two full periods, so both reach the full range.
  const maxSlopeDeg = (Math.atan((AMPLITUDE * Math.PI) / WAVELENGTH) * 180) / Math.PI;
  const tree: FeatureTree = {
    frame: { up: [0, 0, 1], stockTop: 0, partTop: 0, partBottom: Z0 - AMPLITUDE },
    levels: [Z0 - AMPLITUDE],
    top: { z: 0, floors: [], area: 0 },
    contour: { outline: [[[0, 0], [80, 0], [80, 20], [0, 20]]], area: 80 * 20, zTo: Z0 - AMPLITUDE, frees: true, shoulders: [] },
    pockets: [],
    rims: [],
    remainder: [
      { id: 'r1', footprint: fp1, area: 30 * 20, zTop: 0, zBottom: Z0 - AMPLITUDE, triangles: new Uint32Array(), slopeDeg: [0, maxSlopeDeg], slopeMedianDeg: maxSlopeDeg / 2, in: 'top' },
      { id: 'r2', footprint: fp2, area: 30 * 20, zTop: 0, zBottom: Z0 - AMPLITUDE, triangles: new Uint32Array(), slopeDeg: [0, maxSlopeDeg], slopeMedianDeg: maxSlopeDeg / 2, in: 'top' },
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

    // No merge moves a program ahead of one whose material it needs removed: within EACH region,
    // on these real ops, rough (and any rest) still posts before finish, finish still posts before
    // pencil, batching only ever regroups ACROSS regions.
    for (const regionId of ['r1', 'r2']) {
      const kindsForRegion = batched.filter((o) => o.region.id === regionId).map((o) => o.kind);
      const roughIdx = kindsForRegion.indexOf('rough');
      const finishIdx = kindsForRegion.indexOf('finish');
      expect(roughIdx, `${regionId}: rough must exist`).toBeGreaterThanOrEqual(0);
      expect(finishIdx, `${regionId}: finish must exist`).toBeGreaterThanOrEqual(0);
      expect(roughIdx, `${regionId}: rough's material removal must still precede its own finish`).toBeLessThan(finishIdx);
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------------------------
// C. STEP-free end to end, through planModelCam itself: a real Manifold-recognised part whose
//    natural op order alternates cutters, and whose contour shares a cutter with an earlier op.
// ---------------------------------------------------------------------------------------------

const V90: Tool = { ...flatEndMill(3.175, { number: 3, id: 'chamfer-90', name: '90° chamfer', fluteLength: 30 }), typeText: 'V-Bit', shape: 'chamfer', tipDiameter: 0.1, angle: 90, halfAngle: 45 };

describe('#964 — end to end through planModelCam: the freeing contour still posts last after batching', () => {
  it('a scooped part (bowl=ball, shoulder+through-hole+contour=flat): the natural ops alternate cutters, and the LAST posted program still ends in the contour\'s own moves', async () => {
    const part = buildRandomPart(941122, 'scooped', tl);
    const input: ModelPlanInput = {
      geometry: { triangles: part.mesh },
      setups: [{ frame: { up: [0, 0, 1], stockTop: 0 }, underside: 'flatOnStockBottom' }],
      stock: { length: part.stock.length, width: part.stock.width, thickness: part.stock.thickness, material: 'hardwood' },
      fixture: { mount: 'tape', envelope: null },
      cutters: { house: [flat, ball, V90], catalogue: [] },
      tolerances: { finishMm: 0.01 },
      edgeBreak: { legMm: 0.5 },
    };
    const output = await planModelCam(input);
    const setup = output.perSetup[0]!;

    // The natural (unbatched) order really does alternate: setup.ops is still the pre-batch
    // array (plan.ts's own comment on why `ops` and `programs` differ) — the bowl's ball rough/
    // finish sits between flat ops (shoulder, through hole, contour), so there is something here
    // for batching to actually do, not a single-cutter plan where "ends in contour" is trivial.
    const cutterSeq = setup.ops.map((op) => op.outcome.cutter);
    let naturalRuns = 0;
    let last: string | null = null;
    for (const c of cutterSeq) { if (c !== last) { naturalRuns++; last = c; } }
    expect(naturalRuns, `ops: ${setup.ops.map((o) => `${o.kind}:${o.outcome.cutter}`).join(', ')}`).toBeGreaterThan(2);

    const contourOp = setup.ops.find((op) => op.kind === 'contour');
    expect(contourOp, 'the plan must actually post a freeing contour for this to mean anything').toBeDefined();
    expect(setup.ops.filter((op) => op.kind === 'contour')).toHaveLength(1);

    // The contour really does share its cutter with an earlier, non-contour op — the exact
    // condition the manager asked this test to exercise: without the sentinel pin, grouping by
    // cutter key would pull the contour backward to merge with that earlier op's own run.
    const contourCutter = contourOp!.outcome.cutter;
    const earlierSameCutter = setup.ops.slice(0, setup.ops.indexOf(contourOp!)).some((op) => op.outcome.cutter === contourCutter);
    expect(earlierSameCutter, `ops: ${setup.ops.map((o) => `${o.kind}:${o.outcome.cutter}`).join(', ')}`).toBe(true);

    // Batching never increases the program count, and — because the sentinel is pinned rather
    // than merged into that earlier same-cutter run — does not reduce it here either: the one
    // other flat op (the pocket) is not adjacent to the contour, so there is nothing else for
    // batching to pull together on this part. The absence of a reduction IS the invariant: it
    // confirms the sentinel was never folded into the earlier flat run.
    expect(setup.programs.length).toBe(naturalRuns);

    // The concrete, observable form of "the freeing contour stays last": the LAST posted
    // program's own moves end with EXACTLY the contour op's own moves, move for move.
    const contourMoves = contourOp!.outcome.ir.operations.flatMap((o) => o.moves);
    expect(contourMoves.length).toBeGreaterThan(0);
    const lastProgramMoves = setup.programs.at(-1)!.operations.flatMap((o) => o.moves);
    const tail = lastProgramMoves.slice(-contourMoves.length);
    expect(tail).toEqual(contourMoves);
  }, 120_000);
});
