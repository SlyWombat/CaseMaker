/**
 * #1111 — THE BALL TIE'S PICK: THE REACH-MARGIN GATE, THEN THE KEY.
 *
 * 0f's narrowed ruling (#1111 comment 6729368477): the ball rank's tie requires the reach margin
 * (`fluteLength − deepest cut ≥ reachMarginMm`, the shop's `reach.marginMm`, recommendation 1.0 mm —
 * the Z-datum class) while any candidate passes; a remaining tie falls to the cutter KEY, and the
 * row says "by key, pending #1114" — WHICH cutter among equals is the maintainer's policy call
 * (#1114), not something this issue settles. The other same-diameter sites keep the pre-#1111
 * order and print the same row.
 *
 * RED before #1111: equal candidates kept the first measured, and the two doors' houses listed them
 * differently (the M1 tray's ⌀3.175 finish: a 10 mm-flute metal ball on the app, the 22 mm on the
 * CLI). At the tray's 9.613 mm cut the 10 mm ball's 0.387 mm margin is below the 1.0 mm gate.
 */
import { describe, expect, it } from 'vitest';

import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import {
  byKeyPendingNote,
  passesReachGate,
  pickAmongEquals,
  pickDecisionSentence,
  pickKeysFor,
  PICK_POLICY_ISSUE,
  reachGateWarning,
  REACH_MARGIN_FALLBACK_MM,
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

describe('#1111 — the reach-margin gate', () => {
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
    // Both fail; the key decides ('131…' before '132…') — stated as by-key, pending the policy.
    expect(winnerOf(candidates).key).toBe('131012313822');
  });
});

describe('#1111 — among passing candidates the key is the last resort, visibly provisional', () => {
  it('both pass at a shallow cut: the key decides, and the row says pending #1114', () => {
    const ten = pickKeysFor(BALL_10, ctx(4.7));
    const twentyTwo = pickKeysFor(BALL_22, ctx(4.7));
    expect(passesReachGate(ten, REACH_MARGIN_FALLBACK_MM)).toBe(true);
    expect(pickAmongEquals(twentyTwo, ten, REACH_MARGIN_FALLBACK_MM)).toBeGreaterThan(0); // '131…' < '132…'
    const sentence = pickDecisionSentence(BALL_22, twentyTwo, BALL_10, ten, REACH_MARGIN_FALLBACK_MM);
    expect(sentence).toContain(`by key, pending #${PICK_POLICY_ISSUE}`);
  });

  it('the same-diameter row says by key, pending #1114', () => {
    const note = byKeyPendingNote(FLAT_25, FLAT_12);
    expect(note).toContain('same diameter');
    expect(note).toContain(`by key, pending #${PICK_POLICY_ISSUE}`);
  });

  it('identical keys are identical', () => {
    const a = pickKeysFor(FLAT_25, ctx(9.6));
    expect(pickAmongEquals(a, { ...a }, REACH_MARGIN_FALLBACK_MM)).toBe(0);
  });
});
