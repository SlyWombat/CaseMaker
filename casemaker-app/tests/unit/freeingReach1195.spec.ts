// #1195 — THE FREEING CUT MAY ONLY BE TAKEN BY A STATED-REACHING FLUTE.
//
// A pocket's floor may be cut on an unknown reach: `coversFeature` lets an unstated flute "reach"
// (unknown is not excluded, and the op states the risk). The freeing contour must not be guessed —
// a cutter one flute-length short rubs its shank through the part on the last pass — so both ways
// a chain can take it (the cover link, usually the primary, and the chain's last cutter) require a
// STATED flute at least as long as the profile's depth.
//
// Found on Set B top at 1186-planner-time @ 079d3f75c: the primary was the ⌀3.175 × 25 (25 mm
// flute against a 25.3 mm profile), so the cover-link scan fell through to the chain's ⌀0.9 rest
// bit — whose flute is unstated, so `coversFeature` said it reached — and the plan posted a
// 1 h 51 min freeing contour on a 0.9 mm PCB router bit.
import { describe, expect, it } from 'vitest';

import { flatEndMill } from '@/engine/cnc/tool';
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

/** A big pocket, a slot only the small bit enters, and a 25.3 mm profile to free. */
const DEMAND: SequenceDemand = {
  features: [
    { id: 'big', kind: 'pocket', cornerRadiusMm: 1.5, minOpeningMm: 8, depthMm: 5 },
    { id: 'slot', kind: 'pocket', cornerRadiusMm: 0.4, minOpeningMm: 1.0, depthMm: 2 },
    { id: 'outline', kind: 'contour', depthMm: 25.3 },
  ],
  scallopMm: 0.05,
};

const SHORT = flatEndMill(3.175, { id: 'short', name: '3.175 flat · 25 mm flute', number: 1, fluteLength: 25 });
const LONG = flatEndMill(3.175, { id: 'long', name: '3.175 flat · 42 mm flute', number: 2, fluteLength: 42 });
const TINY = flatEndMill(0.9, { id: 'tiny', name: '0.9 flat · unstated flute', number: 3, fluteLength: null });

function ir(tool: ToolpathIR['tool'], moves: number): ToolpathIR {
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

/** The stand-in prices: the SHORT chain is deliberately the cheaper one. */
const WORK: Record<string, number> = {
  'pocket:short': 50,
  'pocket:long': 500,
  'rest:tiny': 5,
  'contour:short': 40,
  'contour:long': 60,
  'contour:tiny': 10,
};

function opts(over: Partial<SequenceOptions> = {}): SequenceOptions {
  const standIn = (step: SequenceStep): ToolpathIR =>
    ir(step.cutter.tool, Math.max(1, Math.round((WORK[`${step.kind}:${step.cutter.key}`] ?? 50) / 10)));
  return { rapid: RAPID, toolChangeSeconds: 91.4, planStep: standIn, ...over };
}

describe('#1195 — the freeing cut needs a stated reaching flute', () => {
  it('an unstated-flute rest bit never takes the freeing contour', () => {
    const choice = chooseSequence(DEMAND, { house: [SHORT, LONG, TINY], catalogue: [] }, opts());
    const contour = choice.steps.find((s) => s.kind === 'contour');
    expect(contour, 'the part must be freed').toBeDefined();
    expect(contour!.cutter.key, 'the ⌀0.9 with an unstated flute took the freeing cut').not.toBe('tiny');
  });

  it('the chosen freeing cutter states a flute at least as long as the profile', () => {
    const choice = chooseSequence(DEMAND, { house: [SHORT, LONG, TINY], catalogue: [] }, opts());
    const contour = choice.steps.find((s) => s.kind === 'contour')!;
    const flute = contour.cutter.tool.fluteLength;
    expect(flute, `the freeing cutter ${contour.cutter.key} states no flute`).not.toBeNull();
    expect(flute!).toBeGreaterThanOrEqual(25.3);
  });

  it('a cheaper chain that cannot free the part loses to one that can', () => {
    // The SHORT chain is cheaper on the pockets by design; it has no stated-reaching link for the
    // contour, so it posts no freeing step and is ranked behind the LONG chain that frees.
    const choice = chooseSequence(DEMAND, { house: [SHORT, LONG, TINY], catalogue: [] }, opts());
    expect(choice.steps.some((s) => s.kind === 'contour' && s.cutter.key === 'long')).toBe(true);
  });

  it('an unstated flute may still take a pocket floor (only the freeing cut is strict)', () => {
    // Same demand without the contour: the tiny bit remains a legitimate rest link.
    const noContour: SequenceDemand = { features: DEMAND.features.filter((f) => f.kind !== 'contour'), scallopMm: 0.05 };
    const candidates = candidateSequences(noContour, { house: [SHORT, LONG, TINY], catalogue: [] });
    expect(candidates.some((c) => c.steps.some((s) => s.kind === 'rest' && s.cutter.key === 'tiny'))).toBe(true);
  });
});

describe('#1195 — the refusal is named, and only when it must be', () => {
  it('no owned cutter with a stated flute reaches: the sentence says so and lists the unstated ones', () => {
    // Only the TINY (unstated) and a short stated flat exist — nothing can free a 25.3 mm profile.
    const short = flatEndMill(3.175, { id: 'short', name: '3.175 flat · 10 mm flute', number: 1, fluteLength: 10 });
    expect(() => chooseSequence(DEMAND, { house: [short, TINY], catalogue: [] }, opts()))
      .toThrow(/nothing can free this part: none of your cutters has a stated flute of 25\.3 mm or more — state a flute length on: 0\.9 flat · unstated flute/);
  });

  it('a USER-pinned cutter that cannot reach is refused, naming the cutter that does', () => {
    expect(() => chooseSequence(DEMAND, { house: [SHORT, LONG, TINY], catalogue: [], pinned: { contour: 'short' } }, opts()))
      .toThrow(/the chosen cutter 3\.175 flat · 25 mm flute cannot free this part: its flute is 25 mm against a 25\.3 mm profile — 3\.175 flat · 42 mm flute reaches it; choose that cutter, or state this one's flute length/);
  });

  it('a planner-chosen short cutter is NOT a pin: the pick takes the reaching cutter instead of refusing', () => {
    // No `pinned.contour` is how a planner-written tool arrives; the ×42 simply wins the chain.
    const choice = chooseSequence(DEMAND, { house: [SHORT, LONG, TINY], catalogue: [] }, opts());
    const contour = choice.steps.find((s) => s.kind === 'contour')!;
    expect(contour.cutter.key).toBe('long');
  });
});
