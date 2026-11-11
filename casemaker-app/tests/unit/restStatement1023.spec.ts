/**
 * #1023 — THE FINISH'S LEFTOVER IS STATED, ONCE, WITH ITS NUMBERS AND THE BALL THAT WOULD TAKE IT.
 *
 * The model engine measures the leftover on every plan (`outcome.coverage` /
 * `outcome.leftoverAboveMm`) but spoke only when the ball rank had more than one candidate to
 * explain (`cam/model/plan.ts:902`). With one ball the operator got 78.61 % coverage and 2.42 mm
 * standing with no sentence, and the shop's `rest.visibleDepthMm` / `rest.thirdToolPct`
 * thresholds had no consumer on the model path at all.
 *
 * RED at b390a9251: no `goal-rest-uncut` / `goal-rest-pass` statement is emitted, and the quiet
 * run is byte-identical to the loud one.
 *
 * The sentence is built from the plan's own stamp: `share = 1 − outcome.coverage`, the depth is
 * `outcome.leftoverAboveMm`, the cells and area are the same stamp's (`PlanOutcome` now carries
 * them). Severity is warning past the shop's thresholds, info under them; `goal-rest-pass` is the
 * info form when a smaller owned ball ran. The "ball that would take it" comes from the ideal plan
 * when the catalogue measured one (`planTwoOutcomes`), else the plan says so.
 */
import { describe, expect, it } from 'vitest';

import { planModelCam } from '@/engine/cnc/cam/model/plan';
import { planTwoOutcomes } from '@/engine/cnc/cam/model/twoPlans';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import type { EngraveJob, EngraveTargetObject } from '@/types/engraveJob';
import { buildModelPlanInputForGoal } from '@/workers/sim/engraveGenerate';
import { notchedPlate } from './helpers/meshes';
import { BALL6_NOTCHED as BALL6, BALL2_NOTCHED as BALL2 } from './helpers/goalFixtures';


/** The same 20 × 10 × 5 plate with a 6 mm-wide V notch as #1008, wound consistently (see there). */
// A STATED 10 mm FLUTE so the ⌀2 reaches the 4.5 mm notch. With no flute stated, `finishBallCandidates` keeps only one of the unknown-reach balls (house order decides), and the ideal plan would never measure the ⌀2.
const SHOP_FEEDS = [
  {
    material: 'pla' as const,
    minDiameter: 1,
    maxDiameter: 8,
    params: { rpm: 12000, feed: 800, plungeFeed: 300, stepDown: 1, stepOverFraction: 0.45, peckFraction: 1, air: true },
    status: 'unmeasured' as const,
    provenance: 'test row',
  },
];

function goalTarget(): EngraveTargetObject {
  return {
    id: 'goal-1023', name: 'notched plate', role: 'goal', enabled: true, format: 'stl',
    sha256: 'q'.repeat(64), data: notchedPlate(),
    position: { x: 30, y: 20, z: 0 }, rotation: 0,
    size: { x: 20, y: 10, z: 5 },
    surface: { gridPitchMm: 0.5 },
  } as EngraveTargetObject;
}

function goalJob(target: EngraveTargetObject): EngraveJob {
  const base = defaultEngraveJob();
  return {
    ...base, labels: [], shapes: [], targetObject: target, toolKey: '', tool: BALL6,
    stock: { ...base.stock, length: 60, width: 40, thickness: 12, material: 'pla' },
  };
}

async function planWith(shop: Parameters<typeof buildModelPlanInputForGoal>[3]) {
  const target = goalTarget();
  const job = goalJob(target);
  const input = await buildModelPlanInputForGoal(job, target, BALL6, shop);
  const plan = await planModelCam(input);
  const statement = plan.perSetup.at(-1)!.statements.find((s) => s.code === 'goal-rest-uncut' || s.code === 'goal-rest-pass');
  return { plan, statement };
}

describe('#1023 — the finish states what it leaves', () => {
  it('with one ball, states the leftover as a warning with both numbers and the thresholds', async () => {
    const { plan, statement } = await planWith({ tools: [], feeds: SHOP_FEEDS });
    expect(plan.outcome?.coverage).toBeCloseTo(0.786, 3);
    expect(statement?.code).toBe('goal-rest-uncut');
    expect(statement?.severity).toBe('warning');
    expect(statement?.text).toContain('2.42 mm');
    expect(statement?.text).toContain('21.4 %');
    expect(statement?.text).toContain('0.10 mm');
    expect(statement?.text).toContain('2 %');
    // planModelCam alone has no measured catalogue ball; the seam's ideal plan supplies one.
    expect(statement?.text).toContain('none is configured for this shop (Manage → Tools)');
    expect(statement?.count).toBeGreaterThan(0);
  }, 180_000);

  it('states the same numbers as information when the shop thresholds hide the leftover', async () => {
    const loud = await planWith({ tools: [], feeds: SHOP_FEEDS });
    const quiet = await planWith({
      tools: [],
      feeds: SHOP_FEEDS,
      rest: {
        overlap: { value: 0.5, source: 'chosen' as const },
        thirdToolPct: { value: 30, source: 'chosen' as const },
        visibleDepth: { value: 3, source: 'chosen' as const },
      },
    });
    expect(quiet.statement?.code).toBe('goal-rest-uncut');
    expect(quiet.statement?.severity).toBe('info');
    expect(quiet.statement?.text).toContain('2.42 mm');
    expect(quiet.statement?.text).toContain('21.4 %');
    expect(quiet.statement?.text).toContain('under the 3.00 mm and 30 %');
    // Statements only: the posted programs do not move.
    expect(JSON.stringify(quiet.plan.perSetup.at(-1)!.programs))
      .toBe(JSON.stringify(loud.plan.perSetup.at(-1)!.programs));
  }, 180_000);

  it('is the info form when a smaller owned ball ran', async () => {
    const { plan, statement } = await planWith({
      tools: [{ key: 'user:ball-2-1023', tool: BALL2, provenance: 'test' }],
      feeds: SHOP_FEEDS,
    });
    expect(plan.outcome?.coverage).toBeCloseTo(0.935, 3);
    expect(statement?.code).toBe('goal-rest-pass');
    expect(statement?.severity).toBe('info');
    expect(statement?.text).toContain('0.90 mm');
    expect(statement?.text).toContain('6.5 %');
    expect(statement?.text).toContain('2 mm ball nose');
  }, 180_000);

  it('a catalogue that exists and offers no ball says so — the flag rides through planTwoOutcomes', async () => {
    // E's finding on the #1028 follow-up: `planTwoOutcomes` empties `cutters.catalogue` before the
    // owned plan runs, so `reference === null` cannot tell "none configured" from "configured,
    // none measured". restProvenance1027 pins the two facts on the statement; this pins the WIRE —
    // that `twoPlans.ts` carries the answer from the CALLER's catalogue onto the owned run.
    const target = goalTarget();
    const job = goalJob(target);
    const flat1: Tool = flatEndMill(1, { name: '1 mm flat end', diameter: 1, fluteLength: 30 });
    const input = await buildModelPlanInputForGoal(job, target, BALL6, { tools: [], feeds: SHOP_FEEDS }, undefined, [flat1]);
    expect(input.cutters.catalogue.length).toBe(1);
    const two = await planTwoOutcomes(input);
    const statement = two.owned.perSetup.at(-1)!.statements.find((s) => s.code === 'goal-rest-uncut' || s.code === 'goal-rest-pass');
    expect(statement?.text).toContain('none of its balls takes this leftover');
    expect(statement?.text).not.toContain('none is configured for this shop');
  }, 180_000);
});
