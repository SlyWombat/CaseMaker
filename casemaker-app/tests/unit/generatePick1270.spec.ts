// #1270 — the measured cutter pick runs UNDER the run's progress: the run is `generating` from the
// first moment (so the button is disabled), the pick's count rides on the progress line, a second
// press is refused, and a Stop pressed meanwhile is honoured when the pick returns.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { pickUnderProgress } from '@/store/generatePick';
import { useEngravePreviewStore } from '@/store/engravePreviewStore';
import { setEngraveRunClientLoader, useEngraveRunStore } from '@/store/engraveRunStore';
import { beforeEach as beforeEachSettled } from 'vitest';
import { settleShopSettings } from '../tools/settledShop';

// #1276 — Generate waits for / refuses without the shop's settings: these specs run with them settled.
beforeEachSettled(() => settleShopSettings());

/** A pick that settles when the test says so. */
function slowPick<T>(): { promise: Promise<T>; finish: (v: T) => void } {
  let finish!: (v: T) => void;
  const promise = new Promise<T>((resolve) => {
    finish = resolve;
  });
  return { promise, finish };
}

beforeEach(() => {
  useEngraveRunStore.getState().reset();
  useEngravePreviewStore.setState({ measuredProgress: null });
});
afterEach(() => useEngraveRunStore.getState().reset());

describe('#1270 — the pick is part of the press', () => {
  it('while the pick runs the run is generating, with a live progress line', async () => {
    const pick = slowPick<string>();
    const outcome = pickUnderProgress(() => pick.promise);
    const run = useEngraveRunStore.getState();
    expect(run.phase).toBe('generating');
    expect(run.progress?.label).toBe('choosing the cutter from your bits');
    // The pick's own count lands on the same line.
    useEngravePreviewStore.setState({ measuredProgress: { level: 'coarse', done: 3, total: 12 } });
    expect(useEngraveRunStore.getState().progress).toMatchObject({ label: 'choosing the cutter — candidate 3 of 12', done: 3, total: 12 });
    pick.finish('answer');
    expect(await outcome).toEqual({ started: true, cancelled: false, value: 'answer' });
  });

  it('a second press while the pick runs starts nothing', async () => {
    const pick = slowPick<string>();
    const first = pickUnderProgress(() => pick.promise);
    let called = 0;
    const second = await pickUnderProgress(async () => {
      called += 1;
      return 'x';
    });
    expect(second).toEqual({ started: false });
    expect(called).toBe(0);
    pick.finish('a');
    await first;
  });

  it('a Stop pressed during the pick is reported, and the press is not to carry on', async () => {
    const pick = slowPick<string>();
    const outcome = pickUnderProgress(() => pick.promise);
    useEngraveRunStore.getState().cancelGenerate();
    expect(useEngraveRunStore.getState().phase).toBe('idle');
    pick.finish('late');
    expect(await outcome).toEqual({ started: true, cancelled: true, value: 'late' });
  });

  it('a pick that throws ends the press: the run leaves generating and the error is said', async () => {
    const outcome = await pickUnderProgress(async () => {
      throw new Error('the worker could not measure');
    });
    expect(outcome).toMatchObject({ started: true, cancelled: true });
    const run = useEngraveRunStore.getState();
    expect(run.phase).toBe('blocked');
    expect(run.error).toBe('the worker could not measure');
    expect(run.progress).toBeNull();
    // …and the button is live again: a new press can start.
    expect(useEngraveRunStore.getState().beginPick()).not.toBeNull();
  });

  it('a Stop after the pick and the run lands where the press began (done → press → Stop → done)', async () => {
    setEngraveRunClientLoader(async () => ({ engraveGenerate: () => new Promise(() => {}) }) as never);
    try {
      useEngraveRunStore.setState({ phase: 'done' as never });
      const pick = slowPick<string>();
      const outcome = pickUnderProgress(() => pick.promise);
      pick.finish('x');
      await outcome;
      // The press carries on into the run, whose worker call never answers; the operator presses Stop.
      void useEngraveRunStore.getState().generate();
      await Promise.resolve();
      expect(useEngraveRunStore.getState().phase).toBe('generating');
      useEngraveRunStore.getState().cancelGenerate();
      expect(useEngraveRunStore.getState().phase).toBe('done');
    } finally {
      setEngraveRunClientLoader(null);
    }
  });

  it('the button reads as running: the run phase the panel keys on is generating', () => {
    const pick = slowPick<string>();
    void pickUnderProgress(() => pick.promise);
    const phase = useEngraveRunStore.getState().phase;
    expect(['generating', 'simulating', 'checking']).toContain(phase);
    pick.finish('x');
  });
});
