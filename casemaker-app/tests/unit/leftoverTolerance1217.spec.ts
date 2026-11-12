/**
 * #1217 (planner v3 A1) — THE LEFTOVER TOLERANCE IN THE CUTTER-CHAIN RANK.
 *
 * Two chains whose leftover differs by less than a share of the goal's surface rank as EQUAL on
 * that key, so time and bit changes decide. The share is `plan.leftoverEquivalencePct` (0.5 %).
 * This fixture was run against the pre-change code: the candidates are `pocket:t6` (42.1 s,
 * 1,000 cells), `pocket:t6+rest:t3` (165.5 s, 700 cells) and `pocket:t3` (72.1 s, 1,000 cells).
 */
import { describe, expect, it } from 'vitest';

import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import type { CamMove, RapidEstimate, ToolpathIR } from '@/engine/cnc/cam/ir';
import {
  chooseSequence,
  type SequenceDemand,
  type SequenceStep,
} from '@/engine/cnc/cam/model/sequence';
import { readDefault } from '@/platform/defaultsClient';

const RAPID: RapidEstimate = {
  xyMmPerMin: 1200,
  zMmPerMin: 600,
  accelMmPerS2: 150,
  spinUpSeconds: 12,
  source: 'test',
};

function flat(id: string, diameter: number, opts: Partial<Tool> = {}): Tool {
  return flatEndMill(diameter, { id, name: `${diameter} mm flat (${id})`, number: 1, ...opts });
}

/** A program whose size stands for an op's work: N feed moves along X, 10 mm apart. */
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

const HOUSE = [flat('t6', 6, { fluteLength: 30 }), flat('t3', 3.175, { fluteLength: 20 })];
const DEMAND: SequenceDemand = { features: [{ id: 'p', kind: 'pocket', cornerRadiusMm: null, minOpeningMm: 20, depthMm: 5 }] };
const WORK: Record<string, number> = { 'pocket:t6': 30, 'rest:t3': 20, 'pocket:t3': 60 };
const sig = (steps: readonly SequenceStep[]): string => steps.map((s) => `${s.kind}:${s.cutter.key}`).join('+');
const choose = (pct: number | undefined) =>
  chooseSequence(DEMAND, { house: HOUSE, catalogue: [] }, {
    rapid: RAPID,
    toolChangeSeconds: 91.4,
    planStep: (step) => ir(step.cutter.tool, WORK[`${step.kind}:${step.cutter.key}`] ?? 50),
    coverage: (steps) => ({ leftoverCells: sig(steps).includes('rest:') ? 700 : 1000, coveredCells: 100000, cellAreaMm2: 0.01 }),
    ...(pct === undefined ? {} : { leftoverEquivalencePct: pct }),
  });

const chooseTall = (pct: number, tallWithoutRest: number, tallWithRest: number) =>
  chooseSequence(DEMAND, { house: HOUSE, catalogue: [] }, {
    rapid: RAPID,
    toolChangeSeconds: 91.4,
    planStep: (step) => ir(step.cutter.tool, WORK[`${step.kind}:${step.cutter.key}`] ?? 50),
    coverage: (steps) => {
      const rest = sig(steps).includes('rest:');
      return { leftoverCells: rest ? 700 : 1000, coveredCells: 100000, cellAreaMm2: 0.01, tallCells: rest ? tallWithRest : tallWithoutRest };
    },
    leftoverEquivalencePct: pct,
  });

describe('#1217 the leftover tolerance', () => {
  it('with no tolerance the least leftover wins, as today', () => {
    const choice = choose(undefined);
    expect(sig(choice.steps)).toBe('pocket:t6+rest:t3');
    expect(choice.leftoverTolerance).toBeUndefined();
  });

  it('zero is the same as none', () => {
    const choice = choose(0);
    expect(sig(choice.steps)).toBe('pocket:t6+rest:t3');
    expect(choice.leftoverTolerance).toBeUndefined();
  });

  it('within the tolerance, time decides', () => {
    const choice = choose(0.5);
    expect(sig(choice.steps)).toBe('pocket:t6');
    expect(choice.leftoverTolerance).toEqual({
      tolerancePct: 0.5,
      chosenLeftoverCells: 1000,
      bestLeftoverCells: 700,
      cellAreaMm2: 0.01,
      savedSeconds: 123,
    });
  });

  it('outside the tolerance, leftover still decides', () => {
    const choice = choose(0.2);
    expect(sig(choice.steps)).toBe('pocket:t6+rest:t3');
    expect(choice.leftoverTolerance).toBeUndefined();
  });

  it('exactly on the edge counts as within', () => {
    const choice = choose(0.3);
    expect(sig(choice.steps)).toBe('pocket:t6');
  });
});

