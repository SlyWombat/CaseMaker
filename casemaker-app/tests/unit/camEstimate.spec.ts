// The cycle-time estimate (#242, #281). One number with one meaning: CUTTING + RAPIDS, every move
// timed through the trapezoid on a named rapid model, produced by ONE function so nothing
// downstream can invent a second one.
//
// No wasm here: `estimateCycleSeconds`, `moveSeconds` and `generateTrace` are pure, so these run in
// milliseconds.

import { describe, it, expect } from 'vitest';
import {
  estimateCycleSeconds,
  estimateIRCycleSeconds,
  estimateSeconds,
  HOP_Z,
  moveSeconds,
  rapidRate,
  SAFE_Z,
  type CamMove,
  type CamOperation,
  type RapidEstimate,
  type ToolpathIR,
} from '@/engine/cnc/cam/ir';
import { generateTrace, type TracePaths } from '@/engine/cnc/cam/trace';
import { flatEndMill } from '@/engine/cnc/tool';

const rapid = (x: number, y: number, z: number): CamMove => ({ kind: 'rapid', x, y, z });
const cut = (x: number, y: number, z: number, f: number): CamMove => ({ kind: 'feed', x, y, z, f });

/** A round, obviously-made-up model: 1200 mm/min XY, 600 Z, 150 mm/s² accel. */
const RAPID: RapidEstimate = { xyMmPerMin: 1200, zMmPerMin: 600, accelMmPerS2: 150, source: 'spec fixture' };

/** The trapezoid, written out independently of the code under test. */
function trap(d: number, rateMmMin: number, a: number): number {
  const v = rateMmMin / 60;
  return d >= (v * v) / a ? d / v + v / a : 2 * Math.sqrt(d / a);
}

describe('moveSeconds: the trapezoid (#281)', () => {
  it('a long move reaches the rate: d/v + v/a', () => {
    const a = 150;
    const v = 1200 / 60; // 20 mm/s
    // 100 mm is far past v²/a = 2.667 mm, so it is the cruise branch.
    expect(moveSeconds(100, 1200, a)).toBeCloseTo(100 / v + v / a, 9);
  });

  it('a short move never reaches the rate: 2·√(d/a)', () => {
    const a = 150;
    // v²/a = 2.667 mm; 1 mm < that, so the triangular profile is the whole move.
    expect(moveSeconds(1, 1200, a)).toBeCloseTo(2 * Math.sqrt(1 / a), 9);
  });

  it('the two branches meet at d = v²/a (no step in the clock)', () => {
    const a = 150;
    const v = 1200 / 60;
    const d = (v * v) / a;
    expect(moveSeconds(d, 1200, a)).toBeCloseTo(d / v + v / a, 9);
    expect(d / v + v / a).toBeCloseTo(2 * Math.sqrt(d / a), 9);
  });

  it('a non-positive rate, accel or distance times nothing — never a negative or infinite', () => {
    expect(moveSeconds(10, 0, 150)).toBe(0);
    expect(moveSeconds(10, -5, 150)).toBe(0);
    expect(moveSeconds(10, 1200, 0)).toBe(0);
    expect(moveSeconds(0, 1200, 150)).toBe(0);
    expect(moveSeconds(-1, 1200, 150)).toBe(0);
  });
});

describe('rapidRate: which ceiling a rapid is under (#281)', () => {
  it('a Z-only rapid uses the Z rate; anything with X/Y uses the X/Y one', () => {
    expect(rapidRate(RAPID, 0, 0, 6)).toBe(600);
    expect(rapidRate(RAPID, 5, 0, 0)).toBe(1200);
    expect(rapidRate(RAPID, 0, 5, 0)).toBe(1200);
    // Diagonal-in-XZ and a pure-XY-with-no-Z are both X/Y moves.
    expect(rapidRate(RAPID, 5, 0, 6)).toBe(1200);
    expect(rapidRate(RAPID, 5, 5, 0)).toBe(1200);
  });
});

