// #j10 — THE PICK SCORES THE STROKES A CUTTER MERGES. j10's line art was cut with ⌀3.175 and
// ⌀0.6 flats: the wide one joins strokes 2 mm apart into one groove (the app's own "strokes merge"
// warning) and the shallower stroke is cut down to the deeper one's floor. A V bit in the library
// keeps each stroke its own V groove and also cuts the label at full fidelity — and now the pick
// finds it by itself: a cone is a candidate when the flat work is only regions, text and traces,
// and `measureTraceMerge` makes the merging flat lose.

import { describe, expect, it } from 'vitest';

import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { candidatePlans, byFidelity, type ScoredPlan } from '@/engine/cnc/engrave/smartPick';
import { measureTraceMerge, type TraceOutcome } from '@/workers/sim/planEvaluate';
import { flatEndMill } from '@/engine/cnc/tool';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import type { EngraveJob, EngraveTraceItem } from '@/types/engraveJob';

const FLAT = (d: number): ToolLibraryEntry => ({
  key: `flat-${d}`,
  provenance: 'test',
  tool: flatEndMill(d, { name: `${d} mm flat`, fluteLength: 20 }),
});
const ENGRAVER = (tip: number, halfAngleDeg: number): ToolLibraryEntry => ({
  key: `engraver-${tip}-${halfAngleDeg}`,
  provenance: 'test',
  tool: flatEndMill(3.175, {
    name: `${tip} mm V`,
    typeText: 'Engraving',
    shape: 'engraving',
    tipDiameter: tip,
    diameter: 3.175,
    halfAngle: halfAngleDeg,
    angle: halfAngleDeg * 2,
  }),
});

function line(id: string, y: number, depth: number): EngraveTraceItem {
  return {
    id,
    kind: 'line',
    position: { x: 0, y: 0 },
    rotation: 0,
    depth,
    enabled: true,
    points: [
      [10, y],
      [40, y],
    ],
    closed: false,
  };
}

/** Two parallel strokes 2 mm apart, the shallower 0.1 mm below the deeper. */
function strokeJob(): EngraveJob {
  const base = defaultEngraveJob();
  return {
    ...base,
    labels: [],
    shapes: [],
    vectors: [],
    combined: [],
    drills: [],
    threads: [],
    cutouts: [],
    chamfers: [],
    traces: [line('ray', 20, 0.5), line('tuft', 22, 0.4)],
    toolKey: '',
    stock: { ...base.stock, length: 60, width: 40, thickness: 10, material: 'pla' },
  };
}

const plan = (key: string) => ({ cutters: [{ key, items: ['ray', 'tuft'] }], source: { [key]: 'owned' as const } });

describe('the trace merge, measured per plan', () => {
  it('a wide flat joins the two strokes; a V keeps them apart', () => {
    const job = strokeJob();
    const flat = measureTraceMerge(job, plan('flat-3.175'), [FLAT(3.175)])!;
    // Capsules of radius 1.5875 with centrelines 2 mm apart overlap by 1.175 mm, and the 0.4 mm
    // stroke is cut to the 0.5 mm stroke's floor.
    expect(flat.mergedPairs).toBe(1);
    expect(flat.worstOverlapMm).toBeCloseTo(1.175, 3);
    expect(flat.worstDeepenMm).toBeCloseTo(0.1, 6);

    const v = measureTraceMerge(job, plan('engraver-0.1-30'), [ENGRAVER(0.1, 30)])!;
    expect(v.mergedPairs).toBe(0);
    expect(v.worstOverlapMm).toBe(0);
    expect(v.worstDeepenMm).toBe(0);
  });

  it('a pair that TOUCHES is a design joint, not a merge', () => {
    // The dandelion's tufts start on their rays' ends: the capsules touch at one point by design.
    const job = strokeJob();
    job.traces = [
      { ...line('ray', 20, 0.5), points: [[10, 20], [40, 20]] },
      { ...line('tuft', 20, 0.4), points: [[10, 20], [15, 30]] },
    ] as EngraveTraceItem[];
    const v = measureTraceMerge(job, plan('engraver-0.1-30'), [ENGRAVER(0.1, 30)])!;
    expect(v.mergedPairs).toBe(0);
  });
});

describe('ranking by the strokes a plan keeps', () => {
  const scored = (traces: TraceOutcome | undefined, worst = 1): ScoredPlan =>
    ({
      evaluation: { traces },
      counterStandingMm2: 0,
      raisedStandingMm2: 0,
      raisedJoined: 0,
      worstFidelity: worst,
      meanFidelity: worst,
    }) as unknown as ScoredPlan;

  it('at equal fidelity the plan that keeps the strokes apart wins', () => {
    const clean = scored({ mergedPairs: 0, worstOverlapMm: 0, worstDeepenMm: 0 });
    const merging = scored({ mergedPairs: 1, worstOverlapMm: 1.175, worstDeepenMm: 0.1 });
    expect(byFidelity(clean, merging)).toBeLessThan(0); // negative = `clean` ranks first
    expect(byFidelity(merging, clean)).toBeGreaterThan(0);
  });

  it('a measured fidelity difference outranks the merge', () => {
    // 92 % on a label is a worse result than 100 %; the merge decision is the tie-break.
    const lowerWithNoMerge = scored({ mergedPairs: 0, worstOverlapMm: 0, worstDeepenMm: 0 }, 0.925);
    const higherWithMerge = scored({ mergedPairs: 1, worstOverlapMm: 1.175, worstDeepenMm: 0.1 }, 1);
    expect(byFidelity(higherWithMerge, lowerWithNoMerge)).toBeLessThan(0);
  });
});

describe('a cone is a candidate for engraving-only work', () => {
  it('offers a V for a job whose flat work is only traces and text', () => {
    const job = strokeJob();
    const tools = [FLAT(3.175), ENGRAVER(0.5, 15)];
    const plans = candidatePlans(job, tools, []);
    const v = plans.find((p) => p.cutters[0]?.key === 'engraver-0.5-15');
    expect(v).toBeDefined();
    expect(v!.cutters[0]!.items).toEqual(['ray', 'tuft']);
  });

  it('does not offer a cone when the job also cuts a part free', () => {
    const job = strokeJob();
    job.cutouts = [{ kind: 'cutout', id: 'profile', enabled: true, of: 'ray', side: 'outside', inset: 0 }] as never;
    const tools = [FLAT(3.175), ENGRAVER(0.5, 15)];
    const plans = candidatePlans(job, tools, []);
    expect(plans.some((p) => p.cutters[0]?.key === 'engraver-0.5-15')).toBe(false);
  });

  it('does not offer a cone for a job of pockets alone', () => {
    // A V would leave sloped walls a flat-walled pocket's design does not ask for.
    const job = strokeJob();
    job.traces = [];
    job.shapes = [
      { id: 'pocket', kind: 'rect', position: { x: 30, y: 20 }, rotation: 0, width: 20, height: 12, cornerRadius: 0, depth: 2, enabled: true },
    ];
    const tools = [FLAT(3.175), ENGRAVER(0.5, 15)];
    const plans = candidatePlans(job, tools, []);
    expect(plans.some((p) => p.cutters[0]?.key === 'engraver-0.5-15')).toBe(false);
  });
});
