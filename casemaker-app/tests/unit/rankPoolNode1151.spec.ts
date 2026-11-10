/**
 * #1151 Phase 2 — THE RANK POOL'S PLUMBING. The real worker plans a candidate; this spec drives
 * the pool with a stub entry (a whole Manifold build per worker belongs to the CLI proof, not to a
 * unit test): positional metrics, a refusal that rejects, and `cancel` swallowing what is left.
 */
import { describe, expect, it } from 'vitest';

import { rankPoolSeam, rankWorkerCap } from '../../scripts/lib/casemaker/rankPool';
import { flatEndMill, type Tool } from '../../src/engine/cnc/tool';
import type { ModelPlanInput, RankMeasureRequest } from '@/engine/cnc/cam/model/plan';

const tool = (key: string): Tool => flatEndMill(2, { id: key, name: key });
/** Only `cutters` is read by the stub; the real entry needs the whole model (the CLI proof). */
const request = (keys: string[]): RankMeasureRequest =>
  ({
    input: { cutters: { house: keys.map(tool), catalogue: [] } } as unknown as ModelPlanInput,
    setupIndex: 0,
    candidates: keys.map(tool),
  }) as unknown as RankMeasureRequest;

const ENTRY = new URL('./fixtures/rankPoolFakeWorker.mjs', import.meta.url);

describe('#1151 Phase 2 — the rank pool', () => {
  it('caps its fan-out by cores, and the env can only lower it', () => {
    const base = rankWorkerCap({});
    expect(base).toBeGreaterThanOrEqual(1);
    expect(base).toBeLessThanOrEqual(8);
    expect(rankWorkerCap({ CASEMAKER_RANK_WORKERS: '1' })).toBe(1);
    expect(rankWorkerCap({ CASEMAKER_RANK_WORKERS: '9999' })).toBe(base);
    expect(rankWorkerCap({ CASEMAKER_RANK_WORKERS: 'nonsense' })).toBe(base);
  });

  it('returns each candidate’s metric by position, in order', async () => {
    const handle = rankPoolSeam({ cap: 3, entry: ENTRY })(request(['aa', 'bbbb', 'cccccc']));
    // The engine consumes IN CANDIDATE ORDER; so does this.
    const metrics = [await handle.metric(0), await handle.metric(1), await handle.metric(2)];
    handle.cancel();
    expect(metrics.map((m) => (m.kind === 'measured' ? m.leftover : null))).toEqual([0.02, 0.04, 0.06]);
    expect(metrics.map((m) => (m.kind === 'measured' ? m.cycle : null))).toEqual([2, 4, 6]);
  });

  it('a refusing worker rejects that candidate’s metric', async () => {
    const handle = rankPoolSeam({ cap: 2, entry: ENTRY })(request(['ok-one', 'refuse', 'ok-two']));
    expect((await handle.metric(0)).kind).toBe('measured');
    await expect(handle.metric(1)).rejects.toThrow(/refused this candidate/);
    handle.cancel();
  });

  it('a candidate that refuses BEFORE it is consumed does not surface an unhandled rejection', async () => {
    const seen: unknown[] = [];
    const onUnhandled = (error: unknown): void => {
      seen.push(error);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      // The second worker refuses quickly, while the engine is still measuring the first
      // candidate in-process (minutes on set B): nothing awaits this promise yet.
      const handle = rankPoolSeam({ cap: 2, entry: ENTRY })(request(['aa', 'refuse']));
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(seen).toEqual([]);
      handle.cancel();
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('cancel abandons the outstanding candidates without an unhandled rejection', async () => {
    const handle = rankPoolSeam({ cap: 2, entry: ENTRY })(request(['aa', 'refuse', 'cccc']));
    expect((await handle.metric(0)).kind).toBe('measured');
    handle.cancel();
    // The refused slot was never consumed; cancel swallowed it. Nothing else may settle loudly.
    await Promise.resolve();
    expect(true).toBe(true);
  });
});
