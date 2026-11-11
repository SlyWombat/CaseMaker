// #1192 rule 2 — THE EXACT DOMINANCE PRUNE (the analyst's field, issue comment 6780932595).
//
// A candidate is dropped unpriced when a KEPT one has the same shape and the SAME FEED ROW (own,
// or the same borrowed numbers), at least as long a STATED reach and at least as large a diameter
// — on one row a larger cutter cannot cut slower — and covers every region the dropped one could.
// A larger cutter that cannot enter a narrow region does not dominate there, an unstated reach
// never dominates, and a different row never does. A dropped primary stays a rest/finish
// candidate, so this file asserts the PRIMARIES the candidates start from.
import { describe, expect, it } from 'vitest';

import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import type { CamMove, RapidEstimate, ToolpathIR } from '@/engine/cnc/cam/ir';
import {
  candidateSequences,
  chooseSequence,
  type CutterCandidates,
  type SequenceDemand,
  type SequenceOptions,
} from '@/engine/cnc/cam/model/sequence';

// A generous corner (radius 4) so the ⌀6 fits it: the plain pocket is a region both flats cover.
const POCKET: SequenceDemand['features'][number] = { id: 'pocket', kind: 'pocket', cornerRadiusMm: 4, minOpeningMm: 8, depthMm: 5 };
// A 4 mm slot: the ⌀3.175 enters it and the ⌀6 does not — the near-miss region.
const NARROW: SequenceDemand['features'][number] = { id: 'narrow', kind: 'pocket', cornerRadiusMm: 2, minOpeningMm: 4, depthMm: 1 };

const big = flatEndMill(6, { id: 'big', name: '⌀6 flat', number: 1, fluteLength: 30 });
const small = flatEndMill(3.175, { id: 'small', name: '⌀3.175 flat', number: 2, fluteLength: 30 });

const startsOf = (demand: SequenceDemand, house: typeof big[]): Set<string> =>
  new Set(candidateSequences(demand, { house, catalogue: [] }).map((c) => c.steps[0]?.cutter.key ?? 'none'));

describe('#1192 rule 2 — the exact dominance prune', () => {
  it('a candidate dominated on one row, by a larger cutter that covers every region it could, is dropped', () => {
    // Both state 30 mm of flute and run the same row (the caller gives no rowKey here, so the
    // feeds kind is the row); the ⌀6 enters and reaches the only pocket, so nothing keeps the
    // ⌀3.175 as a primary.
    // The caller resolves the row (plan.ts always does); both are on ONE row here.
    const starts = new Set(
      candidateSequences(
        { features: [POCKET], scallopMm: 0.05 },
        { house: [big, small], catalogue: [], rowKey: () => '1000:1:0.45' },
      ).map((c) => c.steps[0]?.cutter.key ?? 'none'),
    );
    expect(starts.has('big')).toBe(true);
    expect(starts.has('small'), 'the dominated ⌀3.175 was offered as a primary').toBe(false);
  });

  it('a near-miss is kept: the smaller cutter is the only one that enters a narrow region', () => {
    // The ⌀6 cannot enter the 2 mm opening, so it does not cover every region the ⌀3.175 can —
    // no dominance, and both remain primaries.
    const starts = startsOf({ features: [POCKET, NARROW], scallopMm: 0.05 }, [big, small]);
    expect(starts.has('big')).toBe(true);
    expect(starts.has('small')).toBe(true);
  });

  it('a different feed row is never dominated', () => {
    // The smaller cutter borrows a slower row: the numbers differ, so the two are not comparable
    // by the rule (a cheaper row on the smaller cutter can win).
    const starts = new Set(
      candidateSequences(
        { features: [POCKET], scallopMm: 0.05 },
        {
          house: [big, small],
          catalogue: [],
          rowKey: (tool) => (tool.id === 'small' ? '400:0.5:0.45' : '1000:1:0.45'),
        },
      ).map((c) => c.steps[0]?.cutter.key ?? 'none'),
    );
    expect(starts.has('small'), 'a slower-own-row sibling was pruned').toBe(true);
  });

  it('an unstated reach never dominates (unknown is not at least as long)', () => {
    const unknown = flatEndMill(6, { id: 'unknown', name: '⌀6 flat · unstated flute', number: 3, fluteLength: null });
    const starts = startsOf({ features: [POCKET], scallopMm: 0.05 }, [unknown, small]);
    expect(starts.has('small'), 'an unstated flute dominated a stated one').toBe(true);
  });

  it('two otherwise-identical cutters keep exactly one, deterministically by key', () => {
    const twin = flatEndMill(3.175, { id: 'small', name: '⌀3.175 flat (twin)', number: 4, fluteLength: 30 });
    const starts = startsOf({ features: [POCKET], scallopMm: 0.05 }, [small, twin]);
    expect(starts.size).toBe(1);
  });
});

