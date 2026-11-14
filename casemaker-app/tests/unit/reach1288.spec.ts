/**
 * #1288 — THE POSTED DEPTH IS THE AUTHORITY FOR EVERY CUTTER THAT POSTS MOVES.
 *
 * Found by #1282: petit-pot-lid's ⌀1 × 4 mm rest ball posted a finish to 5.732 mm below the stock
 * top. The rest ball was qualified on the depth of the REMAINDER regions and never checked against
 * the depth it actually cuts; only the main finisher had that check. The rule (9b's ruling):
 *  - one usable-length function (shoulder, else flute) for every pick-side read;
 *  - the posted depth decides, for the finisher, the rest ball and the pencil;
 *  - a rest ball that cannot reach yields to the next one that can; otherwise the region is left
 *    with the existing `goal-finish-unreachable` sentence;
 *  - an unstated length is eligible only when no stated cutter reaches.
 */
import { describe, expect, it } from 'vitest';

import { tl } from './helpers/manifoldExec';
import { makeClipperOffset } from '../../src/engine/cnc/cam/engraveJob';
import { planCurvedForTree } from '../../src/engine/cnc/cam/model/plan';
import { eligibleByReach, postedDepthMm, postedReachShortfall, roundedDepthWords, statedReach, usableLengthMm } from '../../src/engine/cnc/cam/model/reach';
import type { FeatureTree } from '../../src/engine/cnc/cam/model/features';
import type { RapidEstimate } from '../../src/engine/cnc/cam/ir';
import type { Polygons } from '../../src/engine/cnc/cam/pocket';
import { flatEndMill, type Tool } from '../../src/engine/cnc/tool';

const RAPID: RapidEstimate = { xyMmPerMin: 1200, zMmPerMin: 600, accelMmPerS2: 150, source: 'test fixture' };
const PLATE = -0.5;
/** Deeper than the short rest ball's flute (3 mm), shallow enough for the long one (30.5 mm). */
const SLOT_FLOOR = -5;
const SLOT_X0 = 9.4;
const SLOT_X1 = 10.6;
const FOOT: Polygons = [[[0, -5], [20, -5], [20, 5], [0, 5]]];

const ballOf = (d: number, over: Partial<Tool>): Tool => ({ ...flatEndMill(d, { name: `ball-${d}`, ...over }), shape: 'ball', typeText: 'Ball Nose' });
const flat6 = flatEndMill(6, { number: 1, id: 'flat-6', name: 'flat-6', fluteLength: 20 });
const ball2 = ballOf(2, { number: 2, id: 'ball-2', fluteLength: 20 });
/** The short rest ball: ⌀1, a 3 mm flute — it enters the slot but cannot reach its 5 mm floor. */
const shortBall = ballOf(1, { number: 3, id: 'short-1', name: 'short ⌀1 × 3', fluteLength: 3 });
/** The long one: ⌀1, a 30.5 mm flute. */
const longBall = ballOf(1, { number: 4, id: 'long-1', name: 'long ⌀1 × 30.5', fluteLength: 30.5 });
/** A rest ball that states no length at all. */
const unstatedBall = ballOf(1, { number: 5, id: 'unstated-1', name: 'unstated ⌀1', fluteLength: null });

function plateWithSlot() {
  const STEP = 0.2;
  const X0 = -10, X1 = 30, Y0 = -10, Y1 = 10;
  const nx = Math.round((X1 - X0) / STEP) + 1;
  const ny = Math.round((Y1 - Y0) / STEP) + 1;
  const positions: number[] = [];
  const indices: number[] = [];
  const zAt = (x: number): number => (x >= SLOT_X0 && x <= SLOT_X1 ? SLOT_FLOOR : PLATE);
  const grid: number[][] = [];
  for (let j = 0; j < ny; j++) {
    grid.push([]);
    for (let i = 0; i < nx; i++) {
      positions.push(X0 + i * STEP, Y0 + j * STEP, zAt(X0 + i * STEP));
      grid[j]!.push(positions.length / 3 - 1);
    }
  }
  for (let j = 0; j < ny - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const a = grid[j]![i]!, b = grid[j]![i + 1]!, c = grid[j + 1]![i + 1]!, d = grid[j + 1]![i]!;
      indices.push(a, b, c, a, c, d);
    }
  }
  return {
    positions: Float32Array.from(positions),
    indices: Uint32Array.from(indices),
    triangleCount: indices.length / 3,
    bbox: { min: [X0, Y0, SLOT_FLOOR] as [number, number, number], max: [X1, Y1, PLATE] as [number, number, number] },
  };
}

function tree(): FeatureTree {
  return {
    frame: { up: [0, 0, 1], stockTop: 0, partTop: 0, partBottom: SLOT_FLOOR },
    levels: [SLOT_FLOOR],
    top: { z: 0, floors: [], area: 0 },
    contour: { outline: FOOT, area: 100, zTo: SLOT_FLOOR, frees: true, shoulders: [] },
    pockets: [],
    rims: [],
    remainder: [{
      id: 'slot-region', footprint: FOOT, area: 100, zTop: PLATE, zBottom: SLOT_FLOOR,
      triangles: new Uint32Array(), slopeDeg: [0, 45], slopeMedianDeg: 20, in: 'top',
    }],
    unreachable: [],
    report: { source: 'mesh', patches: 1, planarArea: 100, remainderArea: 100, tolerances: {} as never, slivers: [], notes: [] },
  };
}

