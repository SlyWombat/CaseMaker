/**
 * #1114 — WHICH CUTTER AMONG EQUALS: THE GATE, THE SHORTEST SUFFICIENT FLUTE, THEN THE KEY.
 *
 * The maintainer's decision (2026-11-09, on #1114, after #1111's three measured policies). Once
 * plans compete on the PRICED cycle, a remaining same-diameter tie is decided in one order:
 *
 *  1. the reach-margin gate — `fluteLength − deepest cut ≥ reach.marginMm` (recommendation 1.0 mm).
 *     A candidate below the gate loses while any candidate passes; no stated flute has margin 0.
 *  2. the shortest sufficient flute — the stiffest adequate tool, among candidates that PASS.
 *  3. the cutter key, lexical — the last resort.
 *
 * RED before #1114: the gate was followed immediately by the key, so the tray's 22 mm ball beat a
 * 10 mm one that reached just as well, and the rows said "by key, pending #1114".
 */
import { describe, expect, it } from 'vitest';

import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import type { CamMove, RapidEstimate, ToolpathIR } from '@/engine/cnc/cam/ir';
import {
  chooseSequence,
  type SequenceDemand,
  type SequenceStep,
  type SequenceOptions,
} from '@/engine/cnc/cam/model/sequence';
import {
  passesReachGate,
  pickAmongEquals,
  pickDecisionSentence,
  pickKeysFor,
  pickNote,
  REACH_MARGIN_FALLBACK_MM,
  reachGateWarning,
  type PickContext,
  type PickKeys,
} from '@/engine/cnc/cam/model/pickAmongEquals';

const tool = (id: string, name: string, flute: number | null): Tool => ({ ...flatEndMill(3.175, { id, name }), fluteLength: flute });
const ctx = (deepestMm: number): PickContext => ({ material: 'hardwood', deepestMm });

function winnerOf(candidates: readonly PickKeys[], min = REACH_MARGIN_FALLBACK_MM): PickKeys {
  return candidates.reduce((best, k) => (pickAmongEquals(k, best, min) > 0 ? k : best));
}

const BALL_10 = tool('132112313810', 'metal 10', 10);
const BALL_22 = tool('131012313822', 'plain 22', 22);
const FLAT_12 = tool('inv:kz-o-flute-m-3-175-12', '12 mm O-flute', 12);
const FLAT_25 = tool('inv:kz-o-flute-3-175-25', '25 mm O-flute', 25);

describe('#1114 — the reach-margin gate', () => {
  it('the tray’s ball pair at 9.613 → the 22: the 10 mm flute’s 0.387 mm fails the 1.0 gate', () => {
    const ten = pickKeysFor(BALL_10, ctx(9.613));
    const twentyTwo = pickKeysFor(BALL_22, ctx(9.613));
    expect(passesReachGate(ten, REACH_MARGIN_FALLBACK_MM)).toBe(false);
    expect(passesReachGate(twentyTwo, REACH_MARGIN_FALLBACK_MM)).toBe(true);
    expect(pickAmongEquals(twentyTwo, ten, REACH_MARGIN_FALLBACK_MM)).toBeGreaterThan(0);
    expect(pickAmongEquals(ten, twentyTwo, REACH_MARGIN_FALLBACK_MM)).toBeLessThan(0);
    const sentence = pickDecisionSentence(BALL_22, twentyTwo, BALL_10, ten, REACH_MARGIN_FALLBACK_MM, 'tie on leftover and cycle');
    expect(sentence).toContain('reach-margin gate');
    expect(sentence).toContain('0.39 mm');
  });

  it('a cutter with no stated flute has margin 0 and fails the gate', () => {
    const unstated = tool('u', 'unstated', null);
    const keys = pickKeysFor(unstated, ctx(3));
    expect(keys.margin).toBe(-3);
    expect(passesReachGate(keys, REACH_MARGIN_FALLBACK_MM)).toBe(false);
    expect(reachGateWarning(unstated, keys, REACH_MARGIN_FALLBACK_MM)).toContain('no candidate passes the reach-margin gate');
  });

  it('with every candidate below the gate, the key still orders them deterministically', () => {
    const deep = ctx(30);
    const candidates = [BALL_22, BALL_10].map((t) => pickKeysFor(t, deep));
    // Both fail; neither is "sufficient", so the flute is not a preference — the key decides.
    expect(winnerOf(candidates).key).toBe('131012313822');
  });
});

