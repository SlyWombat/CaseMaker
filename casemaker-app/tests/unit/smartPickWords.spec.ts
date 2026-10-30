// #766 slice C — the search's sentences. They are built from slice A's evaluation only, so every
// number in the words is the number the ranking used. The raised-text line is #765's: what
// separates, and where the work still touches.

import { describe, expect, it } from 'vitest';

import {
  buyThisLine,
  cutterLines,
  explainSmartPick,
  joinedPinchWords,
  planLabel,
  ruleDifferenceLine,
  runnerUpLine,
} from '@/engine/cnc/engrave/smartPickWords';
import type { ScoredPlan, SmartPick } from '@/engine/cnc/engrave/smartPick';
import type { CandidatePlan, EvaluatedItem, PinchFact, PlanEvaluation } from '@/workers/sim/planEvaluate';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import type { ToolShape } from '@/engine/cnc/tool';

function entry(key: string, shape: ToolShape, tip: number): ToolLibraryEntry {
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
      tipDiameter: tip,
      diameter: shape === 'flat' ? tip : 3.175,
      cornerRadius: null,
      angle: null,
      halfAngle: null,
      fluteLength: 12,
      shoulderLength: null,
      stickout: null,
      centreCutting: null,
    },
  };
}

const TOOLS = [
  entry('inv:flat-2', 'flat', 2),
  entry('inv:flat-1', 'flat', 1),
  entry('inv:corn-0-6', 'flat', 0.6),
  entry('cat:corn-0-6', 'flat', 0.6),
  entry('inv:engraver-0-1', 'engraving', 0.1),
];

function pinch(over: Partial<PinchFact> = {}): PinchFact {
  return { between: ['S', 'o'], gapMm: 0.278, separated: false, edgeLossMm: 0, areaMm2: 0.12, ...over };
}

function item(over: Partial<EvaluatedItem> = {}): EvaluatedItem {
  return { id: 'clear', name: '"Software"', kind: 'flat', fidelity: 0.6, charsLost: 0, areaMismatchMm2: null, pinches: [], ...over };
}

function evaluation(items: EvaluatedItem[], over: Partial<PlanEvaluation> = {}): PlanEvaluation {
  return {
    ok: true,
    refusal: null,
    items,
    seconds: 120,
    toolChanges: 1,
    risk: { reachMarginMm: 5, holderClearanceMm: 5, chipLoadRatio: null },
    ...over,
  };
}

function plan(keys: [string, string[]][]): CandidatePlan {
  return {
    cutters: keys.map(([key, items]) => ({ key, items })),
    source: Object.fromEntries(keys.map(([key]) => [key, key.startsWith('cat:') ? 'catalogue' : 'owned'])),
  };
}

function scored(p: CandidatePlan, e: PlanEvaluation): ScoredPlan {
  const worst = Math.min(...e.items.map((i) => i.fidelity));
  const worstItem = e.items.find((i) => i.fidelity === worst) ?? null;
  const joined = e.items.flatMap((i) => i.pinches.filter((pinch) => !pinch.separated));
  return {
    plan: p,
    evaluation: e,
    worstFidelity: worst,
    meanFidelity: e.items.reduce((s, i) => s + i.fidelity, 0) / Math.max(1, e.items.length),
    raisedStandingMm2: joined.reduce((sum, pinch) => sum + pinch.areaMm2, 0),
    raisedJoined: joined.length,
    owned: p.cutters.every((c) => p.source[c.key] !== 'catalogue'),
    worstItem,
  };
}

const COIN = plan([['inv:flat-2', ['clear']], ['inv:corn-0-6', []]]);

/** A SmartPick for the word tests: by default the chosen plan posts and is the best measured one. */
function pickOf(over: Partial<SmartPick> & { chosen: ScoredPlan }): SmartPick {
  return { rule: null, runnable: over.chosen, bestMeasured: over.chosen, runnerUp: null, buyThis: null, considered: [over.chosen], notes: [], ...over };
}

