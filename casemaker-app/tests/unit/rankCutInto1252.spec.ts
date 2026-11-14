/**
 * #1252 — A CHAIN THAT CUTS INTO THE GOAL NEVER BEATS ONE THAT DOES NOT, ASKED OF THE CHAIN
 * THAT IS ABOUT TO WIN.
 *
 * The rank is exactly today's (there is no cut-into key). The picker then asks the injected
 * adjudicator about the first-ranked chain: clean (0 adjudicated cells) → chosen, one call; not →
 * set aside and the next is asked, until a clean one is found (the note "A faster set of cutters
 * was passed over because it cuts into the part."). If every chain is set aside, the fewest
 * adjudicated cells wins (ties by today's rank) and the plan states it. `null` from the
 * adjudicator = not known: the chain is treated as clean and the plan says the check did not run;
 * no adjudicator at all = today's behaviour.
 *
 * The fixture is #1217's three-candidate shape (`pocket:t6+rest:t3` rank 1 by leftover,
 * `pocket:t6` then `pocket:t3` by time, 100,000 covered cells).
 */
import { describe, expect, it } from 'vitest';

import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import type { CamMove, RapidEstimate, ToolpathIR } from '@/engine/cnc/cam/ir';
import {
  chooseSequence,
  type SequenceDemand,
  type SequenceStep,
} from '@/engine/cnc/cam/model/sequence';
import { cutIntoAllSentence, goalCoverageCounts } from '@/engine/cnc/cam/model/plan';
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

/** The injected adjudicator's answer for one chain: null = not known. */
type Verdict = { adjudicatedCells: number; maxMm: number; areaMm2: number } | null;

interface Case {
  /** Per chain: the adjudicator's answer; absent = clean, 'null' = not known. */
  verdicts?: Record<string, Verdict | 'null'>;
  /** The leftover equivalence, when the fixture needs it. */
  leftoverPct?: number;
  house?: Tool[];
  allowPrimary?: (key: string) => boolean;
  /** Absent → no adjudicator supplied (today's behaviour). */
  withAdjudicate?: boolean;
}

const choose = (c: Case) => {
  const calls: string[] = [];
  const verdictFor = (steps: readonly SequenceStep[]): Verdict => {
    const chain = sig(steps);
    calls.push(chain);
    const v = c.verdicts?.[chain];
    if (v === 'null') return null;
    return v ?? { adjudicatedCells: 0, maxMm: 0, areaMm2: 0 };
  };
  const choice = chooseSequence(DEMAND, { house: c.house ?? HOUSE, catalogue: [] }, {
    rapid: RAPID,
    toolChangeSeconds: 91.4,
    planStep: (step) => ir(step.cutter.tool, WORK[`${step.kind}:${step.cutter.key}`] ?? 50),
    coverage: (steps) => ({
      leftoverCells: sig(steps).includes('rest:') ? 700 : 1000,
      coveredCells: 100000,
      cellAreaMm2: 0.01,
    }),
    ...(c.leftoverPct === undefined ? {} : { leftoverEquivalencePct: c.leftoverPct }),
    ...(c.allowPrimary === undefined ? {} : { allowPrimary: c.allowPrimary }),
    ...(c.withAdjudicate === false ? {} : { adjudicate: verdictFor }),
  });
  return { choice, calls };
};

describe('#1252 the rank is today’s: no cut-into key', () => {
  it('the picks are the pre-#1252 ones', () => {
    expect(sig(choose({}).choice.steps)).toBe('pocket:t6+rest:t3');
    expect(sig(choose({ leftoverPct: 0.5 }).choice.steps)).toBe('pocket:t6');
  });

  it('no adjudicator supplied: the choice and the statements are exactly today’s', () => {
    const { choice, calls } = choose({ withAdjudicate: false });
    expect(sig(choice.steps)).toBe('pocket:t6+rest:t3');
    expect(calls).toEqual([]);
    expect(choice.cutInto).toBeUndefined();
    expect(choice.cutIntoNotRun).toBeUndefined();
    expect(choice.passedOver).toBeUndefined();
  });
});

