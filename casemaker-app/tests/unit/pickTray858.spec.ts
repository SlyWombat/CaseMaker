// #858 — THE TOOL TRAY WAS CUT WITH ONE ⌀1 FLAT: 41 h 7 min. The search did weigh run time, but every
// clear-plus-rest plan it tried was REFUSED: the ⌀1 rest program over the tray's 36 items has 1855
// runs of cuts, more than the exact sweep takes on, and the generator's rest check sent it to that
// sweep seeded with the clearing program's material — `dense-3d-refused`, so "Setup 1's rest
// program could not be measured". The multi-program walk already retries such a program from the
// blank on the column engine (#746); the rest check now does the same, so the pair posts.
//
// With the pair posting, the search ranks by simulated time at equal fidelity, a tool change
// costing the shop's `toolChange.seconds`. On the demo tray that answer is the ⌀3.175 ALONE: the
// bins' corners are drawn at 1.6 mm, which the ⌀3.175 (r 1.5875 mm) already reaches, so a ⌀1 rest
// pass adds hours and nothing the design asks for. Where the corners are tighter than the clearing
// cutter, the clear-plus-rest pair is the answer. Real Manifold, generator and sweep, on the demo's
// job file and library rows (fixtures/pick857).

import { describe, expect, it } from 'vitest';

import {
  FIDELITY_TIE,
  TOOL_CHANGE_SECONDS,
  planCostSeconds,
  planKey,
  smartPick,
  type ScoredPlan,
} from '@/engine/cnc/engrave/smartPick';
import type { CandidatePlan, PlanEvaluation } from '@/workers/sim/planEvaluate';
import { KNOWN_DEFAULTS } from '@/platform/defaultsClient';
import { picked } from './helpers/picked';
import { CLEAR, FINE, OWNED_1MM, SEED, TOOLS, keys, pickFor, tray } from './helpers/pickTray858';

describe('#858 a tool change has a cost, and time decides at equal fidelity', () => {
  it('toolChange.seconds is a seeded shop default with a stated source, and the search’s fallback is the seed', () => {
    expect(SEED.source).toBe('seeded');
    expect(SEED.value).toBe(91.4);
    expect(KNOWN_DEFAULTS['toolChange.seconds']!.fallback).toBe(TOOL_CHANGE_SECONDS);
    expect(KNOWN_DEFAULTS['toolChange.seconds']!.unit).toBe('s');
  });

  it('the cost is the simulated time plus the shop’s allowance per change, and the allowance can decide', async () => {
    // Two plans that reproduce the design alike: one cutter at 1000 s, two at 950 s.
    const item = { id: 'pocket', name: 'pocket', kind: 'flat' as const, charsLost: 0, areaMismatchMm2: null, pinches: [] };
    const verdict = (seconds: number, changes: number, fidelity: number): PlanEvaluation => ({
      ok: true,
      refusal: null,
      items: [{ ...item, fidelity }],
      seconds,
      toolChanges: changes,
      risk: { reachMarginMm: null, holderClearanceMm: null, chipLoadRatio: null },
    });
    expect(planCostSeconds(verdict(950, 1, 1), 91.4)).toBeCloseTo(1041.4, 6);
    const job = tray();
    const evaluate = (p: CandidatePlan): PlanEvaluation =>
      p.cutters.length === 1 ? verdict(1000, 0, 1 - FIDELITY_TIE / 2) : verdict(950, 1, 1);
    const pickWith = async (change: number) =>
      keys(picked(await smartPick(job, [...TOOLS, OWNED_1MM], [], evaluate, { toolChangeSeconds: change })).chosen);
    // 950 + 40 < 1000: the change is worth it. 950 + 91.4 > 1000: it is not — and the 0.05 %
    // fidelity difference is inside the tie, so it does not decide either way.
    expect(await pickWith(40)).toContain('+');
    expect(await pickWith(SEED.value)).not.toContain('+');
  });

  it('the demo tray: the clear-plus-rest pair now posts, and the ⌀3.175 alone wins on time', { timeout: 900_000 }, async () => {
    const pick = await pickFor(tray());
    const byKeys = new Map(pick.considered.map((s) => [keys(s), s] as const));
    const single = byKeys.get(CLEAR)!;
    const fine = byKeys.get(FINE)!;
    const pair = byKeys.get(`${CLEAR}+${FINE}`)!;
    for (const s of [single, fine, pair]) {
      expect(s.evaluation.ok, `${keys(s)}: ${s.evaluation.refusal ?? ''}`).toBe(true);
      expect(s.evaluation.seconds, keys(s)).not.toBeNull();
    }
    // Fidelity ties within 0.1 %: the 1.6 mm bin corners take the ⌀3.175 (r 1.5875 mm).
    expect(Math.abs(single.worstFidelity - fine.worstFidelity)).toBeLessThanOrEqual(FIDELITY_TIE);
    expect(planKey(pick.chosen.plan)).toBe(planKey(single.plan));
    // The run times, from the programs' own CAM estimates (the fallback feed table, no catalogue):
    // ⌀3.175 alone about 8 h 26 min, the pair about 13 h 44 min, the ⌀1 alone 41 h 7 min.
    const cost = (s: ScoredPlan) => planCostSeconds(s.evaluation, SEED.value);
    expect(cost(single) / cost(fine)).toBeCloseTo(0.205, 2);
    expect(cost(pair) / cost(fine)).toBeCloseTo(0.335, 2);
    expect(pick.considered.map(keys).slice(0, 3)).toEqual([CLEAR, `${CLEAR}+${FINE}`, FINE]);
  });

});
