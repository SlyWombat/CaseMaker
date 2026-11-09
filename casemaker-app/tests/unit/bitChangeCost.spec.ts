// #1114 — THE BIT CHANGE IS PRICED, AND ITS PRICE DEPENDS ON THE PROGRAM BEFORE IT (red-first).
//
// The maintainer's decision (2026-11-09, on #1114): "Bit change time is variable. If the current job
// is more than 30 min, a bit change is exponentially longer than [after] a 5 minute job — people
// will walk away from the machine."
//
// The shop settings (recommendations, not constants):
//   attendedMinutes 5 · attendedChangeSeconds 120 · walkAwayMinutes 30 · returnMinutes 15
//
// While the preceding program is at most `attendedMinutes`, the operator is still there and the
// change costs `attendedChangeSeconds`. From `walkAwayMinutes` on they have left: `returnMinutes`
// on top. Between the two the cost rises on a smooth step (3t² − 2t³, t the position between the
// thresholds), which the sheet states.
//
// RED before #1114: `priceSequence` charged one flat `toolChange.seconds` per change regardless of
// what ran before it, so the 4-program plan (one change fewer) and the 5-program plan 13 minutes
// faster were compared on numbers that ignored where the operator was.
import { describe, expect, it } from 'vitest';

import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import { estimateCycleTerms, type CamMove, type RapidEstimate, type ToolpathIR } from '@/engine/cnc/cam/ir';
import {
  BIT_CHANGE_RECOMMENDED,
  bitChangePriceSeconds,
  bitChangeStanding,
  type BitChangeRule,
} from '@/engine/cnc/cam/model/bitChange';
import {
  priceSequence,
  type CandidateSequence,
  type SequenceStep,
} from '@/engine/cnc/cam/model/sequence';

const RULE: BitChangeRule = BIT_CHANGE_RECOMMENDED;
const RAPID: RapidEstimate = { xyMmPerMin: 1200, zMmPerMin: 600, accelMmPerS2: 150, spinUpSeconds: 12, source: 'test' };

const flat = (id: string, fluteLength: number): Tool =>
  flatEndMill(3.175, { id, name: `${id} flat`, number: 1, fluteLength });

function step(tool: Tool, kind: SequenceStep['kind'] = 'pocket'): SequenceStep {
  return {
    kind,
    role: 'flat',
    cutter: { key: `inv:${tool.id}`, tool, house: true, pinned: false, feeds: 'row' },
    regionIds: ['r'],
  };
}

/** A program of about `seconds`: feed moves 10 mm apart at F600 (1 s each), plus spin-up. */
function irOf(tool: Tool, seconds: number): ToolpathIR {
  const moves: CamMove[] = [{ kind: 'feed', x: 0, y: 0, z: -1, f: 600 }];
  const count = Math.max(1, Math.round(seconds));
  for (let i = 1; i <= count; i++) moves.push({ kind: 'feed', x: i * 10, y: 0, z: -1, f: 600 });
  return {
    frame: 'flat',
    tool,
    toolNumber: 1,
    spindleRpm: 12000,
    air: true,
    safeZ: 5,
    hopZ: 2,
    operations: [{ number: 1, name: tool.name, labelId: 'op', depth: 1, moves, estimatedSeconds: 0 }],
  };
}

/** The candidate's steps plan to programs of the durations asked for, in order. */
function sequenceOf(durations: { tool: Tool; seconds: number }[]): CandidateSequence {
  return {
    steps: durations.map((d) => step(d.tool)),
    unreachable: [],
    leftBehind: 0,
  };
}

const priceOf = (durations: { tool: Tool; seconds: number }[]): number => {
  const byTool = new Map(durations.map((d) => [d.tool, d.seconds]));
  const priced = priceSequence(sequenceOf(durations), {
    rapid: RAPID,
    planStep: (s) => irOf(s.cutter.tool, byTool.get(s.cutter.tool) ?? 10),
    bitChange: RULE,
  });
  expect(priced).not.toBeNull();
  return priced!.cost.totalSeconds;
};

describe('#1114 — the change is priced from the program before it', () => {
  it('a change after a 4-minute program costs the attended 120 s', () => {
    expect(bitChangePriceSeconds(RULE, 4 * 60)).toBe(120);
    expect(bitChangeStanding(RULE, 4 * 60)).toBe('attended');
  });

  it('a change after a 40-minute program costs 15 min on top — 1 020 s', () => {
    expect(bitChangePriceSeconds(RULE, 40 * 60)).toBe(1020);
    expect(bitChangeStanding(RULE, 40 * 60)).toBe('walk-away');
  });

  it('a change after 15 minutes is strictly between the two, and rising', () => {
    const at15 = bitChangePriceSeconds(RULE, 15 * 60);
    expect(at15).toBeGreaterThan(120);
    expect(at15).toBeLessThan(1020);
    expect(bitChangeStanding(RULE, 15 * 60)).toBe('rising');
    // Monotonic through the rising band: a longer program never prices a change lower.
    let previous = 120;
    for (let minutes = 5; minutes <= 30; minutes++) {
      const price = bitChangePriceSeconds(RULE, minutes * 60);
      expect(price, `${minutes} min`).toBeGreaterThanOrEqual(previous);
      previous = price;
    }
  });

  it('a flat rule (no duration dependence) reproduces the pre-#1114 allowance exactly', () => {
    const flatRule: BitChangeRule = { attendedMinutes: 0, attendedChangeSeconds: 91.4, walkAwayMinutes: 0, returnMinutes: 0 };
    expect(bitChangePriceSeconds(flatRule, 0)).toBe(91.4);
    expect(bitChangePriceSeconds(flatRule, 60 * 60)).toBe(91.4);
  });
});

