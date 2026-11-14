/**
 * #864 — A V REST'S FLOOR. j20's raised M stands in a 6 mm pocket; the demo's plan rests it with
 * a 90° chamfer whose cone reaches 1.5375 mm, so the rest re-cuts only the top band of the corner
 * material the flat could not reach — and the plan still measured full fidelity on the letters.
 * The evaluator now scores the floor's depth by the last cutter that touches it.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { tl } from './helpers/manifoldExec';
import {
  clearPlanEvaluations,
  evaluatePlan,
  type CandidatePlan,
  type EvalContext,
} from '@/workers/sim/planEvaluate';
import { parseEngraveJob } from '@/store/engraveJobSchema';
import { kindedWork } from '@/engine/cnc/engrave/cutterPlan';
import { smartPick } from '@/engine/cnc/engrave/smartPick';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import type { EngraveJob } from '@/types/engraveJob';
import { picked } from './helpers/picked';

const HERE = dirname(fileURLToPath(import.meta.url));

/** j20, verbatim from demo5's job set (the document the bench cut). */
function j20(): EngraveJob {
  const raw = JSON.parse(readFileSync(join(HERE, 'fixtures', 'j20-spoon-rest.json'), 'utf8')) as Record<string, unknown>;
  const parsed = parseEngraveJob(raw);
  if (!parsed.ok) throw new Error(`j20 should parse: ${parsed.errors.join('; ')}`);
  return parsed.job;
}

const O_FLUTE: Tool = flatEndMill(3.175, { name: '3.175 mm o-flute', fluteLength: 42 });
/** The demo's 90° chamfer: a 0.1 mm tip, so its cone is (3.175 − 0.1) / 2 = 1.5375 mm tall. */
const CHAMFER: Tool = {
  ...flatEndMill(3.175, { name: '3.175 mm 90° chamfer', fluteLength: null }),
  shape: 'chamfer',
  typeText: 'Chamfer',
  tipDiameter: 0.1,
  angle: 90,
  halfAngle: null,
};
const FINE_FLAT: Tool = flatEndMill(1, { name: '1 mm flat', fluteLength: 7 });

function entry(key: string, tool: Tool): ToolLibraryEntry {
  return { key, tool: { ...tool, id: key, number: 1 }, provenance: 'test' };
}
const O = entry('inv:o-flute-3.175', O_FLUTE);
const C = entry('inv:chamfer-90', CHAMFER);
const F = entry('inv:flat-1', FINE_FLAT);

const CTX: EvalContext = { tl, tools: [O, C, F], catalogue: [], shop: {}, calibration: null };

/** The flat work as the kind plan sees it, so the plan owns every item exactly once. */
function planWith(rest: ToolLibraryEntry): CandidatePlan {
  const ids = kindedWork(j20(), null).map((w) => w.id);
  const cutters = [
    { key: O.key, items: ids },
    { key: rest.key, items: [] as string[] },
  ];
  return { cutters, source: Object.fromEntries(cutters.map((c) => [c.key, 'owned' as const])) };
}

function raisedRow(out: Awaited<ReturnType<typeof evaluatePlan>>) {
  const row = out.items.find((i) => i.id === 'rest-clear');
  if (row === undefined) throw new Error(`no 'rest-clear' row; items: ${out.items.map((i) => i.id).join(', ')}`);
  return row;
}

describe('#864 the floor a V rest leaves', () => {
  it('j20: the 90° chamfer reaches 1.5375 of the 6 mm floor, and the score says so', async () => {
    clearPlanEvaluations();
    const job = j20();
    const out = await evaluatePlan(job, planWith(C), CTX);
    const row = raisedRow(out);
    // The cone's height over the design's depth — the share of the floor the rest reaches.
    const share = 1.5375 / 6;
    expect(row.floorShare).toBeCloseTo(share, 4);
    expect(row.fidelity).toBeLessThanOrEqual(share + 1e-9);
    // The notch is a flat floor too, and the rest re-cuts it at the same cone height.
    const notch = out.items.find((i) => i.id === 'notch');
    expect(notch?.floorShare).toBeCloseTo(share, 4);
  }, 120_000);

  it('a flat rest reaches the whole floor, and the plan scores better than the V’s', async () => {
    clearPlanEvaluations();
    const job = j20();
    const flat = await evaluatePlan(job, planWith(F), CTX);
    const row = raisedRow(flat);
    expect(row.floorShare).toBeUndefined();
    // The raised measure may keep a hair of a pinch at the 1 mm flat's width; the floor is whole.
    expect(row.fidelity).toBeGreaterThan(0.99);
    // The whole-plan worst, which the ranking compares, is the V plan's to lose.
    const worst = (out: Awaited<ReturnType<typeof evaluatePlan>>): number => Math.min(...out.items.map((i) => i.fidelity));
    const v = await evaluatePlan(job, planWith(C), CTX);
    expect(worst(v)).toBeLessThan(worst(flat) - 1e-9);
  }, 180_000);

  it('the measured pick no longer rests j20 with the V — whatever wins reaches the floor', async () => {
    clearPlanEvaluations();
    const job = j20();
    const pick = picked(await smartPick(job, [O, C, F], [], null, async (plan) => await evaluatePlan(job, plan, CTX)));
    // The chamfer as a rest leaves 74 % of the floor's depth standing; the plan with it scores
    // 0.256 on the raised cutaway and cannot win once the floor is in the score.
    expect(pick.chosen.plan.cutters.every((c) => c.key !== C.key)).toBe(true);
    // And the plan that did win reaches the design's floor (a flat rest, or no rest at all).
    expect(raisedRow(pick.chosen.evaluation).floorShare).toBeUndefined();
  }, 600_000);
});