const RAPID: RapidEstimate = { xyMmPerMin: 1200, zMmPerMin: 600, accelMmPerS2: 150, spinUpSeconds: 12, source: 'test' };

/** A feed row: the numbers the cutter really runs, which is what both stages price from. */
type Row = { feed: number; stepDown: number; stepOver: number };
const ROW_FAST: Row = { feed: 1000, stepDown: 1, stepOver: 0.45 };
const ROW_MID: Row = { feed: 400, stepDown: 0.5, stepOver: 0.45 };
const ROW_SLOW: Row = { feed: 200, stepDown: 0.4, stepOver: 0.3 };

/** The caller's row resolvers: one row per cutter id, the shape `plan.ts` supplies. */
function rows(byKey: Record<string, Row>): Pick<CutterCandidates, 'rowKey' | 'cutParams'> {
  const rowOf = (tool: Tool): Row => byKey[tool.id ?? tool.name] ?? ROW_FAST;
  return {
    rowKey: (tool: Tool) => `${rowOf(tool).feed}:${rowOf(tool).stepDown}:${rowOf(tool).stepOver}`,
    cutParams: (tool: Tool) => rowOf(tool),
  };
}

/** One feed move whose duration IS `seconds` at F600 (10 mm/s), so the real price follows the row. */
function timedIr(tool: Tool, seconds: number): ToolpathIR {
  const moves: CamMove[] = [
    { kind: 'feed', x: 0, y: 0, z: -1, f: 600 },
    { kind: 'feed', x: Math.max(1, seconds * 10), y: 0, z: -1, f: 600 },
  ];
  return { frame: 'flat', tool, toolNumber: 1, spindleRpm: 12000, air: true, safeZ: 5, hopZ: 2, operations: [{ number: 1, name: tool.name, labelId: 'op', depth: 1, moves, estimatedSeconds: 0 }] };
}

/**
 * A stand-in CAM whose every step lasts exactly the work the ESTIMATE charges it (its regions'
 * volume ÷ its row's removal rate). The conservatism check is then about the screen choosing the
 * right chains, not about a stand-in whose prices disagree with the estimate by construction.
 */
function screenOpts(demand: SequenceDemand, byKey: Record<string, Row>, over: Partial<SequenceOptions> = {}): SequenceOptions {
  const byId = new Map(demand.features.map((f) => [f.id, f] as const));
  return {
    rapid: RAPID,
    toolChangeSeconds: 91.4,
    planStep: (step) => {
      const row = byKey[step.cutter.key] ?? ROW_FAST;
      const mrr = row.feed * row.stepDown * row.stepOver;
      let volume = 0;
      for (const id of step.regionIds) {
        const f = byId.get(id);
        if (f !== undefined && f.areaMm2 !== undefined) volume += f.areaMm2 * Math.max(0, f.depthMm ?? 0);
      }
      return timedIr(step.cutter.tool, mrr > 0 ? (volume / mrr) * 60 : 0);
    },
    ...over,
  };
}

/**
 * Three slots a different flat is needed for: the ⌀6 enters only the wide one, the ⌀4 the wide
 * and the middle, the ⌀3.175 all three. Three primaries, no dominance drop (each smaller one
 * reaches a slot the larger cannot), and their chains differ in cutters and changes.
 */
