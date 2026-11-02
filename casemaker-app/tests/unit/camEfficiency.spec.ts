// #926 — the efficiency measures: air-time fraction, hops, feed utilisation, swept area, the tour
// bound and the written fraction. The TIME figures are the cycle estimate's own (same trapezoid,
// same per-run rule), and that is the first thing proved here: a measure that times the program
// differently from the posted `TIME` would judge a program by a clock nothing else uses.

import { describe, it, expect } from 'vitest';
import {
  efficiencyOf,
  estimateCycleSeconds,
  estimateIRCycleSeconds,
  HOP_Z,
  travelStatsOf,
  type CamMove,
  type CamOperation,
  type RapidEstimate,
  type ToolpathIR,
} from '@/engine/cnc/cam/ir';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';

const RAPID: RapidEstimate = { xyMmPerMin: 1200, zMmPerMin: 600, accelMmPerS2: 150, source: 'spec fixture' };

const rapid = (x: number, y: number, z: number): CamMove => ({ kind: 'rapid', x, y, z });
const cut = (x: number, y: number, z: number, f: number): CamMove => ({ kind: 'feed', x, y, z, f });

function operation(number: number, moves: CamMove[], name = `[T1] op ${number}`): CamOperation {
  return { number, name, labelId: `l${number}`, depth: 1, moves, estimatedSeconds: 0 };
}

function ir(moves: CamMove[][], tool: Tool = flatEndMill(3), hopZ = HOP_Z): ToolpathIR {
  return {
    frame: 'flat',
    tool,
    toolNumber: 1,
    spindleRpm: 12000,
    air: true,
    safeZ: 5,
    hopZ,
    operations: moves.map((m, i) => operation(i + 1, m)),
  };
}

/** The trapezoid, written out independently of the code under test. */
function trap(d: number, rateMmMin: number, a: number): number {
  const v = rateMmMin / 60;
  return d >= (v * v) / a ? d / v + v / a : 2 * Math.sqrt(d / a);
}

describe('#926 efficiency: the time figures are the cycle estimate', () => {
  it('rapid + feed seconds equal estimateCycleSeconds, operation by operation and for the program', () => {
    const program = ir([
      [rapid(0, 0, HOP_Z), cut(0, 0, -1, 200), cut(10, 0, -1, 200), rapid(10, 0, HOP_Z), rapid(30, 0, HOP_Z), cut(30, 0, -1, 200), cut(40, 0, -1, 200)],
      [rapid(0, 0, 5), cut(0, 0, -1, 300), cut(0, 20, -1, 300)],
    ]);
    const measure = efficiencyOf(program, RAPID);
    measure.operations.forEach((op, i) => {
      const expected = estimateCycleSeconds(program.operations[i]!.moves, RAPID);
      expect(op.rapidSeconds + op.feedSeconds).toBeCloseTo(expected, 9);
    });
    expect(measure.cycleSeconds).toBeCloseTo(estimateIRCycleSeconds(program, RAPID), 9);
  });

  it('radial and cutting travel are travelStatsOf’s own numbers', () => {
    const program = ir([
      [rapid(0, 0, HOP_Z), cut(0, 0, -1, 200), cut(10, 5, -1, 200), rapid(10, 5, HOP_Z), rapid(30, 5, HOP_Z)],
    ]);
    const stats = travelStatsOf(program.operations.map((op) => op.moves));
    const measure = efficiencyOf(program, RAPID);
    expect(measure.rapidMm).toBeCloseTo(stats.rapidMm, 9);
    expect(measure.cutMm).toBeCloseTo(stats.cutMm, 9);
    expect(measure.rapidCutRatio).toBeCloseTo(stats.rapidMm / stats.cutMm, 9);
  });
});

