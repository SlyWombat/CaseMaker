// #857 — THE PICK SEES FILLED COUNTERS. On the j04 coin ("CNX" over "Software", raised 0.4 mm on
// PLA) the measured search chose a ⌀1.9 flat with a ⌀0.6 corn rest and scored it 98 %, better than
// a ⌀3.175 flat with a ⌀0.3 (20°) V rest at 97 %. The swept top view showed why that was wrong: the
// corn cannot enter the 'e' of "Software" and only partly opens its 'a', so those counters stand at
// full height. The fidelity measure counted the pinches between letters and nothing inside them.
//
// The evaluator now measures every enclosed counter of a raised glyph — its area, and the part of it
// left standing — from the SWEPT run at half the relief's depth (the coarse level uses the
// cutter-width model), and the search ranks the counters before the pinches. This file checks the
// evaluator's numbers against an independent sweep of the same plan on the demo's own coin and its
// own library rows (fixtures/pick857). #1180 split the ranking test into its own file so the two run
// on parallel workers; `helpers/pick857.ts` is the fixture both share.

import { describe, expect, it } from 'vitest';

import { tl } from './helpers/manifoldExec';
import { applyCutterPlan, clearPlanEvaluations } from '@/workers/sim/planEvaluate';
import { engraveGenerate } from '@/workers/sim/engraveGenerate';
import { COUNTER_TIE_MM2 } from '@/engine/cnc/engrave/smartPick';
import { counterRegion } from '@/workers/sim/engraveGeometry';
import { createSimSession } from '@/workers/sim/session';
import { executeProfile } from '@/workers/geometry/evaluateOp';
import { toPartPlan } from '@/engine/cnc/engrave/partPlan';
import { toSetup } from '@/engine/cnc/engrave/jobSetup';
import { jobMachine } from '@/engine/cnc/calibration';
import { CORN_19, CORN_PLAN, TOOLS, V_PLAN, coin, counterOf, evaluate, standing } from './helpers/pick857';

describe('#857 a raised glyph’s counters count in the pick', () => {
  it('the corn rest leaves the e of "Software" filled; the V opens it — and the number is the sweep’s', { timeout: 300_000 }, async () => {
    clearPlanEvaluations();
    const job = coin();
    const corn = await evaluate(job, CORN_PLAN, 'full');
    const v = await evaluate(job, V_PLAN, 'full');
    expect(corn.ok, corn.refusal ?? '').toBe(true);
    expect(v.ok, v.refusal ?? '').toBe(true);
    const cornItem = corn.items.find((i) => i.id === 'clear')!;
    expect(cornItem.countersFrom, 'the full level reads the counters off the sweep').toBe('swept');

    // The design's counters, by glyph (bold sans at 3.6 mm and 7 mm): the e, the a and the o of
    // "Software" — "CNX" has none.
    const e = counterOf(corn, 'e');
    expect(e).toHaveLength(1);
    expect(e[0]!.areaMm2).toBeCloseTo(0.364, 2);
    expect(counterOf(corn, 'a')[0]!.areaMm2).toBeCloseTo(0.457, 2);
    expect(counterOf(corn, 'o')[0]!.areaMm2).toBeCloseTo(1.212, 2);

    // The ⌀0.6 corn cannot enter the e (its counter is narrower than the cutter): all of it but the
    // sweep's tolerance ring stands. The V's 0.3 mm tip opens every counter.
    expect(e[0]!.standingMm2).toBeGreaterThan(0.3);
    expect(standing(corn)).toBeGreaterThan(COUNTER_TIE_MM2);
    expect(standing(v), 'the V rest opens every counter').toBeLessThanOrEqual(COUNTER_TIE_MM2);

    // CHECKED AGAINST THE SWEPT FIELD, independently of the evaluator: post the corn plan, sweep
    // each program from the blank (removal only grows, so their union is the run's cut), slice at
    // half the 0.4 mm relief, and measure the e's counter less the oracle's band against it.
    const applied = applyCutterPlan(job, CORN_PLAN);
    const gen = await engraveGenerate(tl, applied, TOOLS.find((t) => t.key === CORN_19)!.tool, [], null, undefined, { tools: TOOLS });
    expect(gen.ok).toBe(true);
    const setup = toSetup(applied, jobMachine(applied, null));
    const cuts: { region: ReturnType<typeof executeProfile> | null; bandMm: number }[] = [];
    for (const program of gen.programs) {
      const session = createSimSession(tl);
      try {
        const load = session.load(program.nc, setup, TOOLS.find((t) => t.key === program.toolKey)!.tool, applied.machineId, {
          breakthroughMm: applied.breakthrough,
        });
        expect(load.ok).toBe(true);
        cuts.push(session.levelCut(-0.2)!);
      } finally {
        session.dispose();
      }
    }
    const band = Math.max(...cuts.map((c) => c.bandMm));
    const regions = cuts.map((c) => c.region).filter((r): r is NonNullable<typeof r> => r !== null);
    const cut = tl.CrossSection.union(regions);
    for (const r of regions) r.delete();
    // The e: the one glyph of "Software" whose single counter has the e's design area.
    const part = toPartPlan(job);
    const raised = part.raisedTexts.find((r) => r.id === 'clear')!;
    const field = executeProfile(tl, raised.field);
    let sweptE: number | null = null;
    for (const island of raised.islands.filter((i) => i.labelId === 'software')) {
      const glyphs = executeProfile(tl, island.profile);
      for (const glyph of glyphs.decompose()) {
        const holes = counterRegion(tl, glyph);
        glyph.delete();
        if (holes === null) continue;
        const want = tl.CrossSection.intersection([holes, field]);
        holes.delete();
        if (Math.abs(want.area() - e[0]!.areaMm2) < 1e-6) {
          const inner = want.offset(-band, 'Round', 2, 16);
          const left = tl.CrossSection.difference([inner, cut]);
          sweptE = left.area();
          inner.delete();
          left.delete();
        }
        want.delete();
      }
      glyphs.delete();
    }
    field.delete();
    cut.delete();
    expect(sweptE, 'the e was found in the design').not.toBeNull();
    expect(e[0]!.standingMm2).toBeCloseTo(sweptE!, 2);
  });
});
