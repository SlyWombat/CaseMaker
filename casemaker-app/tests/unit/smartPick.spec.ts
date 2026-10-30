// #766 slice B — the search: kind-valid candidate plans, pruned, then chosen by the evaluator's
// measured numbers. The evaluator is a fake here: these cases pin the GENERATION and the
// OBJECTIVE (fidelity, then tool changes, then time; owned before catalogue, 'buy this' when a
// catalogue cutter genuinely measures better), not slice A.

import { describe, expect, it } from 'vitest';

import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { candidatePlans, planKey, rulePlanOf, smartPick, sourceOf, type Evaluate } from '@/engine/cnc/engrave/smartPick';
import { explainSmartPick } from '@/engine/cnc/engrave/smartPickWords';
import type { CandidatePlan, PlanEvaluation } from '@/workers/sim/planEvaluate';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import type { Tool, ToolShape } from '@/engine/cnc/tool';
import type { EngraveJob } from '@/types/engraveJob';

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
const FLAT_06_CAT = entry('cat:corn-0-6', 'flat', { tipDiameter: 0.6, diameter: 0.6, fluteLength: 3 });
// The house V that HAS a feed row: the starting table keys V rows to the tip (0.3/0.5 mm), so a
// 0.1 mm tip is a candidate only when the shop's catalogue covers it.
const V_01 = entry('inv:engraver-0-3', 'engraving', { tipDiameter: 0.3, diameter: 3.175, halfAngle: 15, fluteLength: null });

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

/** One evaluated item at a stated fidelity (no pinches unless a case adds them). */
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

/** A fake evaluator keyed by the plan's cutter keys; unlisted plans score LOW (0.05). */
function fakeEvaluator(scores: Record<string, number>, over: Record<string, Partial<PlanEvaluation>> = {}): Evaluate {
  return (plan: CandidatePlan): PlanEvaluation => {
    const key = plan.cutters.map((c) => c.key).join('+');
    return verdict(scores[key] ?? 0.05, over[key]);
  };
}

const tools = (entries: readonly ToolLibraryEntry[]) => entries;