describe('#766 C the words say what the measurement says', () => {
  it('a rest cutter says what its width separates and what stays joined, by name', () => {
    const chosen = scored(
      COIN,
      evaluation([
        item({
          fidelity: 0.86,
          pinches: [
            pinch({ between: ['S', 'o'], separated: false, gapMm: 0.278 }),
            pinch({ between: ['t', 'w'], separated: false, gapMm: 0.31 }),
            pinch({ between: ['f', 't'], separated: true }),
          ],
        }),
      ]),
    );
    const pick = pickOf({ chosen });
    const lines = cutterLines(pick, TOOLS);
    expect(lines[1]).toContain('rest — re-cuts what the earlier cutter left');
    expect(lines[1]).toContain('2 pinches in "Software" stay joined (0.278 mm at the tightest), between S–o, t–w');
  });

  it('a V that separates every pinch states its edge loss', () => {
    const vPlan = plan([['inv:flat-2', ['clear']], ['inv:engraver-0-1', []]]);
    const chosen = scored(
      vPlan,
      evaluation([
        item({ fidelity: 1, pinches: [pinch({ between: ['t', 'f'], separated: true, edgeLossMm: 0.018, areaMm2: 0 })] }),
      ]),
    );
    const words = cutterLines(pickOf({ chosen }), TOOLS);
    expect(words[1]).toContain('every pinch point in "Software" separates');
    expect(words[1]).toContain('0.018 mm per side');
    expect(joinedPinchWords(chosen.evaluation.items[0]!)).toEqual([]);
  });

  it('the runner-up is described by the pinches it leaves joined, with both measured numbers', () => {
    const chosen = scored(plan([['inv:flat-2', ['clear']], ['inv:engraver-0-1', []]]), evaluation([item({ fidelity: 1, pinches: [] })]));
    const runner = scored(
      COIN,
      evaluation([item({ fidelity: 0.6, pinches: [pinch({ between: ['t', 'w'] }), pinch({ between: ['S', 'o'] })] })]),
    );
    const pick = pickOf({ chosen, runnerUp: runner, considered: [chosen, runner] });
    const line = runnerUpLine(pick);
    expect(line).toContain('leaves 2 pinches joined');
    expect(line).toContain('S–o ("Software")');
    expect(line).toContain('60 % where the chosen plan measures 100 %');
  });

  it('a catalogue cutter that measures better is named as the buy, with its gain', () => {
    const chosen = scored(COIN, evaluation([item({ fidelity: 0.6, pinches: [pinch({ between: ['S', 'o'] })] })]));
    const buy = scored(
      plan([['inv:flat-2', ['clear']], ['cat:corn-0-6', []]]),
      evaluation([item({ fidelity: 0.9, pinches: [pinch({ between: ['t', 'w'] })] })]),
    );
    const pick = pickOf({ chosen, buyThis: buy, considered: [chosen, buy] });
    const line = buyThisLine(pick, TOOLS);
    expect(line).toContain('Buy ⌀0.6 mm (cat:corn-0-6)');
    expect(line).toContain('90 % against 60 %');
    expect(line).toContain('still leaves 1 pinch joined');
  });

  it('the verdict states the objective’s own numbers, and a non-posting plan states why', () => {
    const ok = scored(COIN, evaluation([item({ fidelity: 0.86 })]));
    const posts = explainSmartPick(pickOf({ chosen: ok }), TOOLS);
    expect(posts.verdict).toContain('86 % fidelity on the worst item, 1 tool change, about 120 s');
    // A plan that does not post is the best-MEASURED sentence only; with no runnable plan the
    // verdict says so in the refusal's own words.
    const refused = scored(COIN, evaluation([item({ fidelity: 1 })], { ok: false, refusal: 'a V-bit is not a rest cutter here', seconds: null }));
    const pending = explainSmartPick(pickOf({ chosen: refused, runnable: null }), TOOLS);
    expect(pending.verdict).toContain('No plan the search tried posts');
    expect(pending.verdict).toContain('a V-bit is not a rest cutter here');
  });

  it('#766 D — the measured plan is named plainly, and a differing rule answer says what it would do', () => {
    const measured = scored(plan([['inv:flat-2', ['clear']], ['inv:engraver-0-1', []]]), evaluation([item({ fidelity: 1 })]));
    // The quick rule's plan used the ⌀1 rest this job does NOT choose.
    const rule = scored(
      plan([['inv:flat-2', ['clear']], ['inv:flat-1', []]]),
      evaluation([
        item({
          fidelity: 0.86,
          pinches: [
            pinch({ between: ['S', 'o'], separated: false }),
            pinch({ between: ['t', 'w'], separated: false }),
            pinch({ between: ['f', 't'], separated: false }),
          ],
        }),
      ]),
    );
    const words = explainSmartPick(pickOf({ chosen: measured, rule, considered: [rule, measured] }), TOOLS);
    // The plan's own name, and the difference sentence in the manager's shape.
    expect(planLabel(measured.plan, TOOLS)).toContain('⌀2');
    expect(words.difference).toBe('the quick rule\'s ⌀1 rest would leave "Software" joined at 3 pinches');
    // The same rule plan as the chosen one is no difference at all.
    const same = explainSmartPick(pickOf({ chosen: measured, rule: measured }), TOOLS);
    expect(same.difference).toBeNull();
    // A rule plan that leaves no pinch joined but loses fidelity still says what it loses.
    const lossy = scored(plan([['inv:flat-2', ['clear']]]), evaluation([item({ fidelity: 0.8, pinches: [] })]));
    expect(ruleDifferenceLine(pickOf({ chosen: measured, rule: lossy }), TOOLS)).toContain('would measure 80 % on "Software"');
  });
});