function plan(restBalls: readonly Tool[]) {
  return planCurvedForTree(tree(), {
    geometry: { triangles: plateWithSlot() },
    offset: makeClipperOffset(tl),
    flat: flat6,
    ball: ball2,
    ...(restBalls.length === 0 ? {} : { restBalls }),
    stepDownMm: 1.5,
    bandMm: 0.3,
    feeds: { feedMmPerMin: 900, plungeFeedMmPerMin: 250 },
    rapid: RAPID,
    spindleRpm: 12000,
    air: true,
    safeZMm: 5,
    hopZMm: 1,
    edgeBreak: { legMm: 0 },
    toolNumberFor: (t: Tool) => t.number ?? 1,
  } as never);
}

const restOps = (r: ReturnType<typeof plan>) => r.ops.filter((op) => op.kind === 'rest');
const deepestOf = (r: ReturnType<typeof plan>, kind: string): number =>
  r.ops.filter((op) => op.kind === kind).reduce((d, op) => Math.min(d, ...op.outcome.ir.operations.flatMap((o) => o.moves.filter((m) => m.kind === 'feed').map((m) => m.z))), 0);

describe('#1288 one usable-length function', () => {
  it('shoulder when stated and positive, else flute, else unstated (zero is unstated)', () => {
    expect(usableLengthMm(ballOf(1, { fluteLength: 4, shoulderLength: null }))).toBe(4);
    expect(usableLengthMm(ballOf(1, { fluteLength: 4, shoulderLength: 8 }))).toBe(8);
    expect(usableLengthMm(ballOf(1, { fluteLength: 4, shoulderLength: 0 }))).toBe(4);
    expect(usableLengthMm(ballOf(1, { fluteLength: null, shoulderLength: null }))).toBeNull();
    expect(usableLengthMm(ballOf(1, { fluteLength: 0, shoulderLength: 0 }))).toBeNull();
  });

  it('a stated length reaches only a depth it covers; an unstated one never "reaches"', () => {
    expect(statedReach(ballOf(1, { fluteLength: 4 }), 4)).toBe(true);
    expect(statedReach(ballOf(1, { fluteLength: 4 }), 5.732)).toBe(false);
    expect(statedReach(ballOf(1, { fluteLength: null }), 1)).toBe(false);
  });

  it('eligible: the stated cutters that reach; the unstated ones only when none does', () => {
    const four = ballOf(1, { name: 'four', fluteLength: 4 });
    const thirty = ballOf(1, { name: 'thirty', fluteLength: 30 });
    const none = ballOf(1, { name: 'none', fluteLength: null });
    expect(eligibleByReach([four, thirty, none], 5.7)).toEqual({ tools: [thirty], unstated: false });
    expect(eligibleByReach([four, thirty, none], 3)).toEqual({ tools: [four, thirty], unstated: false });
    expect(eligibleByReach([four, none], 5.7)).toEqual({ tools: [none], unstated: true });
    expect(eligibleByReach([four], 5.7)).toEqual({ tools: [], unstated: false });
  });

  it('the authority compares the EXACT posted depth: 4.04 mm with a 4 mm cutter is refused (rounding is for the sentence only)', () => {
    const exact = postedDepthMm([{ moves: [{ z: -4.04 }] }]);
    expect(exact, 'the depth is exact, not rounded to 0.1 mm').toBeCloseTo(4.04, 9);
    expect(postedReachShortfall(ballOf(1, { fluteLength: 4 }), exact), '4.04 past a 4 mm flute').toBe(4);
    expect(postedReachShortfall(ballOf(1, { fluteLength: 4 }), postedDepthMm([{ moves: [{ z: -4 }] }])), 'exactly at the flute passes').toBeNull();
    expect(roundedDepthWords(5.732)).toBe('5.7');
  });

  it('the posted depth and the shortfall', () => {
    expect(postedDepthMm([{ moves: [{ z: 5 }, { z: -5.732 }] }, { moves: [{ z: -2 }] }])).toBeCloseTo(5.732, 9);
    expect(postedReachShortfall(ballOf(1, { fluteLength: 4 }), 5.732)).toBe(4);
    expect(postedReachShortfall(ballOf(1, { fluteLength: 6 }), 5.7)).toBeNull();
    expect(postedReachShortfall(ballOf(1, { fluteLength: null }), 5.7)).toBeNull();
  });
});

