// #1186 — ONE CURRENCY: THE TIME THE PLAN WILL REALLY TAKE (the analyst's fields, comment
// 6778274639). A candidate chain is ranked by its total seconds — each program at the feed and
// step-down its cutter ACTUALLY runs in this material (its own row, or the borrowed row the CAM
// resolves), plus the priced bit changes. An ordering rule ('largest flat first', 'owned before
// catalogue') may only PROPOSE chains; it never wins against a cheaper total. Ties go to fewer bit
// changes, then to owned.
//
// The pair the fields name, in the engine's own chain terms: A = the larger flat on a borrowed,
// slow row; B = the smaller flat on its own, fast row. When B's total is lower B wins; when B's
// cut is dearer than A's borrow, A wins. The same pair goes through the ideal plan.
import { describe, expect, it } from 'vitest';

import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import type { CamMove, RapidEstimate, ToolpathIR } from '@/engine/cnc/cam/ir';
import {
  candidateSequences,
  chooseSequence,
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

/** A part both flats can cut whole: one pocket either enters, and an outline inside both flutes. */
const DEMAND: SequenceDemand = {
  features: [
    { id: 'pocket', kind: 'pocket', cornerRadiusMm: 1.5, minOpeningMm: 8, depthMm: 5 },
    { id: 'outline', kind: 'contour', depthMm: 5 },
  ],
  scallopMm: 0.05,
};

const BIG = flatEndMill(6, { id: 'big', name: '6 mm flat · borrowed row', number: 1, fluteLength: 30 });
const SMALL = flatEndMill(3.175, { id: 'small', name: '3.175 mm flat · own row', number: 2, fluteLength: 20 });

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

/** The realised seconds per step: the BIG pieces are the borrowed, slow cut; SMALL runs its own. */
const SLOW_BORROW: Record<string, number> = {
  'pocket:big': 300,
  'contour:big': 200,
  'pocket:small': 60,
  'contour:small': 40,
};

function opts(work: Record<string, number>, over: Partial<SequenceOptions> = {}): SequenceOptions {
  const standIn = (step: SequenceStep): ToolpathIR => ir(step.cutter.tool, work[`${step.kind}:${step.cutter.key}`] ?? 50);
  return { rapid: RAPID, toolChangeSeconds: 91.4, planStep: standIn, ...over };
}

const keysOf = (steps: readonly { cutter: { key: string } }[]): string[] => steps.map((s) => s.cutter.key);

describe('#1186 — a cheaper total beats the bigger cutter', () => {
  it('proposes the smaller flat as a primary, not only the largest', () => {
    // The pair must EXIST before it can be priced: the largest-flat-first rule may only propose.
    const candidates = candidateSequences(DEMAND, { house: [BIG, SMALL], catalogue: [] });
    const starts = new Set(candidates.map((c) => c.steps[0]?.cutter.key));
    expect(starts.has('big')).toBe(true);
    expect(starts.has('small')).toBe(true);
  });

  it('picks the smaller flat on its own row over the larger on the borrowed one', () => {
    // A = big pocket + big outline: 500 s, no change. B = small pocket + small outline: 100 s → B.
    const choice = chooseSequence(DEMAND, { house: [BIG, SMALL], catalogue: [] }, opts(SLOW_BORROW));
    expect(keysOf(choice.steps)).toEqual(['small', 'small']);
    expect(choice.steps.map((s) => s.kind)).toEqual(['pocket', 'contour']);
  });

  it('picks the larger cutter when ITS total is the lower one', () => {
    // The small flat's own row can be dearer than the borrow (a hard material, a slow fine row).
    const dearSmall = { ...SLOW_BORROW, 'pocket:small': 400, 'contour:small': 300 };
    const choice = chooseSequence(DEMAND, { house: [BIG, SMALL], catalogue: [] }, opts(dearSmall));
    expect(keysOf(choice.steps)).toEqual(['big', 'big']);
  });

  it('a cheaper catalogue chain beats a dearer owned one — owned only breaks ties', () => {
    const choice = chooseSequence(DEMAND, { house: [BIG], catalogue: [SMALL] }, opts(SLOW_BORROW));
    expect(keysOf(choice.steps)).toEqual(['small', 'small']);
    // The same pair through the ideal plan (house ∪ catalogue) reads the same way.
    const ideal = chooseSequence(DEMAND, { house: [BIG], catalogue: [SMALL] }, opts(SLOW_BORROW));
    expect(ideal.steps.every((s) => s.cutter.key === 'small')).toBe(true);
  });

  it('#1192 minimum — the shortlist gates which flats may primary, and a dropped one stays a rest', () => {
    // Only BIG may primary; the small flat is not a program of its own.
    const choice = chooseSequence(DEMAND, { house: [BIG, SMALL], catalogue: [] }, { ...opts(SLOW_BORROW), allowPrimary: (key) => key === 'big' });
    expect(keysOf(choice.steps)).toEqual(['big', 'big']);
    const candidates = candidateSequences(DEMAND, { house: [BIG, SMALL], catalogue: [] }, { allowPrimary: (key) => key === 'big' });
    expect(candidates.every((c) => c.steps.every((step) => step.cutter.key !== 'small' || step.kind === 'rest'))).toBe(true);
  });

  it('on an equal total, fewer bit changes first, then owned', () => {
    // Two same-diameter flats, identical work: the tie falls to owned over catalogue.
    const twin = flatEndMill(6, { id: 'twin', name: '6 mm flat · catalogue', number: 3, fluteLength: 30 });
    const work = { 'pocket:big': 100, 'contour:big': 100, 'pocket:twin': 100, 'contour:twin': 100 };
    const choice = chooseSequence(DEMAND, { house: [BIG], catalogue: [twin] }, opts(work));
    expect(keysOf(choice.steps)).toEqual(['big', 'big']);
  });
});