describe('#1114 — plans compete on the priced cycle', () => {
  it('two plans identical but for one change after a 35-minute program differ by its price', () => {
    const one = flat('one', 20);
    const two = flat('two', 20);
    const withChange = priceOf([
      { tool: one, seconds: 35 * 60 },
      { tool: two, seconds: 60 },
    ]);
    const without = priceOf([{ tool: one, seconds: 35 * 60 }]);
    // The change after the 35-minute program is priced at the walk-away 1 020 s; the extra minute
    // of cutting is the only other difference. (The stand-in IR's own estimate includes spin-up.)
    const precedingSeconds = estimateCycleTerms(irOf(one, 35 * 60), RAPID).totalSeconds;
    expect(precedingSeconds).toBeGreaterThan(35 * 60);
    const expected = bitChangePriceSeconds(RULE, precedingSeconds) + estimateCycleTerms(irOf(two, 60), RAPID).totalSeconds;
    expect(withChange - without).toBeCloseTo(expected, 6);
  });

  it('the sheet carries the price and the preceding program', () => {
    const one = flat('one', 20);
    const two = flat('two', 20);
    const byTool = new Map([
      [one, 35 * 60],
      [two, 60],
    ]);
    const priced = priceSequence(sequenceOf([{ tool: one, seconds: 35 * 60 }, { tool: two, seconds: 60 }]), {
      rapid: RAPID,
      planStep: (s) => irOf(s.cutter.tool, byTool.get(s.cutter.tool) ?? 10),
      bitChange: RULE,
    })!;
    expect(priced.cost.changes).toHaveLength(1);
    const change = priced.cost.changes[0]!;
    expect(change.afterCutterKey).toBe('inv:one');
    expect(change.beforeCutterKey).toBe('inv:two');
    expect(change.afterSeconds).toBeCloseTo(estimateCycleTerms(irOf(one, 35 * 60), RAPID).totalSeconds, 6);
    expect(change.priceSeconds).toBe(1020);
  });
});

describe('#1114 — the tray bottom’s three measured plans, re-priced', () => {
  // The per-program cycles as the three run sheets printed them (2026-11-08/09, k3 shop, CLI):
  //   plan 1 pre-#1111 (5 programs): 2 h 8 m · 1 m 38 s · 13 m 46 s · 1 h 50 m · 56 m 40 s
  //   plan 2 canonical order (4):    2 h 21 m · 1 m 38 s · 1 h 50 m · 56 m 40 s
  //   plan 3 shortest-sufficient (5): 2 h 8 m · 1 m 38 s · 44 m 37 s · 1 h 29 m · 56 m 40 s
  const plans = {
    'plan 1 — pre-#1111 order': [7680, 98, 826, 6600, 3400],
    'plan 2 — canonical order (set B today)': [8460, 98, 6600, 3400],
    'plan 3 — shortest sufficient': [7680, 98, 2677, 5340, 3400],
  };
  const pricedCycle = (durations: readonly number[]): { cutting: number; changes: number; total: number } => {
    let changes = 0;
    for (let i = 1; i < durations.length; i++) changes += bitChangePriceSeconds(RULE, durations[i - 1]!);
    const cutting = durations.reduce((a, b) => a + b, 0);
    return { cutting, changes, total: cutting + changes };
  };

  it('prices each plan by its own program durations', () => {
    // Re-priced with the change priced from the program before it (the changes sit between the
    // printed programs, so each change follows the program before it in the list).
    const plan1 = pricedCycle(plans['plan 1 — pre-#1111 order']);
    expect(plan1.changes).toBe(1020 + 120 + bitChangePriceSeconds(RULE, 826) + 1020);
    const plan2 = pricedCycle(plans['plan 2 — canonical order (set B today)']);
    expect(plan2.changes).toBe(1020 + 120 + 1020);
    const plan3 = pricedCycle(plans['plan 3 — shortest sufficient']);
    expect(plan3.changes).toBe(1020 + 120 + 1020 + 1020);
  });

  it('names the winner: plan 2, one change fewer, at 20 718 s', () => {
    const totals = Object.entries(plans).map(([name, durations]) => ({ name, ...pricedCycle(durations) }));
    totals.sort((a, b) => a.total - b.total);
    expect(totals[0]!.name).toContain('plan 2');
    expect(totals[0]!.total).toBe(20718);
    expect(totals[0]!.changes).toBe(2160);
  });
});