const SCREEN_DEMAND: SequenceDemand = {
  features: [
    { id: 'wide', kind: 'pocket', cornerRadiusMm: 3, minOpeningMm: 10, depthMm: 2, areaMm2: 400 },
    { id: 'mid', kind: 'pocket', cornerRadiusMm: 2, minOpeningMm: 5, depthMm: 2, areaMm2: 300 },
    { id: 'tight', kind: 'pocket', cornerRadiusMm: 1.5, minOpeningMm: 3.5, depthMm: 2, areaMm2: 200 },
  ],
  scallopMm: 0.05,
};
const BIG6 = flatEndMill(6, { id: 'big6', name: '⌀6 flat · borrowed row', number: 1, fluteLength: 30 });
const MID4 = flatEndMill(4, { id: 'mid4', name: '⌀4 flat · borrowed row', number: 2, fluteLength: 30 });
const SMALL3 = flatEndMill(3.175, { id: 'small3', name: '⌀3.175 flat · own row', number: 3, fluteLength: 30 });
const SCREEN_HOUSE = [BIG6, MID4, SMALL3];
/** BIG is the incumbent (largest) and by far the slowest row; the ⌀3.175 on its own row is fastest. */
const SCREEN_ROWS: Record<string, Row> = { big6: ROW_SLOW, mid4: ROW_MID, small3: ROW_FAST };

describe('#1192 rule 3 — the two-stage price', () => {
  it('prices at most K by estimate (+ the incumbent chains) and COUNTS the rest', () => {
    const ticks: [number, number][] = [];
    const choice = chooseSequence(
      SCREEN_DEMAND,
      { house: SCREEN_HOUSE, catalogue: [], ...rows(SCREEN_ROWS) },
      screenOpts(SCREEN_DEMAND, SCREEN_ROWS, { topK: 1, marginPct: 0, onCandidate: (i, total) => ticks.push([i, total]) }),
    );
    expect(choice.screen).toBeDefined();
    const screen = choice.screen!;
    expect(screen.estimated).toBe(6);
    expect(screen.priced).toBeLessThan(screen.estimated);
    // The top K (the ⌀3.175's one chain) and ALL three of the ⌀6 incumbent's chains are priced.
    expect(screen.topK).toBe(1);
    expect(screen.incumbentChains).toBe(3);
    expect(screen.incumbentPriced).toBe(true);
    expect(screen.priced).toBe(4);
    expect(screen.unpriced).toBe(2);
    expect(screen.othersSlowerPct).not.toBeNull();
    // A screened-out row is STATED as such, never as a planning failure.
    const screenedOut = choice.considered.filter((c) => c.cost === null && c.reason.includes('outside the proposal screen'));
    expect(screenedOut).toHaveLength(2);
    // PROGRESS: one tick per PRICED chain, numbered i of k — never one per estimate.
    expect(ticks).toEqual([[0, 4], [1, 4], [2, 4], [3, 4]]);
  });

  it('the margin admits a further candidate past K, up to the hard 2 × K count', () => {
    const args: [SequenceDemand, CutterCandidates] = [SCREEN_DEMAND, { house: SCREEN_HOUSE, catalogue: [], ...rows(SCREEN_ROWS) }];
    const tight = chooseSequence(...args, screenOpts(SCREEN_DEMAND, SCREEN_ROWS, { topK: 1, marginPct: 0 }));
    const wide = chooseSequence(...args, screenOpts(SCREEN_DEMAND, SCREEN_ROWS, { topK: 1, marginPct: 1000 }));
    const capped = chooseSequence(...args, screenOpts(SCREEN_DEMAND, SCREEN_ROWS, { topK: 1, marginPct: 100000 }));
    expect(tight.screen!.withinMargin).toBe(0);
    expect(wide.screen!.withinMargin).toBe(1);
    expect(wide.screen!.priced).toBeGreaterThan(tight.screen!.priced);
    // The cap is a COUNT, not the margin: however wide the margin, only 2 × K are admitted this way.
    expect(capped.screen!.withinMargin).toBe(1);
  });

  it('no registry numbers ⇒ the screen does not run: every candidate is priced as before', () => {
    const choice = chooseSequence(
      SCREEN_DEMAND,
      { house: SCREEN_HOUSE, catalogue: [], ...rows(SCREEN_ROWS) },
      screenOpts(SCREEN_DEMAND, SCREEN_ROWS),
    );
    expect(choice.screen).toBeUndefined();
    expect(choice.considered.every((c) => c.cost !== null)).toBe(true);
  });

  it('screen OFF prices every candidate (the conservatism check’s OFF side)', () => {
    const off = chooseSequence(
      SCREEN_DEMAND,
      { house: SCREEN_HOUSE, catalogue: [], ...rows(SCREEN_ROWS) },
      screenOpts(SCREEN_DEMAND, SCREEN_ROWS, { screen: false, topK: 1, marginPct: 0 }),
    );
    expect(off.screen).toBeUndefined();
    expect(off.considered.every((c) => c.cost !== null)).toBe(true);
  });

  it('CONSERVATISM: the winner is the same with the screen ON and OFF', () => {
    const args: [SequenceDemand, CutterCandidates] = [SCREEN_DEMAND, { house: SCREEN_HOUSE, catalogue: [], ...rows(SCREEN_ROWS) }];
    const on = chooseSequence(...args, screenOpts(SCREEN_DEMAND, SCREEN_ROWS, { topK: 1, marginPct: 0 }));
    const off = chooseSequence(...args, screenOpts(SCREEN_DEMAND, SCREEN_ROWS, { screen: false }));
    expect(on.steps.map((s) => `${s.kind}:${s.cutter.key}`)).toEqual(off.steps.map((s) => `${s.kind}:${s.cutter.key}`));
  });

  it('DETERMINISM: two runs rank, price and pick identically (byte-for-byte fields)', () => {
    const run = (): string => {
      const choice = chooseSequence(
        SCREEN_DEMAND,
        { house: SCREEN_HOUSE, catalogue: [], ...rows(SCREEN_ROWS) },
        screenOpts(SCREEN_DEMAND, SCREEN_ROWS, { topK: 1, marginPct: 25 }),
      );
      return JSON.stringify({
        steps: choice.steps.map((s) => `${s.kind}:${s.cutter.key}:${s.regionIds.join(',')}`),
        cost: choice.cost,
        considered: choice.considered,
        screen: choice.screen,
        unreachable: choice.unreachable,
      });
    };
    expect(run()).toBe(run());
  });
});

