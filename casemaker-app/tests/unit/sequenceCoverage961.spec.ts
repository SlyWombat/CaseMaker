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
  it('the ⌀3.175 rest covers the 27 4.1–4.9 mm pockets; only the 16 below the house set are stated', () => {
    const choice = chooseSequence(DEMAND, HOUSE, opts());
    expect(choice.steps.some((s) => s.kind === 'rest' && s.cutter.key === 'flat-3.175')).toBe(true);
    expect(choice.steps[0]!.cutter.key).toBe('flat-6');
    for (const id of CUTTABLE_REST) expect(choice.unreachable).not.toContain(id);
    expect([...choice.unreachable].sort()).toEqual([...BELOW_HOUSE].sort());
    expect(CUTTABLE_REST).toHaveLength(27);
    expect(BELOW_HOUSE).toHaveLength(16);
  });

  it('price never outvotes coverage: an absurdly dear rest step still beats leaving the 27 uncut', () => {
    const choice = chooseSequence(
      DEMAND,
      HOUSE,
      opts((step) => standIn(step, step.kind === 'rest' ? 5000 : 10)),
    );
    expect(choice.steps.some((s) => s.kind === 'rest' && s.cutter.key === 'flat-3.175')).toBe(true);
    expect(choice.unreachable).toHaveLength(BELOW_HOUSE.length);
  });

  it('every candidate prices the same demand; the primary alone is the one that leaves cuttable pockets', () => {
    const candidates = candidateSequences(DEMAND, HOUSE);
    const only6 = candidates.find((c) => c.steps.length === 1)!;
    const chain = candidates.find((c) => c.steps.some((s) => s.kind === 'rest'))!;
    expect(only6.unreachable).toHaveLength(43);
    expect(chain.unreachable).toHaveLength(16);
    // …and no chain ever shrinks the primary to the smaller flat, however cheap that is: the
    // chain is the largest flat + rest, the ruling's own shape.
    for (const c of candidates) expect(c.steps[0]!.cutter.key).toBe('flat-6');
    expect(only6.leftBehind).toBe(27);
    expect(chain.leftBehind).toBe(0);
  });
});