describe('#1252 the adjudication search', () => {
  it('a clean first-ranked chain is chosen with one call', () => {
    const { choice, calls } = choose({});
    expect(sig(choice.steps)).toBe('pocket:t6+rest:t3');
    expect(calls).toEqual(['pocket:t6+rest:t3']);
    expect(choice.passedOver).toBeUndefined();
    expect(choice.cutInto).toBeUndefined();
  });

  it('a gouging first-ranked chain is set aside and the clean next one chosen, with the note', () => {
    const { choice, calls } = choose({
      verdicts: { 'pocket:t6+rest:t3': { adjudicatedCells: 5000, maxMm: 2.5, areaMm2: 50 } },
    });
    expect(sig(choice.steps)).toBe('pocket:t6');
    expect(calls).toEqual(['pocket:t6+rest:t3', 'pocket:t6']);
    expect(choice.passedOver).toBe(1);
    expect(choice.cutInto).toBeUndefined();
  });

  it('every chain gouging: the fewest adjudicated cells wins (ties by today’s rank) and the plan states it', () => {
    const { choice, calls } = choose({
      verdicts: {
        'pocket:t6+rest:t3': { adjudicatedCells: 50, maxMm: 1.5, areaMm2: 0.5 },
        'pocket:t6': { adjudicatedCells: 20, maxMm: 2.5, areaMm2: 0.2 },
        'pocket:t3': { adjudicatedCells: 80, maxMm: 3.0, areaMm2: 0.8 },
      },
    });
    expect(sig(choice.steps)).toBe('pocket:t6');
    expect(calls.length).toBe(3);
    expect(choice.cutInto).toEqual({ cells: 20, maxMm: 2.5, areaMm2: 0.2 });
    expect(choice.passedOver).toBeUndefined();
    expect(cutIntoAllSentence(choice.cutInto!)).toBe(
      'Every set of cutters cuts into the part; the one chosen cuts 0.2 mm² more than the model allows, up to 2.5 mm.',
    );
  });

  it('the adjudicator returning null: the chain is treated as clean and the plan says the check did not run', () => {
    const { choice, calls } = choose({ verdicts: { 'pocket:t6+rest:t3': 'null' } });
    expect(sig(choice.steps)).toBe('pocket:t6+rest:t3');
    expect(calls).toEqual(['pocket:t6+rest:t3']);
    expect(choice.cutIntoNotRun).toBe(true);
    expect(choice.cutInto).toBeUndefined();
    expect(choice.passedOver).toBeUndefined();
  });
});

describe('#1252 the clamp card’s gouging chain (gate 1)', () => {
  it('the gouging chain ranks first (least leftover), is asked, and loses to the clean chain', () => {
    // The clamp card's numbers, at the rank: the gouging-class chain (raw 8,568, the V floor's
    // cells at 4.0 mm) leaves the least leftover, so today's rank puts it first — the same shape
    // #1242's shortlist produced. The check is asked of it, sets it aside, and the clean chain
    // (adjudicated 0) is chosen. (With the shortlist's own filter the ⌀6 primary is dropped
    // entirely — `allowPrimary` — and the clean ⌀3.175 chain is the only candidate; both ends are
    // covered by the search's contract.)
    const { choice, calls } = choose({
      verdicts: {
        'pocket:t6+rest:t3': { adjudicatedCells: 8568, maxMm: 4.0, areaMm2: 85.68 },
        'pocket:t6': { adjudicatedCells: 0, maxMm: 0, areaMm2: 0 },
      },
    });
    expect(sig(choice.steps)).toBe('pocket:t6');
    expect(calls).toEqual(['pocket:t6+rest:t3', 'pocket:t6']);
    expect(choice.passedOver).toBe(1);
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
    const bands = { leftoverBandMm: 0.1, tallMm: 1 };
    const atRecommended = goalCoverageCounts(goal, stamp, bands);
    expect(atRecommended.leftoverCells).toBe(0);
    expect(atRecommended.coveredCells).toBe(20);
    expect(atRecommended.cellAreaMm2).toBe(0.25);
  });
});

describe('#1252 the settings', () => {
  it('both cut-into settings are gone: nothing registered for them', () => {
    expect(() => readDefault(null, 'plan.cutIntoFloorMm')).toThrow();
    expect(() => readDefault(null, 'plan.cutIntoEquivalencePct')).toThrow();
  });
});
