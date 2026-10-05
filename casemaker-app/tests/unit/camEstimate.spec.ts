// The cycle-time estimate (#242). One number with one meaning: CUTTING + RAPIDS at the assumed
// rapid rate, produced by ONE function so nothing downstream can invent a second one.
//
// No wasm here: `estimateCycleSeconds` and `generateTrace` are pure, so these run in milliseconds.

import { describe, it, expect } from 'vitest';
import {
  ASSUMED_RAPID_MM_MIN,
  estimateCycleSeconds,
  estimateIRCycleSeconds,
  estimateSeconds,
  HOP_Z,
  SAFE_Z,
  type CamMove,
  type CamOperation,
  type ToolpathIR,
} from '@/engine/cnc/cam/ir';
import { DISPLAY_RAPID_MM_MIN } from '@/workers/sim/session';
import { generateTrace, type TracePaths } from '@/engine/cnc/cam/trace';
import { flatEndMill } from '@/engine/cnc/tool';

const rapid = (x: number, y: number, z: number): CamMove => ({ kind: 'rapid', x, y, z });
const cut = (x: number, y: number, z: number, f: number): CamMove => ({ kind: 'feed', x, y, z, f });

describe('estimateCycleSeconds (#242)', () => {
  it('counts a rapid at the assumed rate and a feed at its own rate', () => {
    // A rapid only counts from a prior point (like a feed): 3000 mm at the assumed 3000 mm/min.
    expect(estimateCycleSeconds([rapid(0, 0, 0), rapid(3000, 0, 0)])).toBeCloseTo(60, 9);
    // 100 mm at F100 is also 60 s.
    expect(estimateCycleSeconds([rapid(0, 0, 0), cut(100, 0, 0, 100)])).toBeCloseTo(60, 9);
  });

  it('adds rapids to cutting, unlike estimateSeconds (the cutting component)', () => {
    const moves = [rapid(0, 0, HOP_Z), cut(0, 0, -1, 200), cut(10, 0, -1, 200), rapid(10, 0, SAFE_Z)];
    const cutting = estimateSeconds(moves);
    const cycle = estimateCycleSeconds(moves);
    expect(cycle).toBeGreaterThan(cutting);
    // The extra is the closing rapid (6 mm from -1 to safe Z 5) at the assumed rate; the
    // opening rapid contributes nothing because there is no prior point to measure from.
    expect(cycle - cutting).toBeCloseTo((6 / ASSUMED_RAPID_MM_MIN) * 60, 9);
  });

  it('accepts an explicit rapid rate, so a calibration can pass one in', () => {
    const moves = [rapid(0, 0, 0), rapid(1000, 0, 0)];
    expect(estimateCycleSeconds(moves, 1000)).toBeCloseTo(60, 9);
    expect(estimateCycleSeconds(moves, ASSUMED_RAPID_MM_MIN)).toBeCloseTo(20, 9);
  });

  it('the IR total is the sum of the per-operation estimates (one function, no drift)', () => {
    const op = (number: number, moves: CamMove[]): CamOperation => ({
      number,
      name: `op${number}`,
      labelId: `l${number}`,
      depth: 1,
      moves,
      estimatedSeconds: estimateCycleSeconds(moves),
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
    expect(estimateIRCycleSeconds(ir)).toBeCloseTo(summed, 9);
  });

  it('the display rate and the estimate rate are the SAME named constant', () => {
    // `workers/sim/session.ts` draws rapids at this rate; the run sheet quotes it. One source.
    expect(DISPLAY_RAPID_MM_MIN).toBe(ASSUMED_RAPID_MM_MIN);
  });
});

describe('generateTrace populates the cycle estimate (#242, #219)', () => {
  it("each operation's estimatedSeconds is estimateCycleSeconds of its own moves", () => {
    const params = { rpm: 12000, feed: 400, plungeFeed: 100, stepDown: 1, stepOver: 0.4, air: false };
    const traces: TracePaths[] = [
      { id: 'l1', paths: [[[0, 0], [10, 0], [10, 5]]], closed: [false], depth: 1 },
    ];
    const ir = generateTrace(traces, flatEndMill(1), params);
    expect(ir.frame).toBe('flat');
    expect(ir.operations).toHaveLength(1);
    const op = ir.operations[0]!;
    // The op field and the IR total are the SAME function: no second estimate can drift.
    expect(op.estimatedSeconds).toBeCloseTo(estimateCycleSeconds(op.moves), 9);
    expect(estimateIRCycleSeconds(ir)).toBeCloseTo(op.estimatedSeconds, 9);
    expect(op.estimatedSeconds).toBeGreaterThan(estimateSeconds(op.moves)); // rapids counted
  });
});