describe('#926 efficiency: air fraction and hops', () => {
  it('a cut with no air reads zero; a program that travels reads its share', () => {
    const pureCut = ir([[cut(0, 0, -1, 200), cut(100, 0, -1, 200)]]);
    expect(efficiencyOf(pureCut, RAPID).airFraction).toBe(0);

    // 100 mm of air, 100 mm of cut: the air is faster, so its share is under half.
    const travelled = ir([[rapid(0, 0, HOP_Z), rapid(100, 0, HOP_Z), cut(100, 0, -1, 200), cut(200, 0, -1, 200)]]);
    const measure = efficiencyOf(travelled, RAPID);
    // The feed run starts with the 2 mm plunge from HOP_Z down to the cut (z = -1), as the cycle
    // estimate's run model does; the air is the 100 mm traverse only.
    const expected = trap(100, 1200, 150) / (trap(100, 1200, 150) + trap(102, 200, 150));
    expect(measure.airFraction).toBeCloseTo(expected, 9);
    expect(measure.airFraction).toBeGreaterThan(0);
    expect(measure.airFraction).toBeLessThan(1);
  });

  it('counts a hop as an XY traverse at the hop height, and times it as a rapid', () => {
    // stroke 1 → raise → traverse at hopZ → plunge → stroke 2.
    const withHop = ir([
      [
        rapid(0, 0, HOP_Z),
        cut(0, 0, -1, 200),
        cut(10, 0, -1, 200),
        rapid(10, 0, HOP_Z),
        rapid(30, 10, HOP_Z),
        rapid(30, 10, -1),
        cut(30, 10, -1, 200),
        cut(40, 10, -1, 200),
      ],
    ]);
    const measure = efficiencyOf(withHop, RAPID);
    expect(measure.hopCount).toBe(1);
    expect(measure.hopSeconds).toBeCloseTo(trap(Math.hypot(20, 10), 1200, 150), 9);
  });

  it('does not count the Z retracts or the operation entry as hops', () => {
    const program = ir([[rapid(0, 0, HOP_Z), cut(0, 0, -1, 200), cut(10, 0, -1, 200), rapid(10, 0, 5)]]);
    expect(efficiencyOf(program, RAPID).hopCount).toBe(0);
  });
});

describe('#926 efficiency: feed utilisation', () => {
  it('a long run at its commanded feed approaches 1; a short stroke never reaches it', () => {
    const long = ir([[cut(0, 0, -1, 100), cut(300, 0, -1, 100)]]);
    const longMeasure = efficiencyOf(long, RAPID);
    expect(longMeasure.commandedFeedSeconds).toBeCloseTo(180, 9);
    expect(longMeasure.feedUtilisation).toBeCloseTo(180 / trap(300, 100, 150), 9);
    expect(longMeasure.feedUtilisation).toBeGreaterThan(0.9);

    // 1 mm at F1000: the triangle is 2√(1/150) = 0.163 s against 0.06 s of commanded feed.
    const short = ir([[cut(0, 0, -1, 1000), cut(1, 0, -1, 1000)]]);
    const shortMeasure = efficiencyOf(short, RAPID);
    expect(shortMeasure.commandedFeedSeconds).toBeCloseTo(0.06, 9);
    expect(shortMeasure.feedUtilisation).toBeCloseTo(0.06 / trap(1, 1000, 150), 9);
    expect(shortMeasure.feedUtilisation!).toBeLessThan(0.5);
  });

  it('is null when the program does no feed time', () => {
    expect(efficiencyOf(ir([[rapid(0, 0, 0), rapid(10, 0, 0)]]), RAPID).feedUtilisation).toBeNull();
  });
});

