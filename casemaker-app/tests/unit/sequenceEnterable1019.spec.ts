/**
 * #1019 — AN UN-ENTERABLE POCKET IS STATED, NOT A REFUSAL. RED-FIRST.
 *
 * `candidateSequences` treated "the primary roughs at least one demanded pocket" as a condition of
 * EXISTENCE, so a demand whose pockets are ALL un-enterable had no primary at all and
 * `planModelCam` refused the whole job. Measured on the flipMouldShell mould (#1005's SEQ_PROBE):
 * one pocket, 14.75 mm deep, 0.541 mm opening — narrower than every cutter — and the job refused
 * with "no cutter sequence can be planned for this demand". The fix partitions the pockets by
 * enterability before the search: the enterable ones are searched, every un-enterable one is stated
 * by its own number, and an empty enterable set (with no contour) is trivially satisfied.
 *
 * RED at the fold tip (`cand/1005-on-1006`, 8f1038ad4): `candidateSequences` returns [] for the
 * all-un-enterable demand (and `chooseSequence` throws the line-902 refusal). GREEN here.
 */
import { describe, expect, it } from 'vitest';

import { candidateSequences, chooseSequence, type CutterCandidates, type SequenceDemand } from '@/engine/cnc/cam/model/sequence';
import { flatEndMill } from '@/engine/cnc/tool';

const FLAT3175 = flatEndMill(3.175, { number: 1, id: 'flat-3.175', name: 'flat-3.175' });
const HOUSE: CutterCandidates = { house: [FLAT3175], catalogue: [] };

/** The measured demand shape: one pocket, a 0.541 mm opening, deeper than the flat can enter. */
const CAVITY: SequenceDemand = {
  features: [{ id: 'pocket-0', kind: 'pocket', minOpeningMm: 0.541, depthMm: 14.753 }],
};

describe('#1019 un-enterable pockets are stated, never a refusal', () => {
  it('a demand of one un-enterable pocket returns the empty chain with the pocket stated by name and number', () => {
    const candidates = candidateSequences(CAVITY, HOUSE);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.steps).toEqual([]);
    // The pocket is listed by ID (the plan's V-floor run walks the ids) AND by the statement
    // sentence, which names its opening (three decimals) and the set it was measured against.
    expect(candidates[0]!.unreachable).toContain('pocket-0');
    const stated = candidates[0]!.unreachable.find((u) => u.includes('0.541 mm opening'));
    expect(stated).toBeDefined();
    expect(stated).toContain('pocket-0');
    expect(stated).toContain('⌀3.175 flat');
  });

  it('chooseSequence does not throw for it — the demand is trivially satisfied, not refused', () => {
    const choice = chooseSequence(CAVITY, HOUSE, {
      rapid: { xyMmPerMin: 1200, zMmPerMin: 600, accelMmPerS2: 150, source: 'test fixture' },
      toolChangeSeconds: 0,
      planStep: () => {
        throw new Error('nothing to plan: the chain has no steps');
      },
    });
    expect(choice.steps).toEqual([]);
    expect(choice.unreachable.join('\n')).toContain('pocket-0');
  });

  it('an enterable pocket beside the narrow one is planned, the narrow one listed', () => {
    const demand: SequenceDemand = {
      features: [
        { id: 'pocket-0', kind: 'pocket', minOpeningMm: 0.541, depthMm: 14.753 },
        { id: 'pocket-1', kind: 'pocket', minOpeningMm: 10, depthMm: 10 },
      ],
    };
    const candidates = candidateSequences(demand, HOUSE);
    expect(candidates.length).toBeGreaterThan(0);
    // Every candidate searches the 10 mm pocket; the narrow one rides the same statement.
    expect(candidates.every((c) => c.unreachable.some((u) => u.includes('pocket-0') && u.includes('0.541')))).toBe(true);
    expect(candidates[0]!.steps.length).toBeGreaterThan(0);
    expect(candidates[0]!.steps[0]!.cutter.key).toBe('flat-3.175');
    // The 10 mm pocket is NOT in the un-enterable statements: it is enterable and planned.
    expect(candidates.every((c) => !c.unreachable.some((u) => u.startsWith('pocket-1:')))).toBe(true);
  });
});
