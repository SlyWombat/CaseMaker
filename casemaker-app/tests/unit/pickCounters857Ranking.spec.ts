// #857 — the coin's RANKING, split from the sweep cross-check into its own file (#1180) so the two
// heavy tests run on parallel workers. The fixture is `helpers/pick857.ts`; this file keeps the
// search's own question: with the counters measured, does a V rest that opens them outrank every
// corn-rest plan that leaves them standing?

import { describe, expect, it } from 'vitest';

import { clearPlanEvaluations } from '@/workers/sim/planEvaluate';
import { COUNTER_TIE_MM2, planKey, smartPick } from '@/engine/cnc/engrave/smartPick';
import { picked } from './helpers/picked';
import { CORN_06, CORN_19, FLAT_3175, TOOLS, V_03, coin, evaluate } from './helpers/pick857';

describe('#857 a raised glyph’s counters count in the pick', () => {
  it('the coin’s ranking: a ⌀0.3 V rest wins over every corn-rest plan, because it keeps the counters open', { timeout: 600_000 }, async () => {
    clearPlanEvaluations();
    const job = coin();
    // #1134 caps the default full evaluations at 3; this case MEASURES the ranking across the
    // corn-rest plans too, so it asks for enough finalists to time every candidate (the cap's own
    // behaviour is pinned in smartPick.spec.ts).
    const pick = picked(await smartPick(job, TOOLS, [], null, (p, level) => evaluate(job, p, level), { maxCandidates: 16, fullFinalists: 20 }));
    expect(pick.runnable, pick.notes.join(' ')).not.toBeNull();
    // The V rest after a clearance flat: the search's answer, not a rule's. Which flat clears is the
    // run time's call (with this four-cutter library the ⌀1.9 is in the V pairings and is faster;
    // the demo's full library pairs the V with the ⌀3.175 clearances only).
    expect(pick.chosen.plan.cutters.at(-1)?.key).toBe(V_03);
    expect([FLAT_3175, CORN_19]).toContain(pick.chosen.plan.cutters[0]?.key);
    expect(pick.chosen.counterStandingMm2 ?? 0).toBeLessThanOrEqual(COUNTER_TIE_MM2);
    // Every corn-rest plan the search posted leaves visible counters, and ranks below.
    const order = pick.considered.map((s) => planKey(s.plan));
    const cornPlans = pick.considered.filter((s) => s.evaluation.ok && s.evaluation.seconds !== null && s.plan.cutters.at(-1)?.key === CORN_06);
    expect(cornPlans.length).toBeGreaterThan(0);
    for (const s of cornPlans) {
      expect(s.counterStandingMm2 ?? 0, planKey(s.plan)).toBeGreaterThan(COUNTER_TIE_MM2);
      expect(order.indexOf(planKey(s.plan))).toBeGreaterThan(order.indexOf(planKey(pick.chosen.plan)));
    }
  });
});
