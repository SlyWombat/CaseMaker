/**
 * #1076 — THE RANK REPORTS, SO THE WATCHDOG IS NOT STARVED. On the tray bottom the CAM's progress
 * went silent from `features` to the first chain step for 125 s — the ball rank, which measures
 * every candidate with a FULL plan — and the ideal plan (a larger house, more candidates) crossed
 * the client's 180 s window. One tick per candidate measurement keeps the window alive; the
 * measurement itself is unchanged.
 */


import { describe, expect, it } from 'vitest';

import { planModelCam } from '@/engine/cnc/cam/model/plan';
import type { ModelPlanProgress } from '@/engine/cnc/cam/model/types';
import { slopedInput } from './helpers/goalFixtures';


describe('#1076 the rank reports progress per candidate', () => {
  it('one tick per candidate measurement, between the features tick and the chain', async () => {
    const ticks: ModelPlanProgress[] = [];
    await planModelCam(slopedInput('fixture-1076'), { onProgress: (p) => ticks.push(p) });
    const ops = ticks.map((t) => t.op);
    expect(ops, 'the plan reported nothing').toContain('features');
    // The #986 fixture measures two candidates (⌀2 and ⌀4); each reports before its measurement,
    // at the rank's own fraction (0.35 — the chain's candidate ticks are 0.4).
    const rankTicks = ticks.filter((t) => t.op === 'sequence' && t.fraction === 0.35);
    expect(rankTicks.length, `rank ticks: ${JSON.stringify(ops)}`).toBeGreaterThanOrEqual(2);
    // They arrive after the features tick, before the plan's linking end.
    const first = ticks.findIndex((t) => t.op === 'sequence' && t.fraction === 0.35);
    expect(first).toBeGreaterThan(ops.indexOf('features'));
    expect(ops.indexOf('linking')).toBeGreaterThan(first);
  }, 240_000);
});