describe('#1114 — among sufficient candidates the shortest flute wins', () => {
  it('both pass at a shallow cut: the 10 mm flute beats the 22, and the row says why', () => {
    const ten = pickKeysFor(BALL_10, ctx(4.7));
    const twentyTwo = pickKeysFor(BALL_22, ctx(4.7));
    expect(passesReachGate(ten, REACH_MARGIN_FALLBACK_MM)).toBe(true);
    expect(passesReachGate(twentyTwo, REACH_MARGIN_FALLBACK_MM)).toBe(true);
    expect(pickAmongEquals(ten, twentyTwo, REACH_MARGIN_FALLBACK_MM)).toBeGreaterThan(0);
    const sentence = pickDecisionSentence(BALL_10, ten, BALL_22, twentyTwo, REACH_MARGIN_FALLBACK_MM);
    expect(sentence).toContain('shortest sufficient flute');
    expect(sentence).toContain('10 mm against 22 mm');
  });

  it('equal flutes fall to the key, and the row states the key', () => {
    const a = tool('131', 'a', 20);
    const b = tool('132', 'b', 20);
    const ka = pickKeysFor(a, ctx(5));
    const kb = pickKeysFor(b, ctx(5));
    expect(pickAmongEquals(ka, kb, REACH_MARGIN_FALLBACK_MM)).toBeGreaterThan(0);
    expect(pickDecisionSentence(a, ka, b, kb, REACH_MARGIN_FALLBACK_MM)).toContain('cutter key');
  });

  it('the same-diameter row names the shortest sufficient flute', () => {
    const note = pickNote(FLAT_12, FLAT_25, pickKeysFor(FLAT_12, ctx(9.6)), pickKeysFor(FLAT_25, ctx(9.6)), REACH_MARGIN_FALLBACK_MM);
    expect(note).toContain('same diameter');
    expect(note).toContain('shortest sufficient flute');
    expect(note).toContain('12 mm against 25 mm');
  });

  it('identical keys are identical', () => {
    const a = pickKeysFor(FLAT_25, ctx(9.6));
    expect(pickAmongEquals(a, { ...a }, REACH_MARGIN_FALLBACK_MM)).toBe(0);
  });

  it('#1114 — an equal-flute tie goes to the LARGER diameter (the stiffer adequate tool)', () => {
    // The tray bottom's gap (Manager's ruling, 2026-11-09): a ⌀2 × 12 and a ⌀3.175 × 12 flat both
    // pass the gate and their flutes are equal. The key alone picked the ⌀2 — less stiff AND slower
    // — and the plan spent 28 extra minutes for the same outcome. The diameter is the stiffness
    // the rule's own parenthetical names; the key is only the last resort.
    const small = { ...flatEndMill(2, { id: '111011203812', name: '2 mm O-flute' }), fluteLength: 12 };
    const big = { ...flatEndMill(3.175, { id: '112111313812', name: '3.175 mm O-flute' }), fluteLength: 12 };
    const ks = pickKeysFor(small, ctx(9.6));
    const kb = pickKeysFor(big, ctx(9.6));
    expect(passesReachGate(ks, REACH_MARGIN_FALLBACK_MM)).toBe(true);
    expect(passesReachGate(kb, REACH_MARGIN_FALLBACK_MM)).toBe(true);
    expect(ks.flute).toBe(kb.flute);
    expect(pickAmongEquals(kb, ks, REACH_MARGIN_FALLBACK_MM), 'the 3.175 wins the equal-flute tie').toBeGreaterThan(0);
    expect(pickAmongEquals(ks, kb, REACH_MARGIN_FALLBACK_MM)).toBeLessThan(0);
    expect(pickDecisionSentence(big, kb, small, ks, REACH_MARGIN_FALLBACK_MM)).toContain('larger diameter');
  });
});

describe('#1114 — the site’s own geometry still decides when the big flat cannot cut', () => {
  const RAPID: RapidEstimate = { xyMmPerMin: 1200, zMmPerMin: 600, accelMmPerS2: 150, spinUpSeconds: 12, source: 'test' };
  const big = flatEndMill(3.175, { id: 'big', name: '3.175 flat', number: 1, fluteLength: 20 });
  const small = flatEndMill(2, { id: 'small', name: '2 flat', number: 1, fluteLength: 12 });
  function ir(tool: Tool): ToolpathIR {
    const moves: CamMove[] = [
      { kind: 'feed', x: 0, y: 0, z: -1, f: 600 },
      { kind: 'feed', x: 10, y: 0, z: -1, f: 600 },
    ];
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
  const opts: SequenceOptions = {
    rapid: RAPID,
    toolChangeSeconds: 91.4,
    reachMarginMm: REACH_MARGIN_FALLBACK_MM,
    planStep: (step: SequenceStep) => ir(step.cutter.tool),
  };

  it('the 3.175 cannot enter a 2.5 mm slot (1 mm corner), so the 2 mm is chosen despite its smaller diameter', () => {
    const demand: SequenceDemand = {
      features: [{ id: 'slot', kind: 'pocket', minOpeningMm: 2.5, depthMm: 2, cornerRadiusMm: 1.0 }],
      scallopMm: 0.05,
    };
    const choice = chooseSequence(demand, { house: [big, small], catalogue: [] }, opts);
    expect(choice.steps[0]?.cutter.key).toBe('small');
  });
});
