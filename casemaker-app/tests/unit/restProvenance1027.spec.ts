/**
 * #1027 — EACH THRESHOLD KEEPS ITS OWN SOURCE.
 *
 * The two leftover-visibility thresholds are read from the location independently
 * (`readDefault` answers per key), so a shop can state one and fall back for the other. The
 * `goal-rest-uncut` sentence names each threshold's source when they differ, and one phrase when
 * they agree — never the depth's source for both (the #1023 nit).
 *
 * The ball clause (#1027's other half) is NOT built: with no catalogue ball measured the sentence
 * gives no size and says where one comes from — an action, not a bare absence ("The ball that
 * would take it is measured from the cutter catalogue — none is configured for this shop
 * (Manage → Tools)."). A pure per-point drop-cutter test cannot see a scallop, and on the
 * acceptance plate's 56-degree walls it rejects every radius; the honest removal-envelope measure
 * was ruled out for 1.0 (#1028, option 3).
 */
import { describe, expect, it } from 'vitest';

import { restStatementForPlan } from '@/engine/cnc/cam/model/plan';
import type { ModelPlanInput, PlanOutcome, SetupPlan } from '@/engine/cnc/cam/model/plan';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';

const BALL6: Tool = { ...flatEndMill(6, { number: 1, id: 'ball-6', name: '6 mm ball nose' }), shape: 'ball', typeText: 'Ball Nose', diameter: 6 };

/** The #1023 measured shape: 78.61 % coverage, 2.42 mm standing over 21.4 % (the notched plate). */
const OUTCOME = {
  coverage: 0.786,
  leftoverAboveMm: 2.42,
  leftoverCells: 4343,
  coveredCells: 20294,
  cellAreaMm2: 0.01,
  cycleSeconds: 1,
  cutInto: { adjudicatedFraction: null, maxMm: null },
} as unknown as PlanOutcome;

const SETUPS = [{ programs: [{ tool: BALL6 }] }] as unknown as SetupPlan[];

function statementWith(restVisibility: ModelPlanInput['restVisibility']): string {
  const input = {
    cutters: { house: [BALL6], catalogue: [] },
    ...(restVisibility === undefined ? {} : { restVisibility }),
  } as unknown as ModelPlanInput;
  return restStatementForPlan(SETUPS, OUTCOME, input, null)?.text ?? '';
}

describe('#1027 each threshold keeps its own source', () => {
  it('one phrase when the two sources agree (the fallback)', () => {
    const text = statementWith({ depthMm: 0.1, share: 0.02, depthSource: 'fallback', shareSource: 'fallback' });
    expect(text).toContain('The thresholds are this build’s labelled fallback.');
    expect(text).not.toContain('The visible depth is from');
  });

  it('one phrase when the two sources agree (the shop)', () => {
    const text = statementWith({ depthMm: 0.1, share: 0.02, depthSource: 'chosen', shareSource: 'chosen' });
    expect(text).toContain('Both thresholds are from the shop’s location document.');
  });

  it('names BOTH sources when they differ — the depth from the shop, the share from the fallback', () => {
    const text = statementWith({ depthMm: 0.1, share: 0.02, depthSource: 'chosen', shareSource: 'fallback' });
    expect(text).toContain('The visible depth is from the shop’s location document; the third-tool share is from this build’s fallback.');
  });

  it('names the catalogue as the action when no ball was measured — the numbers and no size', () => {
    const text = statementWith(undefined);
    expect(text).toContain('2.42 mm');
    expect(text).toContain('21.4 %');
    expect(text).toContain('The ball that would take it is measured from the cutter catalogue — none is configured for this shop (Manage → Tools).');
    expect(text).not.toMatch(/about ⌀/);
  });
});
