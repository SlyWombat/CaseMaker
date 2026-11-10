// #1137 — THE CAPPED FINALISTS RUN AS ONE BATCH, and the winner is the serial winner.
//
// The search's finalist block is the only part #1134's cap left expensive: three full evaluations,
// ~230 s each on the lid. The batch evaluator is the caller's budgeted pool (CLI worker threads; a
// pool of workers in the browser — see the caller tests). These cases pin the ENGINE half:
// the batch is one call with the capped finalists, positional, and the fold cannot move the choice
// — completion order is deliberately REVERSED here, and every observable answer must be identical
// to the serial run's.
import { describe, expect, it } from 'vitest';

import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import {
  candidatePlans,
  planKey,
  smartPick,
  type CandidatePlan,
  type Evaluate,
  type EvaluateMany,
  type SmartPick,
} from '@/engine/cnc/engrave/smartPick';
import type { PlanEvaluation } from '@/workers/sim/planEvaluate';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import type { Tool, ToolShape } from '@/engine/cnc/tool';
import type { EngraveJob } from '@/types/engraveJob';
import { picked } from './helpers/picked';

function entry(key: string, shape: ToolShape, over: Partial<Tool> = {}): ToolLibraryEntry {
  return {
    key,
    provenance: 'test',
    tool: {
      number: null,
      id: null,
      name: key,
      typeText: '',
      shape,
      handleDiameter: 3.175,
      tipDiameter: null,
      diameter: null,
      cornerRadius: null,
      angle: null,
      halfAngle: null,
      fluteLength: 12,
      shoulderLength: null,
      stickout: null,
      centreCutting: null,
      ...over,
    },
  };
}

const FLAT_2 = entry('inv:flat-2', 'flat', { tipDiameter: 2, diameter: 2, fluteLength: 12 });
const FLAT_1 = entry('inv:flat-1', 'flat', { tipDiameter: 1, diameter: 1, fluteLength: 7 });
const FLAT_06 = entry('inv:corn-0-6', 'flat', { tipDiameter: 0.6, diameter: 0.6, fluteLength: 3 });
const V_01 = entry('inv:engraver-0-3', 'engraving', { tipDiameter: 0.3, diameter: 3.175, halfAngle: 15, fluteLength: null });
const TOOLS = [FLAT_2, FLAT_1, FLAT_06, V_01];

/** The coin's shape: a disc clearing a field around a construction label (raised text). */
function coinJob(): EngraveJob {
  const job = defaultEngraveJob();
  job.stock = { length: 30, width: 30, thickness: 3, material: 'pla', shape: 'disc', diameter: 30 };
  job.labels = [
    { id: 'software', text: 'Software', font: 'sans-default', weight: 'regular', size: 3.6, position: { x: 15, y: 8.5 }, rotation: 0, depth: 0.4, enabled: true, construction: true },
  ];
  job.shapes = [
    { id: 'field', kind: 'circle', position: { x: 15, y: 15 }, rotation: 0, depth: 0.4, enabled: true, construction: true, diameter: 26 },
  ];
  job.combined = [
    { id: 'clear', kind: 'cutaway', position: { x: 0, y: 0 }, rotation: 0, depth: 0.4, enabled: true, outer: 'field', islands: ['software'] },
  ];
  job.traces = [];
  job.vectors = [];
  job.drills = [];
  job.threads = [];
  job.cutouts = [];
  job.chamfers = [];
  job.primitives = [];
  job.targetObject = undefined;
  job.toolKey = '';
  return job;
}

function verdict(fidelity: number, over: Partial<PlanEvaluation> = {}): PlanEvaluation {
  return {
    ok: true,
    refusal: null,
    items: [{ id: 'clear', name: 'the cut-away', kind: 'flat', fidelity, charsLost: 0, areaMismatchMm2: null, pinches: [] }],
    seconds: 100,
    toolChanges: 0,
    risk: { reachMarginMm: 5, holderClearanceMm: 5, chipLoadRatio: null },
    ...over,
  };
}

const keyOf = (plan: CandidatePlan): string => plan.cutters.map((c) => c.key).join('+');

/** The same fake scores the serial #766/#1134 cases use, so the two runs judge the same plans. */
const SCORES: Record<string, number> = {
  'inv:flat-2': 0.19,
  'inv:flat-2+inv:flat-1': 0.6,
  'inv:flat-2+inv:corn-0-6': 0.86,
  'inv:flat-2+inv:engraver-0-3': 1,
  'inv:flat-1': 0.3,
  'inv:corn-0-6': 0.5,
  'inv:flat-1+inv:corn-0-6': 0.7,
  'inv:corn-0-6+inv:flat-1': 0.2,
  'inv:flat-2+inv:flat-1+inv:corn-0-6': 0.8,
};
const OVER: Record<string, Partial<PlanEvaluation>> = {
  'inv:flat-2+inv:flat-1': { toolChanges: 1, seconds: 90 },
};