describe('#766 B the search generates the plans worth trying', () => {
  it('the kind plan, single clearances, rough+rest pairs, and a V rest for raised text', () => {
    const plans = candidatePlans(coinJob(), tools([FLAT_2, FLAT_1, FLAT_06, V_01]), []);
    const keys = plans.map((p) => p.cutters.map((c) => c.key).join('+'));
    expect(keys).toContain('inv:flat-2');
    expect(keys).toContain('inv:flat-2+inv:corn-0-6');
    expect(keys).toContain('inv:flat-2+inv:engraver-0-3');
    // A rest must be FINER than the clearance it follows: the 2 mm never follows the 2 mm.
    expect(keys).not.toContain('inv:corn-0-6+inv:flat-2');
    // Every plan is deduped.
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('records each cutter’s source — owned before catalogue is the objective’s tie-break', () => {
    const plans = candidatePlans(coinJob(), tools([FLAT_2, FLAT_06_CAT]), []);
    const withCat = plans.find(
      (p) => p.cutters.some((c) => c.key === 'cat:corn-0-6') && p.cutters.some((c) => c.key === 'inv:flat-2'),
    )!;
    expect(withCat.source['cat:corn-0-6']).toBe('catalogue');
    expect(withCat.source['inv:flat-2']).toBe('owned');
    expect(sourceOf(FLAT_06)).toBe('owned');
  });

  it('never offers a rest that cannot reach the cut or fails the material gate', () => {
    const short = entry('inv:short-0-4', 'flat', { tipDiameter: 0.4, diameter: 0.4, fluteLength: 0.2 });
    const plans = candidatePlans(coinJob(), tools([FLAT_2, FLAT_1, short]), []);
    expect(plans.map((p) => p.cutters.map((c) => c.key).join('+'))).not.toContain('inv:flat-2+inv:short-0-4');
  });
});

describe('#766 B the chosen plan is the best measured one', () => {
  it('the coin: the V rest measures best, and the 0.6 corn is the runner-up', async () => {
    const scores = {
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
    const pick = await smartPick(coinJob(), tools([FLAT_2, FLAT_1, FLAT_06, V_01]), [], fakeEvaluator(scores));
    expect(pick.chosen.plan.cutters.map((c) => c.key)).toEqual(['inv:flat-2', 'inv:engraver-0-3']);
    expect(pick.chosen.worstFidelity).toBe(1);
    expect(pick.runnable).toBe(pick.chosen);
    expect(pick.bestMeasured.plan.cutters.map((c) => c.key)).toEqual(['inv:flat-2', 'inv:engraver-0-3']);
    expect(pick.runnerUp?.plan.cutters.map((c) => c.key)).toEqual(['inv:flat-2', 'inv:corn-0-6']);
    expect(pick.buyThis).toBeNull();
  });

  it('at equal fidelity the plan with fewer tool changes wins, then the shorter run', async () => {
    const scores = { 'inv:flat-2': 0.9, 'inv:flat-2+inv:flat-1': 0.9, 'inv:flat-2+inv:corn-0-6': 0.9 };
    const over = {
      'inv:flat-2+inv:flat-1': { toolChanges: 1, seconds: 90 } as Partial<PlanEvaluation>,
      'inv:flat-2+inv:corn-0-6': { toolChanges: 1, seconds: 120 } as Partial<PlanEvaluation>,
    };
    const pick = await smartPick(coinJob(), tools([FLAT_2, FLAT_1, FLAT_06]), [], fakeEvaluator(scores, over));
    expect(pick.chosen.plan.cutters.map((c) => c.key)).toEqual(['inv:flat-2']);
  });

  it('an owned plan within the buy margin stands, and a catalogue plan that truly measures better is chosen', async () => {
    // Within the margin: the owned 0.6 stands.
    const near = await smartPick(
      coinJob(),
      tools([FLAT_2, FLAT_06, FLAT_06_CAT]),
      [],
      fakeEvaluator({ 'inv:flat-2': 0.86, 'inv:flat-2+inv:corn-0-6': 0.86, 'inv:flat-2+cat:corn-0-6': 0.87, 'cat:corn-0-6': 0.5, 'inv:corn-0-6': 0.5, 'inv:flat-2+inv:corn-0-6+inv:flat-2': 0.5 }),
      { buyThisMargin: 0.02 },
    );
    expect(near.chosen.owned).toBe(true);
    expect(near.buyThis).toBeNull();

    // Beyond it: the catalogue plan is chosen AND named as the buy.
    const clear = await smartPick(
      coinJob(),
      tools([FLAT_2, FLAT_1, FLAT_06_CAT]),
      [],
      fakeEvaluator({ 'inv:flat-2': 0.6, 'inv:flat-2+inv:flat-1': 0.6, 'inv:flat-2+cat:corn-0-6': 0.86, 'cat:corn-0-6': 0.5, 'inv:flat-1': 0.5, 'inv:flat-1+cat:corn-0-6': 0.5 }),
      { buyThisMargin: 0.02 },
    );
    expect(clear.chosen.owned).toBe(false);
    expect(clear.buyThis?.plan.cutters.map((c) => c.key)).toEqual(['inv:flat-2', 'cat:corn-0-6']);
  });

  it('a refused plan with the best measured fidelity is still the answer, with the refusal stated', async () => {
    const pick = await smartPick(
      coinJob(),
      tools([FLAT_2, FLAT_1, FLAT_06, V_01]),
      [],
      fakeEvaluator(
        { 'inv:flat-2': 0.19, 'inv:flat-2+inv:flat-1': 0.6, 'inv:flat-2+inv:corn-0-6': 0.86, 'inv:flat-2+inv:engraver-0-3': 1, 'inv:flat-1': 0.3, 'inv:corn-0-6': 0.5, 'inv:flat-1+inv:corn-0-6': 0.7, 'inv:corn-0-6+inv:flat-1': 0.2, 'inv:flat-2+inv:flat-1+inv:corn-0-6': 0.8 },
        { 'inv:flat-2+inv:engraver-0-3': { ok: false, refusal: 'a V-bit is not a rest cutter here' } },
      ),
    );
    // POSTING FIRST: the refused V plan is the best-MEASURED sentence, and the plan that posts
    // (the 0.6 corn pair) is what is handed over.
    expect(pick.bestMeasured.plan.cutters.map((c) => c.key)).toEqual(['inv:flat-2', 'inv:engraver-0-3']);
    expect(pick.chosen.plan.cutters.map((c) => c.key)).toEqual(['inv:flat-2', 'inv:corn-0-6']);
    expect(pick.runnable).toBe(pick.chosen);
    expect(pick.notes.join(' ')).toContain('a V-bit is not a rest cutter here');
  });

  it('a much faster two-cutter plan beats a 4½-hour one-cutter plan (the j02 time guard)', async () => {
    // Taken literally, "fewest tool changes before shortest time" picked the single 0.6 corn at
    // 16 790 s over a 167 s two-cutter plan; a change is counted at its stated allowance instead.
    const scores = { 'inv:corn-0-6': 1, 'inv:flat-2+inv:corn-0-6': 1, 'inv:flat-2': 0.1, 'inv:flat-2+inv:flat-1': 0.1, 'inv:flat-1+inv:corn-0-6': 0.5, 'inv:flat-1': 0.5 };
    const over = {
      'inv:corn-0-6': { seconds: 16790, toolChanges: 0 },
      'inv:flat-2+inv:corn-0-6': { seconds: 167, toolChanges: 1 },
    };
    const pick = await smartPick(coinJob(), tools([FLAT_2, FLAT_1, FLAT_06]), [], fakeEvaluator(scores, over));
    expect(pick.chosen.plan.cutters.map((c) => c.key)).toEqual(['inv:flat-2', 'inv:corn-0-6']);
  });

  it('the rule’s kind plan is always a candidate, and is used with a sentence when it is the only one that posts', async () => {
    // The structural guard (#766 fix): the measured search can never do WORSE than #762's rule.
    const entries = tools([FLAT_2, FLAT_1, FLAT_06, V_01]);
    const rule = rulePlanOf(coinJob(), entries, [])!;
    const base = fakeEvaluator({});
    // Every other plan is refused at its full evaluation; the rule's plan posts.
    const evaluate: Evaluate = (plan, level) => {
      const verdictForPlan = base(plan, level);
      if (planKey(plan) === planKey(rule)) return verdictForPlan;
      return { ...verdictForPlan, ok: false, refusal: 'refused for the test' };
    };
    const pick = await smartPick(coinJob(), entries, [], evaluate);
    expect(pick.rule).not.toBeNull();
    expect(pick.runnable).not.toBeNull();
    expect(planKey(pick.chosen.plan)).toBe(planKey(rule));
    expect(pick.runnerUp).toBeNull();
    // And the explanation says why the measured answer is the rule's.
    const words = explainSmartPick(pick, tools([FLAT_2, FLAT_1, FLAT_06, V_01]));
    expect(words.fallback).toContain("the measured search found no better posting plan; using the rule's plan");
  });

  it('names the plan canonically, for dedupe and the evaluator’s cache', () => {
    const a: CandidatePlan = { cutters: [{ key: 'a', items: ['x', 'y'] }, { key: 'b', items: [] }], source: { a: 'owned', b: 'owned' } };
    expect(planKey(a)).toBe('a[x,y]|b[]');
  });
});
