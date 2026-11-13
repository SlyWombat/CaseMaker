/**
 * #1252 — A CHAIN THAT CUTS INTO THE GOAL NEVER BEATS ONE THAT DOES NOT.
 *
 * The rank gains one key, ahead of everything but eligibility: the number of goal cells the
 * chain's own stamp leaves below the goal by more than the shop's `plan.cutIntoFloorMm`
 * (recommended 0.1 mm — the same depth the check's card rule calls cut into). On #1217's
 * three-candidate fixture (`pocket:t6` 42.1 s, `pocket:t6+rest:t3` 165.5 s, `pocket:t3` 72.1 s),
 * each chain's coverage states its own `cutIntoCells`.
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

/** Per chain: its `cutIntoCells`, or null for a chain the caller could not simulate at all. */
type CutIn = Record<string, number | null>;

const chooseCut = (pct: number | undefined, cutIn: CutIn) =>
  chooseSequence(DEMAND, { house: HOUSE, catalogue: [] }, {
    rapid: RAPID,
    toolChangeSeconds: 91.4,
    planStep: (step) => ir(step.cutter.tool, WORK[`${step.kind}:${step.cutter.key}`] ?? 50),
    coverage: (steps) => {
      const chain = sig(steps);
      const cells = cutIn[chain];
      if (cells === null) return null;
      return {
        leftoverCells: chain.includes('rest:') ? 700 : 1000,
        coveredCells: 100000,
        cellAreaMm2: 0.01,
        cutIntoCells: cells ?? 0,
      };
    },
    ...(pct === undefined ? {} : { leftoverEquivalencePct: pct }),
  });

/** The same fixture with no `cutIntoCells` at all — the rank as it was before #1252. */
const chooseBefore = (pct: number | undefined) =>
  chooseSequence(DEMAND, { house: HOUSE, catalogue: [] }, {
    rapid: RAPID,
    toolChangeSeconds: 91.4,
    planStep: (step) => ir(step.cutter.tool, WORK[`${step.kind}:${step.cutter.key}`] ?? 50),
    coverage: (steps) => ({
      leftoverCells: sig(steps).includes('rest:') ? 700 : 1000,
      coveredCells: 100000,
      cellAreaMm2: 0.01,
    }),
    ...(pct === undefined ? {} : { leftoverEquivalencePct: pct }),
  });

describe('#1252 the cut-into key', () => {
  it('all three clean: the choice is exactly what it is today', () => {
    for (const pct of [undefined, 0, 0.5]) {
      const after = chooseCut(pct, { 'pocket:t6': 0, 'pocket:t6+rest:t3': 0, 'pocket:t3': 0 });
      expect(sig(after.steps)).toBe(sig(chooseBefore(pct).steps));
    }
    // The fixture's own picks, pinned: least leftover with no tolerance, time inside it.
    expect(sig(chooseCut(undefined, {}).steps)).toBe('pocket:t6+rest:t3');
    expect(sig(chooseCut(0.5, {}).steps)).toBe('pocket:t6');
  });

  it('the fastest chain that cuts in is not chosen, though it is fastest and inside the tolerance', () => {
    const choice = chooseCut(0.5, { 'pocket:t6': 50, 'pocket:t6+rest:t3': 0, 'pocket:t3': 0 });
    // The best of the two clean ones by today's rules: within the tolerance, time decides.
    expect(sig(choice.steps)).toBe('pocket:t3');
    expect(choice.cutInto).toBeUndefined();
  });

  it('every chain cuts in: the least is chosen and the sheet states the area', () => {
    const choice = chooseCut(0.5, { 'pocket:t6': 50, 'pocket:t6+rest:t3': 80, 'pocket:t3': 20 });
    expect(sig(choice.steps)).toBe('pocket:t3');
    expect(choice.cutInto).toEqual({ cells: 20, cellAreaMm2: 0.01 });
    expect(cutIntoSentence(choice.cutInto!, 0.1)).toBe(
      'The cutters chosen cut 0.2 mm² of the part more than 0.1 mm below the model; no set of cutters this shop owns avoids it.',
    );
  });

  it('cut-in outranks both the leftover count and the tall count', () => {
    // The chain that cuts in leaves the least leftover of the three, and no tall cells anywhere.
    const choice = chooseCut(0.5, { 'pocket:t6': 0, 'pocket:t6+rest:t3': 50, 'pocket:t3': 0 });
    expect(sig(choice.steps)).toBe('pocket:t6');
    expect(choice.cutInto).toBeUndefined();
  });

  it('a chain with no coverage figure is ranked as 0 for this key and then by today’s rules', () => {
    // `pocket:t3` could not be simulated: null ranks as no cut-in, and the measured chains'
    // leftover still ranks it by the keys after this one.
    const choice = chooseCut(0.5, { 'pocket:t6': 0, 'pocket:t6+rest:t3': 0, 'pocket:t3': null });
    expect(sig(choice.steps)).toBe('pocket:t6');
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

  it('the floor is a shop setting, 0.1 mm by default', () => {
    expect(readDefault(null, 'plan.cutIntoFloorMm').value).toBe(0.1);
  });
});
