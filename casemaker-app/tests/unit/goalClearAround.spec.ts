/**
 * #764 — A GOAL MADE AS THE ITEM IS CLEARED AROUND ITSELF, DOWN TO ITS BASE PLANE. (#1180: the two
 * deferred-ideal cases moved to goalClearDefer1151 so the heavy plans run in parallel.)
 */
import { describe, expect, it } from 'vitest';
import { sampleGoalHeightfield } from '@/engine/cnc/engrave/goalHeightfield';
import { BALL_TOOL, BASE_Z, PITCH, STOCK_RECT, goal, job, zOut } from './helpers/goalClearAround';

describe('#764 — the item goal is cleared around itself', () => {
  it('#982 pin — a ball-only set plans the item through planModelCam (no flat: the ball floor pass)', async () => {
    const target = goal(zOut);
    const j = job(target);
    const { buildModelPlanInputForGoal } = await import('@/workers/sim/engraveGenerate');
    const { planModelCam } = await import('@/engine/cnc/cam/model/plan');
    const modelInput = await buildModelPlanInputForGoal(j, j.targetObject!, BALL_TOOL, {});
    const modelOut = await planModelCam(modelInput);
    expect(modelOut.perSetup[0]!.programs.length, 'no program was planned').toBeGreaterThan(0);
    expect(modelOut.perSetup.flatMap((s) => s.notes).join('\n')).toContain('no flat end mill');
  }, 120_000);

  it('“the whole blank” clears the stock’s own rectangle to the base plane', () => {
    const hf = sampleGoalHeightfield(goal(zOut), {
      pitchMm: PITCH,
      clear: { kind: 'whole' },
      stockRect: STOCK_RECT,
      baseZ: BASE_Z,
    });
    expect(hf.x0).toBeCloseTo(0, 6);
    expect(hf.y0).toBeCloseTo(0, 6);
    const i = Math.round((1 - hf.x0) / hf.pitch);
    const j = Math.round((1 - hf.y0) / hf.pitch);
    const k = j * hf.nx + i;
    expect(hf.covered[k]!).toBe(1);
    expect(hf.z[k]!).toBeCloseTo(BASE_Z, 5);
  });
});
