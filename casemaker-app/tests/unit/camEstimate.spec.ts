// The cycle-time estimate (#242, #281). One number with one meaning: CUTTING + RAPIDS, timed
// through the trapezoid on a named rapid model — a feed RUN as one move, a rapid as its own —
// produced by ONE function so nothing downstream can invent a second one.
//
// No wasm here: `estimateCycleSeconds`, `moveSeconds` and `generateTrace` are pure, so these run in
// milliseconds.

import { describe, it, expect } from 'vitest';
import {
  estimateCycleSeconds,
  estimateIRCycleSeconds,
  estimateSeconds,
  HOP_Z,
  JUNCTION_CORNER_DEG,
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
    // The plunge (2 mm, from HOP_Z 1 down to −1) and the cut (10 mm) are at the SAME feed, so they
    // are one run of 12 mm and take one trapezoid; the Z-only retract is 6 mm at the Z rate.
    expect(cycle).toBeCloseTo(trap(12, 200, 150) + trap(6, 600, 150), 9);
    // The opening rapid (no prior point) contributes nothing; the closing Z-only retract does.
    expect(cutting).toBeCloseTo((2 / 200) * 60 + (10 / 200) * 60, 9);
  });

  it('times a feed RUN as one move — the planner does not stop at every chord (#281, review of 62fa025)', () => {
    // A pocket is cut in short chords and the controller carries speed across the junctions between
    // them (`junction_deviation` is what that config key is for), so charging a stop-start triangle
    // per chord times a machine with no look-ahead. Twenty 1 mm chords at F400: one 20 mm move, not
    // twenty 1 mm ones.
    const chords = [rapid(0, 0, 1)];
    for (let i = 1; i <= 20; i++) chords.push(cut(i, 0, 1, 400));
    const perRun = estimateCycleSeconds(chords, RAPID);
    expect(perRun).toBeCloseTo(trap(20, 400, 150), 9);
    const perChord = 20 * trap(1, 400, 150);
    // And the difference is exactly nineteen ramps: both readings pay ONE ramp pair (v/a = 400/60/150
    // s), and the per-chord reading pays it twenty times.
    expect(perChord).toBeGreaterThan(perRun);
    expect(perChord - perRun).toBeCloseTo(19 * (400 / 60 / 150), 9);
  });

  it('carries speed across a gentle corner and stops at a sharp one (#657)', () => {
    // A corner under JUNCTION_CORNER_DEG (5° < 10°) reads as one straight run: two 10 mm legs are one
    // trapezoid on their 20 mm sum.
    const a = 5 * (Math.PI / 180);
    const gentle = estimateCycleSeconds(
      [rapid(0, 0, 0), cut(10, 0, 0, 400), cut(10 + 10 * Math.cos(a), 10 * Math.sin(a), 0, 400)],
      RAPID,
    );
    expect(gentle).toBeCloseTo(trap(20, 400, 150), 9);

    // A 90° corner is past it: each 10 mm leg is its own trapezoid.
    const sharp = estimateCycleSeconds([rapid(0, 0, 0), cut(10, 0, 0, 400), cut(10, 10, 0, 400)], RAPID);
    expect(sharp).toBeCloseTo(trap(10, 400, 150) + trap(10, 400, 150), 9);
    expect(JUNCTION_CORNER_DEG).toBeGreaterThan(5);
    expect(JUNCTION_CORNER_DEG).toBeLessThan(90);
  });

  it("times an engraving's short right-angle strokes per corner, not as one long run (#657)", () => {
    // The badge's shape at the catalogue's F1000: ten 1 mm legs, each at a right angle to the last.
    // The planner stops at every corner, so the estimate is ten 1 mm triangles — not the one 10 mm
    // trapezoid the per-run model would charge, which is exactly the 165 s vs 255 s gap on the cut.
    const legs: CamMove[] = [rapid(0, 0, 0)];
    let x = 0;
    let y = 0;
    for (let i = 0; i < 10; i++) {
      if (i % 2 === 0) x += 1;
      else y += 1;
      legs.push(cut(x, y, 0, 1000));
    }
    const staircase = estimateCycleSeconds(legs, RAPID);
    expect(staircase).toBeCloseTo(10 * moveSeconds(1, 1000, 150), 9);
    expect(staircase).toBeGreaterThan(trap(10, 1000, 150));
  });

  it('ends the run at a rapid, at a feed change, and at the start of the program', () => {
    // Two cuts at different feeds are two runs (each trapezoid is applicable to one `f`).
    expect(estimateCycleSeconds([rapid(0, 0, 0), cut(5, 0, 0, 100), cut(10, 0, 0, 200)], RAPID)).toBeCloseTo(
      trap(5, 100, 150) + trap(5, 200, 150),
      9,
    );
    // A rapid between two same-feed cuts ends the first run: a rapid IS a stop, so the second cut
    // pays its own accel/decel.
    expect(estimateCycleSeconds([rapid(0, 0, 0), cut(5, 0, 0, 200), rapid(5, 0, 1), cut(5, 5, 1, 200)], RAPID)).toBeCloseTo(
      // …and that rapid is a Z-only rise of 1 mm, so it is timed at the Z ceiling, not the X/Y one.
      trap(5, 200, 150) + trap(1, 600, 150) + trap(5, 200, 150),
      9,
    );
    // The first move is never timed (no prior point), so a program that opened with a feed would
    // start its run at the second move.
    expect(estimateCycleSeconds([cut(5, 0, 0, 200), cut(10, 0, 0, 200)], RAPID)).toBeCloseTo(trap(5, 200, 150), 9);
  });

  it('times the model the machine actually has: 60.13 s for a 1200 mm X rapid, 60.07 s for 600 in Z', () => {
    // The anchors #281's decision comment names, evaluated rather than quoted: a 1200 mm X-only
    // rapid is a full minute of cruise at 1200 mm/min plus the 20 mm/s the trapezoid's ramps add
    // (v/a = 20/150 = 0.1333 s), and the Z ceiling is half that rate, so the same distance in Z
    // alone costs 60 + 10/150 = 60.0667 s.
    expect(estimateCycleSeconds([rapid(0, 0, 0), rapid(1200, 0, 0)], RAPID)).toBeCloseTo(60.133333333, 6);
    expect(estimateCycleSeconds([rapid(0, 0, 0), rapid(0, 0, 600)], RAPID)).toBeCloseTo(60.066666667, 6);
    // 100 mm at F100: a minute of cutting plus 1.6667/150 s of ramps.
    expect(estimateCycleSeconds([rapid(0, 0, 0), cut(100, 0, 0, 100)], RAPID)).toBeCloseTo(60.011111111, 6);
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
