// #961 — AN UNCUT CUTTABLE POCKET IS NOT A CHEAPER PLAN (red-first, E's organizer run on ec77465a).
//
// The organizer's demand has 63 floored pockets: 16 genuinely below the house set (0.68–1.11 mm,
// no house flat can enter), 27 that need 4.1–4.9 mm (the house ⌀3.175 fits), and 20 at 6 mm and
// up (the ⌀6 primary). The chain's rank called EVERY candidate incomplete because the 16 are
// unreachable by construction — so the complete-first rule tied, price picked the ⌀6 primary alone,
// and 43 pockets were left uncut (27 of them cuttable). The rank must count only pockets a cutter
// COULD have covered: `leftBehind`, zero for a chain that covers every cuttable one.
//
// The demand below is the organizer as `plan.ts` hands it over (`organizer-plan.json` at ec77465a,
// reproduced from Tool_Organizer_Z1-msfh3m77.step): [id, narrowest, depth below the stock top].
// The stand-in op plans a region only where the cutter physically enters it, so a ⌀6 step over the
// whole demand posts 20 pockets + the contour — the 21 ops E measured.

import { describe, expect, it } from 'vitest';

import { cuttingDiameter, flatEndMill } from '@/engine/cnc/tool';
import { type CamMove, type RapidEstimate, type ToolpathIR } from '@/engine/cnc/cam/ir';
import {
  candidateSequences,
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

// E's organizer demand (`organizer-plan.json`, ec77465a), every floored pocket.
const ORGANIZER_ROWS: readonly (readonly [string, number, number])[] = [
  ["pocket-52", 11.489, 22.8],
  ["pocket-53", 11.489, 22.8],
  ["pocket-54", 12.997, 22.8],
  ["pocket-55", 12.997, 22.8],
  ["pocket-56", 12.997, 22.8],
  ["pocket-57", 12.997, 22.8],
  ["pocket-58", 12.997, 22.8],
  ["pocket-59", 12.997, 22.8],
  ["pocket-60", 12.997, 22.8],
  ["pocket-61", 12.997, 22.8],
  ["pocket-62", 9.985, 22.8],
  ["pocket-50", 6.188, 14.8],
  ["pocket-51", 6.188, 14.8],
  ["pocket-35", 4.886, 10.8],
  ["pocket-36", 4.886, 10.8],
  ["pocket-37", 4.886, 10.8],
  ["pocket-38", 4.886, 10.8],
  ["pocket-39", 4.886, 10.8],
  ["pocket-40", 4.886, 10.8],
  ["pocket-41", 4.886, 10.8],
  ["pocket-42", 4.886, 10.8],
  ["pocket-43", 4.886, 10.8],
  ["pocket-44", 4.886, 10.8],
  ["pocket-45", 4.886, 10.8],
  ["pocket-46", 4.886, 10.8],
  ["pocket-47", 4.886, 10.8],
  ["pocket-48", 4.886, 10.8],
  ["pocket-49", 4.886, 10.8],
  ["pocket-34", 1.105, 8.8],
  ["pocket-29", 4.136, 6.8],
  ["pocket-30", 4.136, 6.8],
  ["pocket-31", 4.136, 6.8],
  ["pocket-32", 4.136, 6.8],
  ["pocket-33", 4.136, 6.8],
  ["pocket-20", 4.886, 5.8],
  ["pocket-21", 4.886, 5.8],
  ["pocket-22", 4.886, 5.8],
  ["pocket-23", 4.886, 5.8],
  ["pocket-17", 4.087, 4.8],
  ["pocket-18", 4.087, 4.8],
  ["pocket-19", 4.087, 4.8],
  ["pocket-15", 28.549, 3.8],
  ["pocket-24", 12.034, 5.8],
  ["pocket-25", 12.034, 5.8],
  ["pocket-26", 12.034, 5.8],
  ["pocket-16", 21.376, 3.8],
  ["pocket-27", 12.234, 5.8],
  ["pocket-28", 12.234, 5.8],
  ["pocket-0", 0.915, 1.4],
  ["pocket-1", 0.822, 1.4],
  ["pocket-2", 0.847, 1.4],
  ["pocket-3", 0.86, 1.4],
  ["pocket-4", 0.932, 1.4],
  ["pocket-5", 0.72, 1.4],
  ["pocket-6", 0.739, 1.4],
  ["pocket-7", 0.779, 1.4],
  ["pocket-8", 0.787, 1.4],
  ["pocket-9", 0.843, 1.4],
  ["pocket-10", 0.746, 1.4],
  ["pocket-11", 0.713, 1.4],
  ["pocket-12", 0.713, 1.4],
  ["pocket-13", 0.748, 1.4],
  ["pocket-14", 0.677, 1.4],
];

const CONTOUR_DEPTH_MM = 26.8;

const DEMAND: SequenceDemand = {
  features: [
    ...ORGANIZER_ROWS.map(([id, narrowest, depthMm]) => ({
      id,
      kind: 'pocket' as const,
      minOpeningMm: narrowest,
      cornerRadiusMm: narrowest / 2,
      depthMm,
    })),
    { id: 'contour', kind: 'contour' as const, depthMm: CONTOUR_DEPTH_MM },
  ],
};

const NARROWEST = new Map(ORGANIZER_ROWS.map(([id, narrowest]) => [id, narrowest]));

/** The 16 pockets no house flat can enter — the part's own limitation, stated, not cut. */
const BELOW_HOUSE = ORGANIZER_ROWS.filter(([, narrowest]) => narrowest < 3.175 - 1e-9).map(([id]) => id);
/** The 27 the ⌀3.175 fits once the ⌀6 primary has done what it can. */
const CUTTABLE_REST = ORGANIZER_ROWS.filter(([, narrowest]) => narrowest >= 3.175 - 1e-9 && narrowest < 6 - 1e-9).map(([id]) => id);

const FLAT6 = flatEndMill(6, { number: 1, id: 'flat-6', name: 'flat-6' });
const FLAT3175 = flatEndMill(3.175, { number: 2, id: 'flat-3.175', name: 'flat-3.175' });
const HOUSE: CutterCandidates = { house: [FLAT6, FLAT3175], catalogue: [] };

function ir(tool: SequenceStep['cutter']['tool'], moves: number): ToolpathIR {
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

/** plan.ts's own behaviour after ec77465a: a region the op cannot cut is dropped, not fatal; a
 *  step with nothing left to post is null. Entry is the physical test (opening ≥ diameter). */
function standIn(step: SequenceStep, movesPerRegion = 10): ToolpathIR | null {
  const d = cuttingDiameter(step.cutter.tool) ?? 0;
  let planned = 0;
  for (const id of step.regionIds) {
    if (id === 'contour' || (NARROWEST.get(id) ?? 0) >= d - 1e-9) planned++;
  }
  return planned === 0 ? null : ir(step.cutter.tool, planned * movesPerRegion);
}

function opts(planStep: SequenceOptions['planStep'] = (s) => standIn(s)): SequenceOptions {
  return { rapid: RAPID, toolChangeSeconds: TOOL_CHANGE_SECONDS, planStep };
}

describe('#961 the organizer demand: cover what a house cutter can cut', () => {
  it('the 27 4.1–4.9 mm pockets are covered; only the 16 below the house set are stated', () => {
    // #1186 rule 1 RE-PIN: the same coverage is now bought by the ⌀3.175 as the PRIMARY (it covers
    // the 27 and the rest of the part, at its own row), not by a rest step under a ⌀6 primary — the
    // cheaper COMPLETE chain wins. What this test has always judged is the coverage, and it stands.
    const choice = chooseSequence(DEMAND, HOUSE, opts());
    expect(choice.steps.some((s) => (s.kind === 'pocket' || s.kind === 'rest') && s.cutter.key === 'flat-3.175')).toBe(true);
    for (const id of CUTTABLE_REST) expect(choice.unreachable).not.toContain(id);
    // #1019 — an un-enterable pocket is stated as its own sentence ("id: 0.541 mm opening …"),
    // not a bare id: the ids named are still exactly the below-house set.
    const statedIds = [...new Set(choice.unreachable.map((u) => (u.includes(': ') ? u.slice(0, u.indexOf(': ')) : u)))].sort();
    expect(statedIds).toEqual([...BELOW_HOUSE].sort());
    expect(CUTTABLE_REST).toHaveLength(27);
    expect(BELOW_HOUSE).toHaveLength(16);
  });

  it('price never outvotes coverage: an absurdly dear small-flat pass still beats leaving the 27 uncut', () => {
    // #1186 rule 1 RE-PIN: the dear step is now the ⌀3.175 primary (there is no rest to be dear);
    // the rule this test prices is unchanged — coverage ranks before price, so the chain that
    // covers the 27 is chosen whatever its minutes.
    const choice = chooseSequence(
      DEMAND,
      HOUSE,
      opts((step) => standIn(step, step.cutter.key === 'flat-3.175' ? 5000 : 10)),
    );
    expect(choice.steps.some((s) => (s.kind === 'pocket' || s.kind === 'rest') && s.cutter.key === 'flat-3.175')).toBe(true);
    // #1019 — the ids ride beside their sentences: count the distinct pockets named.
    expect(new Set(choice.unreachable.map((u) => (u.includes(': ') ? u.slice(0, u.indexOf(': ')) : u))).size).toBe(BELOW_HOUSE.length);
  });

  it('every candidate prices the same demand; a ⌀6-only chain is the one that leaves cuttable pockets', () => {
    // #1186 rule 1 RE-PIN: both primaries are PROPOSED now (the field's "an ordering rule only
    // proposes"); the ⌀6-only chain still leaves the 27 cuttable, and the ⌀3.175-primary chain
    // covers them — that difference, not which chain is legal, is what this test has always judged.
    const candidates = candidateSequences(DEMAND, HOUSE);
    const only6 = candidates.find((c) => c.steps.every((s) => s.cutter.key === 'flat-6'))!;
    const chain = candidates.find((c) => c.steps.some((s) => s.cutter.key === 'flat-3.175'))!;
    // #1019 — ids and sentences both ride `unreachable`: compare the distinct pockets named.
    const distinct = (c: (typeof candidates)[number]): number =>
      new Set(c.unreachable.map((u) => (u.includes(': ') ? u.slice(0, u.indexOf(': ')) : u))).size;
    expect(distinct(only6)).toBe(43);
    expect(distinct(chain)).toBe(16);
    // #1186 rule 1: the smaller primary is a legal PROPOSAL (it was never priced before); the rank
    // decides on the total, never on the order of proposal.
    expect(candidates.some((c) => c.steps[0]!.cutter.key === 'flat-3.175')).toBe(true);
    expect(only6.leftBehind).toBe(27);
    expect(chain.leftBehind).toBe(0);
  });
});

describe('#961 the freeing cut is priced, not left as an unpriced return', () => {
  it('the contour is its own LAST step; an unstated flute means the last cutter cannot take it, so the return change is charged', () => {
    // #1186 rule 1 RE-PIN: the ⌀3.175 alone is now the cheapest chain, so this test prices its
    // cutting dear to keep the flat-6 primary + rest shape the mechanic is about. What it pins —
    // the free cut is its own step, and an unstated flute cannot take it — is unchanged.
    const choice = chooseSequence(DEMAND, HOUSE, opts((step) => standIn(step, step.cutter.key === 'flat-3.175' ? 50 : 10)));
    const last = choice.steps[choice.steps.length - 1]!;
    expect(last.kind).toBe('contour');
    expect(last.cutter.key).toBe('flat-6');
    expect(choice.freeing).toEqual({ cutterKey: 'flat-6', extraToolChange: true, lastCutterEligible: false });
    // The cycle carries the change back: flat-6 is loaded first, then again after the rest.
    const t6 = choice.cost.entries.find((e) => e.cutterKey === 'flat-6')!;
    const t3 = choice.cost.entries.find((e) => e.cutterKey === 'flat-3.175')!;
    expect(t6.toolChanges).toBe(1);
    expect(t3.toolChanges).toBe(1);
    expect(choice.cost.toolChanges).toBe(2);
  });

  it('a last cutter with a STATED flute long enough takes the profile when that is cheaper — no return change', () => {
    const longFlute = flatEndMill(3.175, { number: 2, id: 'flat-3.175', name: 'flat-3.175', fluteLength: 30 });
    const choice = chooseSequence(DEMAND, { house: [FLAT6, longFlute], catalogue: [] }, opts());
    expect(choice.freeing).toEqual({ cutterKey: 'flat-3.175', extraToolChange: false, lastCutterEligible: true });
    // #1186 rule 1 RE-PIN: the long-flute ⌀3.175 now cuts the whole demand as the primary, so
    // there is no change at all (it used to be the rest, one change behind the ⌀6).
    expect(choice.cost.toolChanges).toBe(0);
    expect(choice.steps[choice.steps.length - 1]!.kind).toBe('contour');
  });

  it('the profile may be dearer and still win: both options are priced, the cheaper TOTAL decides — no local threshold', () => {
    const longFlute = flatEndMill(3.175, { number: 2, id: 'flat-3.175', name: 'flat-3.175', fluteLength: 30 });
    const choice = chooseSequence(
      DEMAND,
      { house: [FLAT6, longFlute], catalogue: [] },
      // The ⌀3.175 profile costs 82 s against 22 s on the ⌀6 (more than 3×), but it saves a whole
      // change (91.4 s), so the total is cheaper and it takes the cut. plan v2's 3× stop rule is a
      // package-vs-vendor line on the reference card, not a per-profile gate here.
      opts((step) => standIn(step, step.kind === 'contour' && step.cutter.key === 'flat-3.175' ? 70 : 10)),
    );
    expect(choice.freeing).toEqual({ cutterKey: 'flat-3.175', extraToolChange: false, lastCutterEligible: true });
    expect(choice.cost.toolChanges).toBe(1);
    // The real comparison is between the two COMPLETE chains — both covering the 27 — which differ
    // in the freeing step: the dearer profile still wins on the total. #1186 rule 1 RE-PIN: the
    // complete chains are now the ⌀3.175-primary one and the flat-6 + rest one (leftBehind 0).
    const complete = choice.considered.filter((c) => c.cost !== null && c.leftBehind === 0);
    const cheapest = (key: string): number => Math.min(...complete
      .filter((c) => c.steps[c.steps.length - 1]!.cutterKey === key)
      .map((c) => c.cost!));
    expect(cheapest('flat-3.175')).toBeLessThan(cheapest('flat-6'));
    expect(cheapest('flat-3.175')).toBeCloseTo(choice.cost.totalSeconds, 6);
    // The primary alone is cheaper still, and still not chosen: 27 cuttable pockets are not a
    // discount.
    const incomplete = choice.considered.filter((c) => c.leftBehind > 0);
    if (incomplete.length > 0) {
      expect(Math.min(...incomplete.map((c) => c.cost ?? Infinity))).toBeLessThan(choice.cost.totalSeconds);
    }
  });
});

describe('#961 the simulated outcome: completeness is the surface left above the band', () => {
  // A demand the primary already covers physically: one 10 mm pocket. No geometric rest is needed,
  // so a ⌀3.175 link can only be a COVERAGE rest — offered, and the caller's simulation decides.
  const ONE_POCKET: SequenceDemand = {
    features: [{ id: 'pocket-15', kind: 'pocket', minOpeningMm: 10, cornerRadiusMm: 5, depthMm: 4 }],
  };

  it('a smaller flat the primary already covers is still offered as a coverage rest', () => {
    const candidates = candidateSequences(ONE_POCKET, HOUSE);
    const primaries = candidates.filter((c) => c.steps[0]!.cutter.key === 'flat-6');
    expect(primaries.some((c) => c.steps.some((s) => s.kind === 'rest' && s.cutter.key === 'flat-3.175'))).toBe(true);
    expect(primaries.some((c) => !c.steps.some((s) => s.kind === 'rest'))).toBe(true);
  });

  it('the rest earns its place only when its cost buys coverage back', () => {
    // The simulation: the ⌀3.175 rest leaves 50 of the goal cells above the band, the primary
    // alone leaves 500 — 4.5 mm² of surface bought. The rest is priced as any step; the rank
    // takes it when the price clears the line (a short pass buys 4.5 mm² for a change and a
    // little cutting: well over 0.01 mm²/s).
    const withCoverage = (leftoverRest: number, leftoverPrimary: number): SequenceOptions => ({
      ...opts((step) => standIn(step, step.kind === 'rest' ? 10 : 10)),
      coverage: (steps) => ({
        leftoverCells: steps.some((s) => s.kind === 'rest') ? leftoverRest : leftoverPrimary,
        coveredCells: 1000,
        cellAreaMm2: 0.01,
      }),
    });
    const bought = chooseSequence(ONE_POCKET, HOUSE, withCoverage(50, 500));
    expect(bought.steps.some((s) => s.kind === 'rest' && s.cutter.key === 'flat-3.175')).toBe(true);
    expect(bought.considered.find((c) => c.steps.some((s) => s.kind === 'rest'))!.leftoverCells).toBe(50);
    expect(bought.considered.find((c) => !c.steps.some((s) => s.kind === 'rest'))!.leftoverCells).toBe(500);

    // The rest buys nothing: the same cells are left with or without it, so the cheaper primary
    // wins and the considered list still prints both candidates' simulated outcome.
    const notBought = chooseSequence(ONE_POCKET, HOUSE, withCoverage(500, 500));
    expect(notBought.steps.some((s) => s.kind === 'rest')).toBe(false);
    expect(notBought.considered.every((c) => c.leftoverCells === 500)).toBe(true);
    expect(notBought.considered.find((c) => c.steps.some((s) => s.kind === 'rest'))!.cost!).toBeGreaterThan(notBought.cost.totalSeconds);
  });

  it('with no goal supplied the old order stands: leftBehind first, then price', () => {
    const choice = chooseSequence(ONE_POCKET, HOUSE, opts((step) => standIn(step, step.kind === 'rest' ? 5000 : 10)));
    expect(choice.steps.some((s) => s.kind === 'rest')).toBe(false);
    expect(choice.considered.every((c) => c.leftoverCells === null && c.coveredCells === null)).toBe(true);
  });
});

describe('#961 the coverage rest pays its way — full catalogue, no maxCutters', () => {
  // A house ⌀6 with a catalogue holding every smaller flat: with no budget the picker offers each
  // of them as a coverage rest, so only the PRICE may prune them. The first rest buys a real
  // surface; each further one shaves a cell and costs a long pass.
  const FLAT2 = flatEndMill(2, { number: 3, id: 'cat-2', name: 'cat-2' });
  const FLAT15 = flatEndMill(1.5, { number: 4, id: 'cat-1.5', name: 'cat-1.5' });
  const FLAT1 = flatEndMill(1, { number: 5, id: 'cat-1', name: 'cat-1' });
  const CATALOGUE_SET: CutterCandidates = { house: [FLAT6], catalogue: [FLAT3175, FLAT2, FLAT15, FLAT1] };
  // pocket-15 is 28.5 mm wide — every flat enters it, so every smaller one is a COVERAGE rest.
  const ONE_WIDE: SequenceDemand = {
    features: [{ id: 'pocket-15', kind: 'pocket', minOpeningMm: 28.5, cornerRadiusMm: 14, depthMm: 4 }],
  };

  const coverageOf = (steps: readonly SequenceStep[]): { leftoverCells: number; coveredCells: number; cellAreaMm2: number } => {
    const keys = steps.filter((s) => s.kind === 'rest').map((s) => s.cutter.key);
    let leftover = 300; // no rest at all
    if (keys.includes('flat-3.175')) leftover = 100; // 2 mm² bought for a short pass
    if (keys.includes('cat-2')) leftover = 99; // one more cell, for a long one
    if (keys.includes('cat-1.5')) leftover = 98;
    if (keys.includes('cat-1')) leftover = 97;
    return { leftoverCells: leftover, coveredCells: 2000, cellAreaMm2: 0.01 };
  };
  const optsFull = (): SequenceOptions => ({
    rapid: RAPID,
    toolChangeSeconds: TOOL_CHANGE_SECONDS,
    // The ⌀3.175 rest is short; every smaller catalogue flat costs a long pass.
    planStep: (step) => standIn(step, step.kind !== 'rest' ? 3 : step.cutter.key === 'flat-3.175' ? 3 : 300),
    coverage: coverageOf,
  });

  it('offers every smaller catalogue flat as a rest — the budget does not prune them, the price does', () => {
    const candidates = candidateSequences(ONE_WIDE, CATALOGUE_SET);
    for (const key of ['flat-3.175', 'cat-2', 'cat-1.5', 'cat-1']) {
      expect(candidates.some((c) => c.steps.some((s) => s.kind === 'rest' && s.cutter.key === key)), `${key} was never offered`).toBe(true);
    }
    const choice = chooseSequence(ONE_WIDE, CATALOGUE_SET, optsFull());
    // The rest that pays: 2 mm² for the short pass (0.5 mm²/s) clears the 0.01 mm²/s line.
    expect(choice.steps.some((s) => s.kind === 'rest' && s.cutter.key === 'flat-3.175')).toBe(true);
    // The ones that do not: one more cell each, for hundreds of seconds.
    for (const key of ['cat-2', 'cat-1.5', 'cat-1']) {
      expect(choice.steps.some((s) => s.kind === 'rest' && s.cutter.key === key), `${key} was chosen`).toBe(false);
    }
    // Every candidate still prints its simulated outcome and its price; the demoted ones say why.
    const withCat2 = choice.considered.find((c) => c.steps.some((s) => s.kind === 'rest' && s.cutterKey === 'cat-2'))!;
    expect(withCat2.leftoverCells).toBe(99);
    expect(withCat2.restPrice).not.toBeNull();
    expect(withCat2.restPrice!.mm2PerSecond).toBeLessThan(0.01);
    expect(withCat2.reason).toContain('below the 0.01 mm²/s price');
    const paying = choice.considered.find((c) => c.steps.some((s) => s.kind === 'rest' && s.cutterKey === 'flat-3.175') && c.rank === 1)!;
    expect(paying.restPrice!.mm2PerSecond).toBeGreaterThanOrEqual(0.01);
  });

  it('a rest that buys nothing is demoted even when it leaves fewer cells: the gain is against the chain without it', () => {
    // Every chain reports the SAME leftover: no surface is bought at all.
    const flat = () => ({ leftoverCells: 300, coveredCells: 2000, cellAreaMm2: 0.01 });
    const choice = chooseSequence(ONE_WIDE, CATALOGUE_SET, { ...optsFull(), coverage: flat });
    expect(choice.steps.some((s) => s.kind === 'rest')).toBe(false);
    const rest = choice.considered.find((c) => c.steps.some((s) => s.kind === 'rest' && s.cutterKey === 'flat-3.175'))!;
    expect(rest.restPrice!.gainMm2).toBe(0);
    expect(rest.reason).toContain('recovers no surface');
  });

  it('with no goal supplied there is no price to judge and the old order stands', () => {
    const choice = chooseSequence(ONE_WIDE, CATALOGUE_SET, { ...optsFull(), coverage: undefined });
    expect(choice.steps.some((s) => s.kind === 'rest')).toBe(false);
    expect(choice.considered.every((c) => c.restPrice === null)).toBe(true);
  });
});
