/**
 * #1252 — A CHAIN THAT CUTS INTO THE GOAL NEVER BEATS ONE THAT DOES NOT.
 *
 * The rank gains one key immediately after eligibility: the number of goal cells the chain's own
 * stamp leaves more than `plan.cutIntoFloorMm` (0.1 mm) below the goal, with the tolerance
 * `plan.cutIntoEquivalencePct` (0.05 % of the covered surface) built exactly as #1217's leftover
 * tolerance: floor = the smallest cut-in among the eligible measured chains + pct/100 x
 * coveredCells; the key is max(0, cutIntoCells − floor). Chains within the floor tie at 0 on this
 * key and the later keys decide; a chain beyond it ranks after every chain within it (fewer
 * first among those beyond); with the tolerance at 0 the key is the raw count.
 *
 * The fixture is #1217's three-candidate shape (`pocket:t6` 42.1 s, `pocket:t6+rest:t3` 165.5 s,
 * `pocket:t3` 72.1 s, 100,000 covered cells), giving each chain a stated `cutIntoCells`.
 */
import { describe, expect, it } from 'vitest';

import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import type { CamMove, RapidEstimate, ToolpathIR } from '@/engine/cnc/cam/ir';
import {
  chooseSequence,
  type SequenceDemand,
  type SequenceStep,
} from '@/engine/cnc/cam/model/sequence';
import { cutIntoSentence, goalCoverageCounts } from '@/engine/cnc/cam/model/plan';
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

interface Case {
  /** Per chain: its `cutIntoCells`, or null for a chain the caller could not simulate at all. */
  cutIn: Record<string, number | null>;
  /** `plan.cutIntoEquivalencePct`; absent = 0, the raw key. */
  cutIntoPct?: number;
  /** `plan.leftoverEquivalencePct`; absent = 0. */
  leftoverPct?: number;
  coveredCells?: number;
  house?: Tool[];
  allowPrimary?: (key: string) => boolean;
}

const choose = (c: Case) =>
  chooseSequence(DEMAND, { house: c.house ?? HOUSE, catalogue: [] }, {
    rapid: RAPID,
    toolChangeSeconds: 91.4,
    planStep: (step) => ir(step.cutter.tool, WORK[`${step.kind}:${step.cutter.key}`] ?? 50),
    coverage: (steps) => {
      const chain = sig(steps);
      const cells = c.cutIn[chain];
      if (cells === null) return null;
      return {
        leftoverCells: chain.includes('rest:') ? 700 : 1000,
        coveredCells: c.coveredCells ?? 100000,
        cellAreaMm2: 0.01,
        cutIntoCells: cells ?? 0,
      };
    },
    ...(c.leftoverPct === undefined ? {} : { leftoverEquivalencePct: c.leftoverPct }),
    ...(c.cutIntoPct === undefined ? {} : { cutIntoEquivalencePct: c.cutIntoPct }),
    ...(c.allowPrimary === undefined ? {} : { allowPrimary: c.allowPrimary }),
  });

const rankOfChain = (choice: ReturnType<typeof choose>, chain: string): number | null =>
  choice.considered.find((x) => x.steps.map((s) => `${s.kind}:${s.cutterKey}`).join('+') === chain)?.rank ?? null;

describe('#1252 the cut-into key, raw (tolerance 0)', () => {
  it('all three clean: the choice is exactly what it is today', () => {
    const clean = { 'pocket:t6': 0, 'pocket:t6+rest:t3': 0, 'pocket:t3': 0 };
    expect(sig(choose({ cutIn: clean }).steps)).toBe('pocket:t6+rest:t3');
    expect(sig(choose({ cutIn: clean, leftoverPct: 0 }).steps)).toBe('pocket:t6+rest:t3');
    expect(sig(choose({ cutIn: clean, leftoverPct: 0.5 }).steps)).toBe('pocket:t6');
  });

  it('the fastest chain that cuts in is not chosen, though it is fastest and inside the leftover tolerance', () => {
    const choice = choose({ leftoverPct: 0.5, cutIn: { 'pocket:t6': 50, 'pocket:t6+rest:t3': 0, 'pocket:t3': 0 } });
    // The best of the two clean ones by today's rules: within the tolerance, time decides.
    expect(sig(choice.steps)).toBe('pocket:t3');
    expect(choice.cutInto).toBeUndefined();
  });

  it('cut-in outranks both the leftover count and the tall count', () => {
    const choice = choose({ leftoverPct: 0.5, cutIn: { 'pocket:t6': 0, 'pocket:t6+rest:t3': 50, 'pocket:t3': 0 } });
    expect(sig(choice.steps)).toBe('pocket:t6');
    expect(choice.cutInto).toBeUndefined();
  });

  it('a chain with no coverage figure is ranked as 0 for this key and then by today’s rules', () => {
    const choice = choose({ leftoverPct: 0.5, cutIn: { 'pocket:t6': 0, 'pocket:t6+rest:t3': 0, 'pocket:t3': null } });
    expect(sig(choice.steps)).toBe('pocket:t6');
    expect(choice.cutInto).toBeUndefined();
  });

  it('with the tolerance at 0, the raw count decides: 8 beats 40', () => {
    const choice = choose({
      leftoverPct: 0.5,
      cutIn: { 'pocket:t6': 40, 'pocket:t6+rest:t3': 8, 'pocket:t3': 8 },
      cutIntoPct: 0,
    });
    expect(sig(choice.steps)).toBe('pocket:t3');
  });

  it('every candidate cuts in for real: the least is chosen and the sheet states its area', () => {
    const choice = choose({ cutIn: { 'pocket:t6': 50, 'pocket:t6+rest:t3': 80, 'pocket:t3': 20 } });
    expect(sig(choice.steps)).toBe('pocket:t3');
    expect(choice.cutInto).toEqual({ cells: 20, cellAreaMm2: 0.01 });
    expect(cutIntoSentence(choice.cutInto!, 0.1)).toBe(
      'The cutters chosen cut 0.2 mm² of the part more than 0.1 mm below the model; no set of cutters this shop owns avoids it.',
    );
  });
});