describe('#926 efficiency: path length against the tour’s lower bound', () => {
  it('bounds a tour over the loop entries with the MST, and measures how far past it the air runs', () => {
    // Two loops entered 10 mm apart; the tool wanders in from the origin and back out.
    const program = ir([
      [
        rapid(0, 0, HOP_Z),
        rapid(20, 0, HOP_Z),
        rapid(20, 0, -1),
        cut(20, 0, -1, 200),
        cut(22, 0, -1, 200),
        rapid(22, 0, HOP_Z),
        rapid(12, 0, HOP_Z),
        rapid(12, 0, -1),
        cut(12, 0, -1, 200),
        cut(10, 0, -1, 200),
      ],
    ]);
    const measure = efficiencyOf(program, RAPID);
    // Entry points are (20, 0) and (12, 0); the MST is their 8 mm distance.
    expect(measure.tourBoundMm).toBeCloseTo(8, 9);
    // Air XY: 20 (first entry) + 10 (22 → 12) = 30 mm — and the first move is not charged.
    expect(measure.rapidMm).toBeCloseTo(30, 9);
    expect(measure.tourExcess).toBeCloseTo(30 / 8 - 1, 9);
  });

  it('has no bound with fewer than two distinct entries', () => {
    const one = ir([[rapid(0, 0, HOP_Z), cut(0, 0, -1, 200), cut(5, 0, -1, 200)]]);
    expect(efficiencyOf(one, RAPID).tourBoundMm).toBeNull();
    expect(efficiencyOf(one, RAPID).tourExcess).toBeNull();
  });

  it('a deliberately bad tour reads a higher air fraction and a larger excess than a good one', () => {
    // Three 10 mm strokes at x = 0, 100 and 200. The good order visits them in place; the bad one
    // zig-zags 0 → 200 → 100, which is a longer path over the SAME loop entries.
    const stroke = (x: number): CamMove[] => [
      rapid(x, 0, HOP_Z),
      rapid(x, 0, -1),
      cut(x, 0, -1, 200),
      cut(x + 10, 0, -1, 200),
    ];
    const leading = rapid(0, 0, HOP_Z);
    const good = ir([[leading, ...stroke(0), ...stroke(100), ...stroke(200)]]);
    const bad = ir([[leading, ...stroke(0), ...stroke(200), ...stroke(100)]]);
    const goodMeasure = efficiencyOf(good, RAPID);
    const badMeasure = efficiencyOf(bad, RAPID);
    expect(badMeasure.rapidMm).toBeGreaterThan(goodMeasure.rapidMm);
    expect(badMeasure.airFraction).toBeGreaterThan(goodMeasure.airFraction);
    expect(badMeasure.tourExcess!).toBeGreaterThan(goodMeasure.tourExcess!);
    // The bound itself is the same for both: it is the points, not the order they are visited in.
    expect(badMeasure.tourBoundMm).toBeCloseTo(goodMeasure.tourBoundMm!, 9);
  });
});

describe('#926 efficiency: the swept strip and the written fraction', () => {
  it('a flat cutter sweeps its diameter over the cutting path', () => {
    const measure = efficiencyOf(ir([[cut(0, 0, -1, 200), cut(10, 0, -1, 200)]]), RAPID);
    expect(measure.sweptAreaMm2).toBeCloseTo(10 * 3, 9);
    expect(measure.deepestCutMm).toBeCloseTo(1, 9);
  });

  it('a V widens with depth: the same path lower down sweeps a wider strip', () => {
    const vBit: Tool = flatEndMill(3.175, { shape: 'engraving', tipDiameter: 0.3, diameter: 3.175, halfAngle: 15, angle: 0 });
    const shallow = efficiencyOf(ir([[cut(0, 0, -0.5, 200), cut(10, 0, -0.5, 200)]], vBit), RAPID);
    const deep = efficiencyOf(ir([[cut(0, 0, -2, 200), cut(10, 0, -2, 200)]], vBit), RAPID);
    expect(deep.sweptAreaMm2!).toBeGreaterThan(shallow.sweptAreaMm2!);
    // width = 0.3 + 2·(2·tan 15°) = 0.3 + 1.0718 mm
    expect(deep.sweptAreaMm2!).toBeCloseTo(10 * (0.3 + 2 * 2 * Math.tan((15 * Math.PI) / 180)), 6);
  });


});
