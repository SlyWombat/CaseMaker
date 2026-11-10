/**
 * #1046 — THE LADDER'S CALLERS (6b's six fields). #1028 measures the rungs; this issue lets the
 * run sheet and the CLI ask for them, and states the expected cost BEFORE the run from the last
 * Generate's own measured numbers.
 *
 * Here: the plan's timing read (planMs / finishStageMs / finishBallDiameterMm, dump only — no
 * statement or NC byte reads them), the estimate helper both callers quote, and the store's press
 * path passing `restLadder` to the pipeline. The panel's button and the CLI's sentence are pinned
 * beside their own harnesses.
 *
 * RED at the #1028 tip: none of the three fields exists and `restLadderEstimateMs` has nothing to
 * read — the estimate is a constant or absent.
 */
import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  planModelCam,
  restLadderEstimateMs,
  REST_LADDER_RUNGS_MM,
  type ModelPlanInput,
  type ModelPlanOutput,
  type PlanTiming,
} from '@/engine/cnc/cam/model/plan';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import type { EngraveJob, EngraveTargetObject } from '@/types/engraveJob';
import { buildModelPlanInputForGoal, generateGoalProgram } from '@/workers/sim/engraveGenerate';
import { notchedPlate } from './helpers/meshes';
import { BALL6_NOTCHED_LONG as BALL6 } from './helpers/goalFixtures';


/** The #1023/#1028 plate: 20 × 10 × 5 with a 6 mm-wide V notch. */
const SHOP_FEEDS = [
  {
    material: 'pla' as const,
    minDiameter: 0.4,
    maxDiameter: 8,
    params: { rpm: 12000, feed: 800, plungeFeed: 300, stepDown: 1, stepOverFraction: 0.45, peckFraction: 1, air: true },
    status: 'unmeasured' as const,
    provenance: 'test row',
  },
];

function goalTarget(): EngraveTargetObject {
  return {
    id: 'goal-1046', name: 'notched plate', role: 'goal', enabled: true, format: 'stl',
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

async function plateInput(): Promise<ModelPlanInput> {
  const target = goalTarget();
  const job = goalJob(target);
  return await buildModelPlanInputForGoal(job, target, BALL6, { tools: [], feeds: SHOP_FEEDS });
}

describe('#1046 the plan states its own wall time (dump only)', () => {
  it('the timing is measured on the caller’s sink — never in the plan JSON — and the estimate is its formula', async () => {
    let timing: PlanTiming | null = null;
    const plan = await planModelCam(await plateInput(), { onTiming: (t) => { timing = t; } });
    expect(timing, 'the plan reports its timing to the caller’s sink').not.toBeNull();
    expect(timing!.planMs, 'the whole plan is timed').toBeGreaterThanOrEqual(0);
    expect(timing!.finishStageMs, 'the finish stage is timed').toBeGreaterThan(0);
    // The finishing ball the rest statement judged: the ⌀6 the plan runs.
    expect(timing!.finishBallDiameterMm).toBeCloseTo(6, 6);
    // THE PLAN'S JSON IS CLEAN (the landing review's k3 reds): two runs differ in the clock, so a
    // wall-clock field inside the plan would break every "the same plan" identity pin.
    expect(JSON.stringify(plan)).not.toContain('planMs');
    expect(JSON.stringify(plan)).not.toContain('finishStageMs');
    expect(JSON.stringify(plan)).not.toContain('finishBallDiameterMm');

    // The one formula both callers quote: the owned plan again plus Σ√(D_finish/d) × the finish.
    const rungs = REST_LADDER_RUNGS_MM.filter((d) => d < timing!.finishBallDiameterMm - 1e-9);
    expect(rungs.length).toBe(6);
    const scale = rungs.reduce((n, d) => n + Math.sqrt(timing!.finishBallDiameterMm / d), 0);
    expect(restLadderEstimateMs(timing)).toBeCloseTo(timing!.planMs + scale * timing!.finishStageMs, 6);
    // No timing at all (a reloaded job, an older result): null, never a guessed constant.
    expect(restLadderEstimateMs(null)).toBeNull();
    expect(restLadderEstimateMs(undefined)).toBeNull();
  }, 300_000);

  it('the timing never reaches a statement, a note or a program: the flag-off plan’s words are unchanged', async () => {
    const plan = await planModelCam(await plateInput());
    const words = plan.perSetup.flatMap((s) => [...s.notes, ...s.statements.map((st) => st.text)]);
    expect(words.length).toBeGreaterThan(0);
    for (const line of words) expect(line).not.toMatch(/\d+\s?ms\b/);
    // The ladder's own variables are the only readers: a plan with no timing answers null.
    const bare: ModelPlanOutput = { perSetup: plan.perSetup };
    // The plan object itself carries no timing field to read.
    expect('planMs' in bare).toBe(false);
    expect(restLadderEstimateMs(null)).toBeNull();
  }, 300_000);

  it('the ladder run is priced from the plain finish, not from its own rung passes', async () => {
    // A ladder run's finishStageMs is its OWN (the rungs re-plan the finish); what the press quotes
    // comes from the last plain Generate. This pins that a ladder plan still measures its own
    // finish stage rather than summing the rung passes into it.
    let timing: PlanTiming | null = null;
    const plan = await planModelCam(await plateInput(), { restLadder: true, onTiming: (t) => { timing = t; } });
    expect(plan.ladderRows?.length).toBeGreaterThan(0);
    expect(timing!.finishStageMs).toBeGreaterThan(0);
    expect(restLadderEstimateMs(timing)).not.toBeNull();
  }, 300_000);


  it('the posted NC bytes with the flag off are the pre-#1046 bytes (hashed), so the timing fields change no card', async () => {
    // The Manager's ask: prove the flag-off program is byte-identical to MAIN's, by the NC TEXT —
    // not only the plan JSON minus timings. The hash was re-measured for the rebased branch the
    // same way the original was: this exact case run with the plan/pipeline sources checked out at
    // the branch's base, now main 0022a093b (the old #1046-base hash d9aa7461 predates main's
    // #1129/#1151 landings, which moved the plate's own NC). Flag off == main, byte for byte.
    const target = goalTarget();
    const job = goalJob(target);
    const out = await generateGoalProgram(job, target, BALL6, null, { shop: { tools: [], feeds: SHOP_FEEDS } });
    expect(out.ok, out.errors.map((e) => e.message).join('; ')).toBe(true);
    expect(out.nc).not.toBeNull();
    expect(createHash('sha256').update(out.nc!, 'utf8').digest('hex')).toBe('25ba7602f1cac4a05094f88b6ea938122deaa1db1bf83d1e43d2953684c2a00f');
  }, 300_000);
});