describe('#1252 the cut-into tolerance (the ruling’s cases, 100,000 covered cells, 0.05 % = 50 cells)', () => {
  it('chains at 8, 40 and 58 tie on this key and are ordered by today’s rules', () => {
    // All three within the floor (8 + 50 = 58): the least leftover decides — the rest chain.
    const choice = choose({ cutIntoPct: 0.05, cutIn: { 'pocket:t6': 40, 'pocket:t6+rest:t3': 8, 'pocket:t3': 58 } });
    expect(sig(choice.steps)).toBe('pocket:t6+rest:t3');
    expect(choice.cutInto).toBeUndefined();
  });

  it('a chain at 59 ranks after all three whatever its leftover and time', () => {
    // The 59-cell chain is the fastest; the key still keeps it below the tie group.
    const choice = choose({ cutIntoPct: 0.05, cutIn: { 'pocket:t6': 59, 'pocket:t6+rest:t3': 8, 'pocket:t3': 58 } });
    expect(sig(choice.steps)).toBe('pocket:t6+rest:t3');
    expect(choice.cutInto).toBeUndefined();
  });

  it('chains beyond the floor rank after the clean ones, fewer first', () => {
    const choice = choose({ cutIntoPct: 0.05, cutIn: { 'pocket:t6': 5000, 'pocket:t6+rest:t3': 8, 'pocket:t3': 9000 } });
    expect(sig(choice.steps)).toBe('pocket:t6+rest:t3');
    // Both beyond the floor (58): 5,000 before 9,000 whatever their leftover and time.
    expect(rankOfChain(choice, 'pocket:t6')).toBe(2);
    expect(rankOfChain(choice, 'pocket:t3')).toBe(3);
    expect(choice.cutInto).toBeUndefined();
  });

  it('the tolerance makes a 53-cell chain and an 8-cell chain equal: today’s keys pick the tray’s pick', () => {
    // The tray top's own arithmetic (covered 1,441,121; floor 8 + 721 = 729): the 53-cell chain
    // stays equal to the 8-cell one and today's keys decide — the least leftover, the #1251 pick.
    const choice = choose({
      cutIntoPct: 0.05,
      coveredCells: 1441121,
      cutIn: { 'pocket:t6': 53, 'pocket:t6+rest:t3': 8, 'pocket:t3': 8 },
    });
    expect(sig(choice.steps)).toBe('pocket:t6+rest:t3');
    expect(choice.cutInto).toBeUndefined();
  });
});

describe('#1252 the clamp card’s gouging chain with the shortlist’s filter (gate 1)', () => {
  it('a shortlist that drops the true pick still never chooses the 8,568-cell chain', () => {
    // The clamp card's own numbers: 52,298 covered cells, clean chains at 6, the #1242 chain at
    // 8,568 (the V floor through the ⌀6 flat). The shortlist's filter is not on this base (it was
    // reverted); this is its question at the rank: the true ⌀6 clean pick is not a candidate
    // (`allowPrimary` drops the ⌀6 primary, standing in for the shortlist), the gouging-class
    // chain is offered as the fastest, and the key must still take the 6-cell chain.
    const choice = choose({
      cutIntoPct: 0.05,
      coveredCells: 52298,
      allowPrimary: (key) => key !== 't6',
      cutIn: { 'pocket:t6': 8568, 'pocket:t6+rest:t3': 8568, 'pocket:t3': 6 },
    });
    // Floor = 6 + 0.05 % x 52,298 = 32.1 cells: the 6-cell chain ties at 0; the gouge reads 8,536.
    expect(sig(choice.steps)).toBe('pocket:t3');
    expect(choice.cutInto).toBeUndefined();
  });
});

describe('#1252 the coverage count', () => {
  it('counts the cells more than the floor below the goal, and the floor moves the count', () => {
    // 20 covered cells: 7 are 0.2 mm below the goal, 3 are 0.05 mm below, 10 match it exactly.
    const nx = 10;
    const ny = 2;
    const goal = {
      nx,
      ny,
      x0: 0,
      y0: 0,
      pitch: 0.5,
      z: new Float32Array(nx * ny).fill(1),
      covered: new Uint8Array(nx * ny).fill(1),
    };
    const stamp = new Float32Array(nx * ny).fill(1);
    for (let k = 0; k < 7; k++) stamp[k] = 0.8;
    for (let k = 7; k < 10; k++) stamp[k] = 0.95;
    const bands = { leftoverBandMm: 0.1, tallMm: 1, cutIntoFloorMm: 0.1 };
    const atRecommended = goalCoverageCounts(goal, stamp, bands);
    expect(atRecommended.cutIntoCells).toBe(7);
    expect(atRecommended.coveredCells).toBe(20);
    expect(atRecommended.cellAreaMm2).toBe(0.25);
    // The floor at 0.01 mm counts the 0.05 mm band too.
    expect(goalCoverageCounts(goal, stamp, { ...bands, cutIntoFloorMm: 0.01 }).cutIntoCells).toBe(10);
  });
});

describe('#1252 the settings', () => {
  it('the depth floor is 0.1 mm by default', () => {
    expect(readDefault(null, 'plan.cutIntoFloorMm').value).toBe(0.1);
  });

  it('the equivalence share is 0.05 % by default', () => {
    expect(readDefault(null, 'plan.cutIntoEquivalencePct').value).toBe(0.05);
  });
});