describe('estimateCycleSeconds (#242, #281)', () => {
  it('times a rapid at the model rate and a feed at its own rate, both through the trapezoid', () => {
    // A rapid only counts from a prior point (like a feed): 100 mm in +X at 1200 mm/min.
    expect(estimateCycleSeconds([rapid(0, 0, 0), rapid(100, 0, 0)], RAPID)).toBeCloseTo(trap(100, 1200, 150), 9);
    // 100 mm at F100 is the feed branch, d/v + v/a.
    expect(estimateCycleSeconds([rapid(0, 0, 0), cut(100, 0, 0, 100)], RAPID)).toBeCloseTo(trap(100, 100, 150), 9);
  });

  it('a Z-only rapid is timed at the Z rate, not the X/Y one', () => {
    const zOnly = estimateCycleSeconds([rapid(0, 0, 0), rapid(0, 0, 6)], RAPID);
    const xy = estimateCycleSeconds([rapid(0, 0, 0), rapid(6, 0, 0)], RAPID);
    expect(zOnly).toBeCloseTo(trap(6, 600, 150), 9);
    expect(xy).toBeCloseTo(trap(6, 1200, 150), 9);
    expect(zOnly).toBeGreaterThan(xy);
  });

  it('adds rapids to cutting, and both carry the acceleration terms estimateSeconds omits', () => {
    const moves = [rapid(0, 0, HOP_Z), cut(0, 0, -1, 200), cut(10, 0, -1, 200), rapid(10, 0, SAFE_Z)];
    const cutting = estimateSeconds(moves);
    const cycle = estimateCycleSeconds(moves, RAPID);
    // The cycle estimate is strictly larger: it adds the two rapids AND the feeds' own accel/decel
    // terms that the closed-form `estimateSeconds` drops.
    expect(cycle).toBeGreaterThan(cutting);
    // The plunge is 2 mm (from HOP_Z 1 down to −1); the cut is 10 mm; the Z-only retract is 6 mm.
    expect(cycle).toBeCloseTo(trap(2, 200, 150) + trap(10, 200, 150) + trap(6, 600, 150), 9);
    // The opening rapid (no prior point) contributes nothing; the closing Z-only retract does.
    expect(cutting).toBeCloseTo((2 / 200) * 60 + (10 / 200) * 60, 9);
  });

  it('the IR total is the sum of the per-operation estimates (one function, no drift)', () => {
    const op = (number: number, moves: CamMove[]): CamOperation => ({
      number,
      name: `op${number}`,
      labelId: `l${number}`,
      depth: 1,
      moves,
      estimatedSeconds: estimateCycleSeconds(moves, RAPID),
    });
    const ir: ToolpathIR = {
      frame: 'flat',
      tool: flatEndMill(1),
      toolNumber: 1,
      spindleRpm: 12000,
      air: false,
      safeZ: SAFE_Z,
      hopZ: HOP_Z,
      operations: [
        op(1, [rapid(0, 0, 1), cut(0, 0, -1, 200), cut(5, 0, -1, 200)]),
        op(2, [rapid(5, 0, 1), cut(5, 0, -1, 300), rapid(5, 0, 5)]),
      ],
    };
    const summed = ir.operations.reduce((s, o) => s + o.estimatedSeconds, 0);
    expect(estimateIRCycleSeconds(ir, RAPID)).toBeCloseTo(summed, 9);
  });
});

describe('generateTrace populates the cycle estimate (#242, #219, #281)', () => {
  it("each operation's estimatedSeconds is estimateCycleSeconds of its own moves, on the given model", () => {
    const params = { rpm: 12000, feed: 400, plungeFeed: 100, stepDown: 1, stepOver: 0.4, peck: 1, air: false };
    const traces: TracePaths[] = [
      { id: 'l1', paths: [[[0, 0], [10, 0], [10, 5]]], closed: [false], depth: 1 },
    ];
    const ir = generateTrace(traces, flatEndMill(1), params, RAPID);
    expect(ir.frame).toBe('flat');
    expect(ir.operations).toHaveLength(1);
    const op = ir.operations[0]!;
    // The op field and the IR total are the SAME function: no second estimate can drift.
    expect(op.estimatedSeconds).toBeCloseTo(estimateCycleSeconds(op.moves, RAPID), 9);
    expect(estimateIRCycleSeconds(ir, RAPID)).toBeCloseTo(op.estimatedSeconds, 9);
    expect(op.estimatedSeconds).toBeGreaterThan(estimateSeconds(op.moves)); // rapids + accel counted
  });
});