describe('#1288 the rest ball: the posted depth decides', () => {
  it('a rest ball whose posted finish goes deeper than its flute is NOT posted, and the region says so', () => {
    const result = plan([shortBall]);
    expect(restOps(result).filter((op) => op.outcome.cutter === shortBall.id), 'the short ball posted a rest').toHaveLength(0);
    const said = result.statements.find((s) => s.code === 'goal-finish-unreachable');
    expect(said, `statements: ${JSON.stringify(result.statements.map((s) => s.code))}`).toBeDefined();
    expect(said?.text).toMatch(/short ⌀1 × 3/);
  }, 180_000);

  it('a rest ball that cannot reach yields to the next one that can', () => {
    const result = plan([shortBall, longBall]);
    const rests = restOps(result);
    expect(rests.some((op) => op.outcome.cutter === longBall.id), 'the long ball did not take the rest').toBe(true);
    expect(rests.some((op) => op.outcome.cutter === shortBall.id)).toBe(false);
    expect(Math.abs(deepestOf(result, 'rest'))).toBeGreaterThan(3);
    // The yielding ball says only that it was not used, and why — NEVER "no cutter reaches" while a later ball takes the region.
    const said = result.statements.filter((st) => st.code === 'goal-finish-unreachable');
    expect(said.length, 'the yielding ball is stated').toBeGreaterThan(0);
    for (const st of said) {
      expect(st.text).toMatch(/not used/);
      expect(st.text, 'false: the long ball took the region').not.toMatch(/no cutter on the shelf reaches it/);
      expect(st.severity).toBe('info');
    }
  }, 180_000);

  it('an unstated-length ball is tried only when no stated one reaches (the eligibility the model plan feeds this pipeline)', () => {
    // The pick side of the rule is `eligibleByReach`, which `planModelCam` calls for the rest balls
    // and for the primary flat; this pipeline then tries the list in the order it is given.
    expect(eligibleByReach([unstatedBall, longBall], 5).tools).toEqual([longBall]);
    expect(eligibleByReach([unstatedBall, shortBall], 5)).toEqual({ tools: [unstatedBall], unstated: true });
    // And given an unstated ball alone, the pipeline posts it (nothing states it cannot reach).
    expect(restOps(plan([unstatedBall])).some((op) => op.outcome.cutter === unstatedBall.id)).toBe(true);
  }, 180_000);

  it('a rest ball that reaches is unchanged (the #965 slot, in range)', () => {
    const result = plan([longBall]);
    expect(restOps(result).some((op) => op.outcome.cutter === longBall.id)).toBe(true);
    expect(result.statements.some((s) => s.code === 'goal-finish-unreachable')).toBe(false);
  }, 180_000);
});

describe('#1288 the refusal says what would finish the region — once, after the candidates are exhausted', () => {
  it('when no rest ball reaches: ONE "needs" clause per region, the reach it would take, no product', () => {
    const result = plan([shortBall]);
    const said = result.statements.filter((st) => st.code === 'goal-finish-unreachable' && st.severity === 'warning');
    expect(said, 'one warning for the region').toHaveLength(1);
    expect(said[0]!.text).toMatch(/no cutter on the shelf reaches it — it needs a ⌀1 mm ball with at least 4\.1 mm of reach/);
    expect(said[0]!.text).not.toMatch(/catalogue|buy|add it to the shop/);
  }, 180_000);

  it('two balls both refused: still ONE clause, after both, and each ball is named once as not used', () => {
    const shorter = ballOf(1, { number: 7, id: 'shorter-1', name: 'shorter ⌀1 × 2', fluteLength: 2 });
    const result = plan([shortBall, shorter]);
    const warnings = result.statements.filter((st) => st.code === 'goal-finish-unreachable' && st.severity === 'warning');
    const infos = result.statements.filter((st) => st.code === 'goal-finish-unreachable' && st.severity === 'info');
    expect(warnings).toHaveLength(1);
    expect(infos.map((st) => st.text).join('\n')).toMatch(/short ⌀1 × 3[\s\S]*shorter ⌀1 × 2|shorter ⌀1 × 2[\s\S]*short ⌀1 × 3/);
  }, 180_000);
});

describe('#1288 the "needs" clause is written once per region, from what is left unreached (9b)', () => {
  const rest2 = ballOf(2, { number: 8, id: 'rest-2', name: 'rest ⌀2 × 20', fluteLength: 20 });
  const rest1Long = ballOf(1, { number: 9, id: 'rest-1-long', name: 'rest ⌀1 × 30', fluteLength: 30 });

  it('a LARGER ball posts after a ⌀1 ball is refused: the clause names the ⌀1 that is still unreached', () => {
    const result = plan([shortBall, rest2]);
    const warnings = result.statements.filter((st) => st.code === 'goal-finish-unreachable' && st.severity === 'warning');
    expect(warnings, 'one clause for the region').toHaveLength(1);
    expect(warnings[0]!.text).toContain(
      'the rest ⌀2 × 20 finished what it can enter; the narrower places need a ⌀1 mm ball with at least 4.1 mm of reach, and none on the shelf has it.',
    );
  }, 180_000);

  it('the posting ball is the SAME diameter as the refused one: no clause at all', () => {
    const result = plan([shortBall, rest1Long]);
    expect(restOps(result).some((op) => op.outcome.cutter === rest1Long.id)).toBe(true);
    expect(result.statements.filter((st) => st.severity === 'warning' && st.code === 'goal-finish-unreachable')).toHaveLength(0);
  }, 180_000);
});
