/**
 * #1151 — the deferred ideal on the #764 shell (#1180: split out of goalClearAround so these two
 * full `engraveGenerate` cases run beside the plan cases, not after them).
 */
import { describe, expect, it } from 'vitest';
import { flatEndMill } from '@/engine/cnc/tool';
import { BALL_TOOL, goal, job, zOut } from './helpers/goalClearAround';

describe('#1151 the deferred ideal on the #764 shell', () => {
  it('#1151 — deferIdeal posts the owned plan and leaves the comparison to the caller', async () => {
    const { engraveGenerate, buildModelPlanInputForGoal } = await import('@/workers/sim/engraveGenerate');
    const { planOwnedOnly } = await import('@/engine/cnc/cam/model/twoPlans');
    const { tl } = await import('./helpers/manifoldExec');
    const j = job(goal(zOut));
    const catalogue = [flatEndMill(1.5, { shape: 'ball', name: '1.5 mm ball nose (catalogue)' })];
    const deferred = await engraveGenerate(tl, j, BALL_TOOL, [], null, undefined, {}, undefined, catalogue, { deferIdeal: true });
    expect(deferred.ok).toBe(true);
    expect(deferred.idealDeferred).toBe(true);
    expect(deferred.planIdeal ?? null, 'the ideal was not run').toBeNull();
    expect(deferred.planTradeoff ?? null, 'no comparison was stated').toBeNull();
    // The posted plan is the OWNED half, computed exactly as a two-plan Generate computes it
    // first: the ideal comparison cannot move the plan or the bytes.
    const modelInput = await buildModelPlanInputForGoal(j, j.targetObject!, BALL_TOOL, {}, undefined, catalogue, []);
    const owned = await planOwnedOnly(modelInput);
    expect(JSON.stringify(deferred.plan)).toBe(JSON.stringify(owned));
  }, 120_000);

  it('#1151 — a job whose recorded choice is the ideal waits for both plans', async () => {
    const { engraveGenerate } = await import('@/workers/sim/engraveGenerate');
    const { tl } = await import('./helpers/manifoldExec');
    const j = { ...job(goal(zOut)), planChoice: 'ideal' as const };
    const catalogue = [flatEndMill(1.5, { shape: 'ball', name: '1.5 mm ball nose (catalogue)' })];
    const result = await engraveGenerate(tl, j, BALL_TOOL, [], null, undefined, {}, undefined, catalogue, { deferIdeal: true });
    expect(result.ok).toBe(true);
    expect(result.idealDeferred ?? false).toBe(false);
    expect(result.planIdeal ?? null).not.toBeNull();
  }, 240_000);
});
