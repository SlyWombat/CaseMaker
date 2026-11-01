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
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { tl } from './helpers/manifoldExec';
import { parseEngraveJob } from '@/store/engraveJobSchema';
import {
  FIDELITY_TIE,
  TOOL_CHANGE_SECONDS,
  planCostSeconds,
  planKey,
  smartPick,
  type ScoredPlan,
} from '@/engine/cnc/engrave/smartPick';
import { clearPlanEvaluations, evaluatePlan, type CandidatePlan, type PlanEvaluation } from '@/workers/sim/planEvaluate';
import { KNOWN_DEFAULTS, ShopDefaultsSchema, readDefault } from '@/platform/defaultsClient';
import { TOOL_LIBRARY, type ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import type { EngraveJob } from '@/types/engraveJob';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HERE, 'fixtures', 'pick857');

function tray(): EngraveJob {
  const parsed = parseEngraveJob(JSON.parse(readFileSync(join(DIR, 'j13-tool-tray.json'), 'utf8')));
  if (!parsed.ok) throw new Error(parsed.errors.join('\n'));
  return parsed.job;
}

const CLEAR = 'inv:kz-o-flute-3-175-25';
const FINE = 'flat-1.0';
const TOOLS: ToolLibraryEntry[] = [
  ...(JSON.parse(readFileSync(join(DIR, 'tools.json'), 'utf8')) as ToolLibraryEntry[]).filter((t) => t.key === CLEAR),
  TOOL_LIBRARY.find((t) => t.key === FINE)!,
];
const SEED = readDefault(
  ShopDefaultsSchema.parse((JSON.parse(readFileSync(join(HERE, 'fixtures', 'location-doc.json'), 'utf8')) as { defaults: unknown }).defaults),
  'toolChange.seconds',
);

const keys = (s: ScoredPlan): string => s.plan.cutters.map((c) => c.key).join('+');

async function pickFor(job: EngraveJob) {
  clearPlanEvaluations();
  const ctx = { tl, tools: TOOLS, catalogue: [], shop: { tools: TOOLS }, calibration: null };
  return smartPick(job, TOOLS, [], async (p: CandidatePlan, level) => await evaluatePlan(job, p, ctx, { level }), {
    toolChangeSeconds: SEED.value,
  });
}

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
      keys((await smartPick(job, TOOLS, [], evaluate, { toolChangeSeconds: change })).chosen);
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

  it('tight bin corners: the ⌀3.175 clear with a ⌀1 rest wins, at about a quarter of the ⌀1’s time', { timeout: 900_000 }, async () => {
    // Four of the tray's bins with 0.6 mm corners: the ⌀3.175 leaves each corner 0.46 mm² short,
    // past the tie, so the rest pass is what reproduces the design.
    const job = tray();
    const keep = new Set(['bin0', 'bin1', 'bin2', 'bin3']);
    job.shapes = job.shapes
      .filter((s) => keep.has(s.id))
      .map((s) => (s.kind === 'rect' ? { ...s, cornerRadius: 0.6 } : s));
    job.combined = [];
    job.drills = [];
    job.cutouts = [];
    const pick = await pickFor(job);
    expect(pick.runnable, pick.notes.join(' ')).not.toBeNull();
    const byKeys = new Map(pick.considered.map((s) => [keys(s), s] as const));
    const single = byKeys.get(CLEAR)!;
    const fine = byKeys.get(FINE)!;
    expect(single.worstFidelity).toBeLessThan(fine.worstFidelity - FIDELITY_TIE);
    expect(keys(pick.chosen)).toBe(`${CLEAR}+${FINE}`);
    const cost = (s: ScoredPlan) => planCostSeconds(s.evaluation, SEED.value);
    // About 51 min 34 s for the pair (one change at the seed included) against 3 h 8 min for the ⌀1.
    expect(cost(pick.chosen) / cost(fine)).toBeCloseTo(0.274, 2);
  });
});