describe('#1192 rule 3 — the borrowed-row pair (red-first)', () => {
  const ONE_SLOT: SequenceDemand = {
    features: [{ id: 'slot', kind: 'pocket', cornerRadiusMm: 3, minOpeningMm: 10, depthMm: 2, areaMm2: 400 }],
    scallopMm: 0.05,
  };
  const LARGE = flatEndMill(6, { id: 'large', name: '⌀6 flat', number: 1, fluteLength: 30 });
  const SMALL = flatEndMill(3.175, { id: 'small', name: '⌀3.175 flat', number: 2, fluteLength: 30 });
  const house = [LARGE, SMALL];

  it('the large cutter on a slow borrowed row: the small own-row cutter is priced and wins', () => {
    const byKey = { large: ROW_SLOW, small: ROW_FAST };
    const choice = chooseSequence(
      ONE_SLOT,
      { house, catalogue: [], ...rows(byKey) },
      screenOpts(ONE_SLOT, byKey, { topK: 1, marginPct: 0 }),
    );
    expect(choice.steps[0]?.cutter.key).toBe('small');
    // The incumbent (the largest) is priced even though its estimate is the worst, and it lost.
    expect(choice.screen!.incumbentPriced).toBe(true);
    expect(choice.screen!.incumbentWon).toBe(false);
  });

  it('flip the rows: the large cutter wins on its own fast row', () => {
    const byKey = { large: ROW_FAST, small: ROW_SLOW };
    const choice = chooseSequence(
      ONE_SLOT,
      { house, catalogue: [], ...rows(byKey) },
      screenOpts(ONE_SLOT, byKey, { topK: 1, marginPct: 0 }),
    );
    expect(choice.steps[0]?.cutter.key).toBe('large');
    expect(choice.screen!.incumbentWon).toBe(true);
  });
});