const evaluate: Evaluate = (plan) => verdict(SCORES[keyOf(plan)] ?? 0.05, OVER[keyOf(plan)]);

/** The answers a caller can observe, flattened for an equality assertion. */
function observable(pick: SmartPick): unknown {
  return {
    chosen: planKey(pick.chosen.plan),
    runnable: pick.runnable === null ? null : planKey(pick.runnable.plan),
    bestMeasured: planKey(pick.bestMeasured.plan),
    runnerUp: pick.runnerUp === null ? null : planKey(pick.runnerUp.plan),
    buyThis: pick.buyThis === null ? null : planKey(pick.buyThis.plan),
    notes: pick.notes,
    considered: pick.considered.map((s) => ({
      plan: planKey(s.plan),
      worst: s.worstFidelity,
      mean: s.meanFidelity,
      seconds: s.evaluation.seconds,
      changes: s.evaluation.toolChanges,
      ok: s.evaluation.ok,
      refusal: s.evaluation.refusal,
    })),
  };
}

/**
 * A batch evaluator whose promises complete in REVERSE plan order (last plan first), while the
 * returned array stays positional. If the fold read completion order, this would change the
 * answers; it must not.
 */
function reversedBatch(evaluateOne: Evaluate = evaluate): { many: EvaluateMany; calls: CandidatePlan[][] } {
  const calls: CandidatePlan[][] = [];
  const many: EvaluateMany = async (plans) => {
    calls.push([...plans]);
    const results = await Promise.all(
      plans.map(
        (plan, i) =>
          new Promise<PlanEvaluation>((resolve) => {
            setTimeout(() => resolve(evaluateOne(plan, 'full') as PlanEvaluation), (plans.length - i) * 5);
          }),
      ),
    );
    return results;
  };
  return { many, calls };
}

describe('#1137 the finalists run as one batch', () => {
  it('the winner, the ranking and the notes are IDENTICAL to the serial run despite reverse completion', async () => {
    const serial = picked(await smartPick(coinJob(), TOOLS, [], evaluate));
    const { many, calls } = reversedBatch();
    const parallel = picked(await smartPick(coinJob(), TOOLS, [], evaluate, { evaluateMany: many }));
    expect(calls).toHaveLength(1);
    expect(observable(parallel)).toEqual(observable(serial));
    // The coin's own answer is the point of the comparison, not an artifact of two empty picks.
    expect(keyOf(parallel.chosen.plan)).toBe('inv:flat-2+inv:engraver-0-3');
  });

  it('the batch is exactly the capped finalists — never more than fullFinalists, never a coarse pass', async () => {
    const seen: { level: string; plans: number }[] = [];
    const many: EvaluateMany = async (plans, level) => {
      seen.push({ level, plans: plans.length });
      return plans.map(() => verdict(1));
    };
    await smartPick(coinJob(), TOOLS, [], evaluate, { evaluateMany: many });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.level).toBe('full');
    expect(seen[0]!.plans).toBeGreaterThan(1);
    expect(seen[0]!.plans).toBeLessThanOrEqual(3);
  });

  it('with fullFinalists 1 the batch is not used at all — the serial path stays', async () => {
    let called = 0;
    const many: EvaluateMany = async (plans) => {
      called++;
      return plans.map(() => verdict(1));
    };
    const pick = picked(await smartPick(coinJob(), TOOLS, [], evaluate, { fullFinalists: 1, evaluateMany: many }));
    expect(called).toBe(0);
    expect(pick.notes.join(' ')).toMatch(/\d+ tied, 1 fully planned/);
  });

  it('a short batch answer throws rather than silently dropping a finalist', async () => {
    const many: EvaluateMany = async () => [];
    await expect(smartPick(coinJob(), TOOLS, [], evaluate, { evaluateMany: many })).rejects.toThrow(
      /the batch evaluator answered 0 of \d+ finalists/,
    );
  });

  it('the batch is positional: each verdict lands on its own plan, not on its completion slot', async () => {
    // Every plan gets a DISTINCT fidelity; reverse completion must not shuffle them.
    const distinct: Evaluate = (plan) => verdict(SCORES[keyOf(plan)] ?? 0.05);
    const { many } = reversedBatch(distinct);
    const serial = picked(await smartPick(coinJob(), TOOLS, [], distinct));
    const parallel = picked(await smartPick(coinJob(), TOOLS, [], distinct, { evaluateMany: many }));
    const fidelityOf = (pick: SmartPick, plan: CandidatePlan): number | undefined =>
      pick.considered.find((s) => planKey(s.plan) === planKey(plan))?.worstFidelity;
    for (const candidate of candidatePlans(coinJob(), TOOLS, [])) {
      expect(fidelityOf(parallel, candidate)).toBe(fidelityOf(serial, candidate));
    }
  });
});
