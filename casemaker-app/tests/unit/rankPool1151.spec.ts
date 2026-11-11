/**
 * #1151 Phase 2 — THE RANK'S OTHER CANDIDATES, MEASURED ELSEWHERE. The engine keeps the ordering,
 * the early break, `pickAmongEquals` and the tie keys; the seam only replaces each candidate's
 * measurement (the first candidate is always measured in-process to seed the incumbent). These
 * cases use a SAME-THREAD seam — it measures through the engine's own one-candidate entry, so the
 * metrics are the real ones a pool worker would return — and hold the output to the serial plan.
 *
 * The sloped fixture is #986's. With a ⌀0.2 first, the rank's equal-leftover CYCLE tie-break makes
 * the ⌀2 — a LATER candidate — the winner, which is the case that exercises the fallback: a
 * seam-measured winner has no stage ops in the memo, so the chosen plan recomputes them (the memo
 * is a read-through cache) and the bytes must come out identical.
 */


import { describe, expect, it } from 'vitest';

import {
  planModelCam,
  type ModelPlanInput,
  type RankMeasureHandle,
  type RankMeasurement,
  type RankMeasureRequest,
} from '@/engine/cnc/cam/model/plan';
import { flatEndMill, type Tool } from '../../src/engine/cnc/tool';
import { slopedInput } from './helpers/goalFixtures';

const flat6: Tool = flatEndMill(6, { number: 1, id: 'flat-6', name: 'flat-6', fluteLength: 30 });
const ball = (d: number): Tool => ({
  ...flatEndMill(d, { number: Math.round(d * 10) + 2, id: `ball-${d}`, name: `ball-${d}` }),
  shape: 'ball',
  typeText: 'Ball Nose',
  fluteLength: 30,
});

/**
 * The fixture and the serial plan are deterministic, so each (id, cutter set) builds them ONCE:
 * tests 1 and 2 use the same set (a seam that wins; a seam that fails), and both are held to the
 * same serial plan — the plan cannot depend on the seam.
 */
const slopedInputs = new Map<string, ModelPlanInput>();
const serialPlans = new Map<string, Promise<Awaited<ReturnType<typeof planModelCam>>>>();

const inputKey = (targetId: string, house: Tool[]): string =>
  `${targetId}|${house.map((tool) => tool.id ?? tool.name).join('|')}`;

function sharedInput(targetId: string, house: Tool[]): ModelPlanInput {
  const key = inputKey(targetId, house);
  const cached = slopedInputs.get(key);
  if (cached !== undefined) return cached;
  const input = slopedInput(targetId, house);
  slopedInputs.set(key, input);
  return input;
}

function serialPlan(targetId: string, house: Tool[]): Promise<Awaited<ReturnType<typeof planModelCam>>> {
  const key = inputKey(targetId, house);
  let plan = serialPlans.get(key);
  if (plan === undefined) {
    plan = planModelCam(sharedInput(targetId, house));
    serialPlans.set(key, plan);
  }
  return plan;
}

/** One candidate, measured through the engine's own worker entry — the real metric, same thread. */
async function measureAlone(request: RankMeasureRequest, candidate: Tool): Promise<RankMeasurement> {
  const captured: { metric: RankMeasurement | null } = { metric: null };
  await planModelCam(request.input, {
    rankMeasure: { setupIndex: request.setupIndex, candidateKey: candidate.id ?? candidate.name },
    onRankMetric: (metric) => {
      captured.metric = metric;
    },
  });
  if (captured.metric === null) throw new Error('the rank entry measured nothing');
  return captured.metric;
}

/** A handle that measures on demand (like a pool, but the same thread) and records `cancel`. */
function sameThreadSeam(seen: { cancelled: number; measured: number[] }): (request: RankMeasureRequest) => RankMeasureHandle {
  return (request) => ({
    metric: (index) => {
      seen.measured.push(index);
      return measureAlone(request, request.candidates[index]!);
    },
    cancel: () => {
      seen.cancelled += 1;
    },
  });
}

const rankNote = (output: { perSetup: { notes: string[] }[] }): string =>
  output.perSetup.flatMap((s) => s.notes).find((n) => n.startsWith('ball rank')) ?? 'NO RANK';

describe('#1151 Phase 2 — the rank seam', () => {
  it('a LATER candidate wins, and the seam run is byte-identical to the serial plan', async () => {
    // ⌀0.2 first, ⌀2 second: equal leftover, the ⌀2's cheaper cycle wins — the rank's SECOND
    // candidate takes the plan, measured through the seam in the seam run.
    const house = [flat6, ball(0.2), ball(2)];
    const serial = await serialPlan('fixture-rank-pool', house);
    expect(rankNote(serial)).toContain('Chosen: ball-2');

    const seen = { cancelled: 0, measured: [] as number[] };
    const seamRun = await planModelCam(sharedInput('fixture-rank-pool', house), { measureRankCandidates: sameThreadSeam(seen) });
    // The same choice, the same statement, and the same plan: the winner's memo entries were
    // recomputed by the chosen plan (a read-through cache), so not a byte moved.
    expect(rankNote(seamRun)).toBe(rankNote(serial));
    expect(rankNote(seamRun)).toContain('Chosen: ball-2');
    expect(seen.measured, 'only the candidate after the first is asked of the seam').toEqual([0]);
    expect(seen.cancelled, 'the search ended: the seam is cancelled').toBe(1);
    expect(JSON.stringify(seamRun)).toBe(JSON.stringify(serial));
  }, 600_000);

  it('a seam that fails is measured in-process: the pool’s health cannot move the plan', async () => {
    const house = [flat6, ball(0.2), ball(2)];
    const serial = await serialPlan('fixture-rank-pool', house);
    const deadSeam = (): RankMeasureHandle => ({
      metric: () => Promise.reject(new Error('the pool is down')),
      cancel: () => {},
    });
    const run = await planModelCam(sharedInput('fixture-rank-pool', house), { measureRankCandidates: deadSeam });
    // The candidate is measured here instead; the statement and the plan are the serial ones.
    expect(rankNote(run)).toBe(rankNote(serial));
    expect(JSON.stringify(run)).toBe(JSON.stringify(serial));
  }, 600_000);

  it('the early break stops the seam: an outstanding candidate is never measured and the seam is cancelled', async () => {
    // ⌀1 first (measured in-process), ⌀2 second: it does not improve on leftover, so the search
    // breaks before ⌀4 — the seam was offered both, consumes only the ⌀2, and is cancelled.
    const house = [flat6, ball(1), ball(2), ball(4)];
    const serial = await serialPlan('fixture-rank-pool', house);
    expect(rankNote(serial)).toMatch(/measured 2 candidate\(s\)/);
    expect(rankNote(serial)).toContain('Chosen: ball-1');

    const seen = { cancelled: 0, measured: [] as number[] };
    const seamRun = await planModelCam(sharedInput('fixture-rank-pool', house), { measureRankCandidates: sameThreadSeam(seen) });
    expect(seen.measured, 'the ⌀4 was never asked for').toEqual([0]);
    expect(seen.cancelled).toBe(1);
    expect(rankNote(seamRun)).toBe(rankNote(serial));
    expect(JSON.stringify(seamRun)).toBe(JSON.stringify(serial));
  }, 600_000);
});