describe('#1224 the tall-cell rule', () => {
  it('tall leftover is never forgiven', () => {
    const choice = chooseTall(0.5, 50, 0);
    expect(sig(choice.steps)).toBe('pocket:t6+rest:t3');
    // #1232 — the tall rule kept this (slower) chain; the note names the faster, taller one and
    // its giveaway is the difference of the two chains' own totals in this fixture.
    expect(choice.tallGuard).toBeDefined();
    expect(choice.tallGuard!.extraTallCells).toBe(50);
    const chainOf = (x: (typeof choice.considered)[number]): string =>
      x.steps.map((s) => `${s.kind}:${s.cutterKey}`).join('+');
    const passedOver = choice.considered.find((x) => chainOf(x) === 'pocket:t6');
    expect(passedOver?.cost).not.toBeNull();
    expect(choice.tallGuard!.givenUpSeconds).toBe(Math.round(choice.cost.totalSeconds - passedOver!.cost!));
  });

  it('equal tall leftover: time decides', () => {
    const choice = chooseTall(0.5, 50, 50);
    expect(sig(choice.steps)).toBe('pocket:t6');
    // The fastest chain won: the tall rule kept nothing back (#1232).
    expect(choice.tallGuard).toBeUndefined();
  });

  it('no tall leftover anywhere is the #1217 case', () => {
    expect(sig(chooseTall(0.5, 0, 0).steps)).toBe('pocket:t6');
  });

  it('fewer tall cells wins even with more leftover', () => {
    expect(sig(chooseTall(0.5, 0, 50).steps)).toBe('pocket:t6');
  });

  it('with the tolerance off, tall cells change nothing', () => {
    expect(sig(chooseTall(0, 50, 0).steps)).toBe('pocket:t6+rest:t3');
    expect(sig(chooseTall(0, 0, 50).steps)).toBe('pocket:t6+rest:t3');
  });
});

describe('#1217 the setting', () => {
  it('the tolerance is 0.5 % by default', () => {
    expect(readDefault(null, 'plan.leftoverEquivalencePct').value).toBe(0.5);
  });

  it('the tall height is 1.0 mm by default', () => {
    expect(readDefault(null, 'plan.leftoverTallMm').value).toBe(1);
  });
});

// #1242 (C3) — THE SHORTLIST FILTER ON chooseSequence, on this fixture's three candidates:
// `pocket:t6` (42.1 s, 1,000 cells), `pocket:t6+rest:t3` (165.5 s, 700 cells) and `pocket:t3`
// (72.1 s, 1,000 cells). Absent → the existing tests above, unedited.
import type { CandidateSequence } from '@/engine/cnc/cam/model/sequence';

const chooseShortlisted = (shortlist?: (candidates: readonly CandidateSequence[]) => readonly CandidateSequence[]) =>
  chooseSequence(DEMAND, { house: HOUSE, catalogue: [] }, {
    rapid: RAPID,
    toolChangeSeconds: 91.4,
    planStep: (step) => ir(step.cutter.tool, WORK[`${step.kind}:${step.cutter.key}`] ?? 50),
    coverage: (steps) => ({ leftoverCells: sig(steps).includes('rest:') ? 700 : 1000, coveredCells: 100000, cellAreaMm2: 0.01 }),
    ...(shortlist === undefined ? {} : { shortlist }),
  });

describe('#1242 the shortlist filter', () => {
  it('keeping every candidate leaves today’s choice untouched', () => {
    const base = chooseShortlisted();
    const kept = chooseShortlisted((candidates) => candidates);
    expect(sig(kept.steps)).toBe(sig(base.steps));
    expect(sig(kept.steps)).toBe('pocket:t6+rest:t3');
  });

  it('dropping the chosen chain picks the best of the two left, and nothing throws', () => {
    const kept = chooseShortlisted((candidates) =>
      candidates.filter((candidate) => sig(candidate.steps) !== 'pocket:t6+rest:t3'));
    expect(sig(kept.steps)).toBe('pocket:t6');
  });

  it('an empty shortlist is refused by name, not crashed', () => {
    expect(() => chooseShortlisted(() => [])).toThrow(/no cutter sequence can be planned/);
  });
});
