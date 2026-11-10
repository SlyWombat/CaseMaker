// #1137 — THE CLI POOL'S PLUMBING. The real worker entry builds a Manifold instance per thread;
// this spec drives the same pool with a stub worker (fixtures/pickPoolFakeWorker.mjs) so the
// queueing, the positional assembly and the death path are what is measured, not the planner.
//
// The engine-level identity (batch vs serial winner) is pinned in pickParallel1137.spec.ts; the
// real pool's end-to-end identity is the CLI comparison run on the coin and petit-pot-lid.
import { describe, expect, it } from 'vitest';

import type { CandidatePlan } from '@/engine/cnc/engrave/smartPick';
import type { PlanEvaluation } from '@/workers/sim/planEvaluate';
import { NodePickPool, pickCapacity, servicePickSlots } from '../../scripts/lib/casemaker/pickPool';
import type { PickWorkerInputs } from '../../scripts/lib/casemaker/pickPoolWorker';

const WORKER = new URL('./fixtures/pickPoolFakeWorker.mjs', import.meta.url);

function plan(cutters: number): CandidatePlan {
  return {
    cutters: Array.from({ length: cutters }, (_, i) => ({ key: `inv:flat-${i}`, items: [] })),
    source: {},
  } as unknown as CandidatePlan;
}

const inputs = (over: Record<string, unknown> = {}): PickWorkerInputs => ({ mode: 'ok', ...over }) as unknown as PickWorkerInputs;

describe('#1137 the pool’s slot count', () => {
  it('the pick’s cap, bounded by the cores and by the service’s own bound', () => {
    expect(pickCapacity(1)).toBe(1);
    expect(pickCapacity(3)).toBeGreaterThanOrEqual(1);
    expect(pickCapacity(3)).toBeLessThanOrEqual(3);
    expect(pickCapacity(3, 1)).toBe(1);
    expect(pickCapacity(3, 2)).toBeLessThanOrEqual(2);
    expect(pickCapacity(3, 99)).toBeLessThanOrEqual(3);
    expect(pickCapacity(99, 2)).toBe(2);
  });

  it('the service sets its bound with CASEMAKER_PICK_WORKERS; a malformed value is ignored', () => {
    expect(servicePickSlots({})).toBeUndefined();
    expect(servicePickSlots({ CASEMAKER_PICK_WORKERS: '2' })).toBe(2);
    expect(servicePickSlots({ CASEMAKER_PICK_WORKERS: '0' })).toBeUndefined();
    expect(servicePickSlots({ CASEMAKER_PICK_WORKERS: 'x' })).toBeUndefined();
    expect(servicePickSlots({ CASEMAKER_PICK_WORKERS: '1.5' })).toBeUndefined();
  });
});

describe('#1137 the CLI pick pool', () => {
  it('answers positionally across two workers, whatever order they finish in', async () => {
    const pool = await NodePickPool.open(inputs(), 2, WORKER, []);
    try {
      const results: readonly PlanEvaluation[] = await pool.evaluateMany([plan(1), plan(2), plan(3)], 'full');
      expect(results.map((r) => r.seconds)).toEqual([10, 20, 30]);
    } finally {
      pool.dispose();
    }
  });

  it('a dying worker rejects the batch instead of hanging or dropping a finalist', async () => {
    const pool = await NodePickPool.open(inputs({ mode: 'crash' }), 1, WORKER, []);
    try {
      await expect(pool.evaluateMany([plan(1), plan(2)], 'full')).rejects.toThrow(/exited with code 7/);
    } finally {
      pool.dispose();
    }
  });

  it('a disposed pool refuses new work', async () => {
    const pool = await NodePickPool.open(inputs(), 1, WORKER, []);
    pool.dispose();
    await expect(pool.evaluateMany([plan(1)], 'full')).rejects.toThrow(/closed/);
  });
});
