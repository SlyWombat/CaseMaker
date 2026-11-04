// #960 — A STEP THAT CANNOT PLAN DOES NOT KILL THE WHOLE PART.
//
// B's finding: `priceSequence` returned null for a candidate when ANY step's `planStep` returned
// null, so one op the geometry prune let through but the op refused (today `rough()` on a curved
// remainder) made `chooseSequence` throw "no cutter sequence can be planned" for the whole part.
// Same principle as B's per-region catch in `plan.ts`: the failed step plans nothing for its
// regions, those regions are STATED (in `unreachable`, with the reason in `unplanned`), and the
// candidate is still priced on what it did cut. Only a candidate whose PRIMARY step fails is
// disqualified — there is no roughing without it.

import { describe, expect, it } from 'vitest';

import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import type { CamMove, RapidEstimate, ToolpathIR } from '@/engine/cnc/cam/ir';
import {
  chooseSequence,
  type CutterCandidates,
  type SequenceDemand,
  type SequenceOptions,
  type SequenceStep,
} from '@/engine/cnc/cam/model/sequence';

const RAPID: RapidEstimate = {
  xyMmPerMin: 1200,
  zMmPerMin: 600,
  accelMmPerS2: 150,
  spinUpSeconds: 12,
  source: 'test',
};

const TOOL_CHANGE_SECONDS = 91.4;

const flat = (id: string, diameter: number): Tool =>
  flatEndMill(diameter, { id, name: id, number: 1, fluteLength: 30 });
const ball = (id: string, diameter: number): Tool =>
  flatEndMill(diameter, { id, name: id, number: 2, shape: 'ball', typeText: 'Ball End', fluteLength: 30 });

const FLAT6 = flat('t6', 6);
const BALL6 = ball('b6', 6);

const DEMAND: SequenceDemand = {
  features: [
    { id: 'pocket-a', kind: 'pocket', minOpeningMm: 8, depthMm: 4 },
    { id: 'scoop', kind: 'curved', curvatureRadiusMm: 30, depthMm: 4 },
  ],
};

const HOUSE: CutterCandidates = { house: [FLAT6, BALL6], catalogue: [] };

function ir(tool: Tool, moves: number): ToolpathIR {
  const list: CamMove[] = [{ kind: 'feed', x: 0, y: 0, z: -1, f: 600 }];
  for (let i = 1; i <= moves; i++) list.push({ kind: 'feed', x: i * 10, y: 0, z: -1, f: 600 });
  return {
    frame: 'flat',
    tool,
    toolNumber: 1,
    spindleRpm: 12000,
    air: true,
    safeZ: 5,
    hopZ: 2,
    operations: [{ number: 1, name: tool.name, labelId: 'op', depth: 1, moves: list, estimatedSeconds: 0 }],
  };
}

function opts(planStep: SequenceOptions['planStep']): SequenceOptions {
  return { rapid: RAPID, toolChangeSeconds: TOOL_CHANGE_SECONDS, planStep };
}

const base = (step: SequenceStep): ToolpathIR => ir(step.cutter.tool, 10);

describe('#960 a step that cannot plan', () => {
  it('is stated with its regions and reason, and the candidate is priced on what it cut', () => {
    const choice = chooseSequence(
      DEMAND,
      HOUSE,
      opts((step) => {
        if (step.kind === 'rough') throw new Error('rough() refused this curved remainder');
        return base(step);
      }),
    );
    // The rough step is gone; the pocket and the ball finish are posted.
    expect(choice.steps.map((s) => s.kind)).toEqual(['pocket', 'finish']);
    expect(choice.unreachable).toContain('scoop');
    expect(choice.unplanned).toEqual([
      { kind: 'rough', cutterKey: 't6', regionIds: ['scoop'], reason: 'rough() refused this curved remainder' },
    ]);
    // Priced on what it cut: one change (flat -> ball), no charge for the step that never ran.
    expect(choice.cost.toolChanges).toBe(1);
    expect(choice.considered.every((c) => c.cost !== null)).toBe(true);
    expect(choice.considered.some((c) => c.unplanned === 1)).toBe(true);
  });

  it('a planStep that plans NOTHING for a later step is stated the same way', () => {
    const choice = chooseSequence(
      DEMAND,
      HOUSE,
      opts((step) => (step.kind === 'finish' ? null : base(step))),
    );
    expect(choice.steps.map((s) => s.kind)).toEqual(['pocket', 'rough']);
    expect(choice.unplanned).toHaveLength(1);
    expect(choice.unplanned[0]!.kind).toBe('finish');
    expect(choice.unplanned[0]!.regionIds).toEqual(['scoop']);
    expect(choice.unplanned[0]!.reason).toContain('planned nothing');
  });

  it('a failed freeing step is stated and `freeing` is null, not an invented cutter', () => {
    const demand: SequenceDemand = {
      features: [
        { id: 'pocket-a', kind: 'pocket', minOpeningMm: 8, depthMm: 4 },
        { id: 'contour', kind: 'contour', depthMm: 4 },
      ],
    };
    const choice = chooseSequence(
      demand,
      { house: [FLAT6], catalogue: [] },
      opts((step) => (step.kind === 'contour' ? null : base(step))),
    );
    expect(choice.steps.map((s) => s.kind)).toEqual(['pocket']);
    expect(choice.freeing).toBeNull();
    expect(choice.unreachable).toContain('contour');
    expect(choice.unplanned[0]!.kind).toBe('contour');
  });

  it('only the PRIMARY step failing disqualifies the candidate', () => {
    expect(() =>
      chooseSequence(DEMAND, HOUSE, opts((step) => (step.kind === 'pocket' ? null : base(step)))),
    ).toThrow(/could not post/);
  });

  it('a candidate whose step fails ranks below one that plans everything, even when cheaper', () => {
    const goodBall = ball('good', 6);
    const badBall = ball('bad', 6);
    const choice = chooseSequence(
      DEMAND,
      { house: [FLAT6, goodBall, badBall], catalogue: [] },
      opts((step) => {
        // The cheap ball throws on its finish step; the dear one plans everything.
        if (step.cutter.key === 'bad' && step.kind === 'finish') throw new Error('the cheap ball cannot plan');
        return ir(step.cutter.tool, step.cutter.key === 'bad' ? 1 : step.kind === 'finish' ? 40 : 10);
      }),
    );
    expect(choice.steps.find((s) => s.kind === 'finish')!.cutter.key).toBe('good');
    const bad = choice.considered.find((c) => c.steps.some((s) => s.cutterKey === 'bad'))!;
    expect(bad.unplanned).toBe(1);
  });
});
