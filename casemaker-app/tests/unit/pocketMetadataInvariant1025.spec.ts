/**
 * #1025 — THE PLAN'S POCKET METADATA IS GUARDED IN THE PRODUCT, NOT ONLY IN THE CARDS.
 *
 * The organizer card once showed thirteen pocket ops carrying another pocket's `depth` and
 * `estimatedSeconds` while posting their own moves (the card pin `expectOwnPocketDepths` guards
 * the tests). A long-lived worker planning several jobs is exactly the firing condition, so the
 * same invariant runs in `planModelCam`'s pocket-chain assembly: a violation throws a named
 * error the plan's step catch states, never a silently posted program.
 *
 * RED at the pre-guard tree: the assert does not exist. The corrupt op below is the card's exact
 * shape — pocket-54's own 22 passes and 353 moves, with pocket-15's 3.0 mm depth and 666.265 s.
 */
import { describe, expect, it } from 'vitest';

import { estimateCycleSeconds, type CamMove } from '@/engine/cnc/cam/ir';
import { Z1 } from '@/engine/cnc/machine';
import { assertOwnPocketMetadata } from '@/engine/cnc/cam/model/planMeta';

const RAPID = Z1.rapidEstimate;

/** 353 feed moves over a short path — enough for a real estimate. */
const MOVES: CamMove[] = Array.from({ length: 353 }, (_, i) => ({
  kind: 'feed' as const,
  x: (i % 17) * 0.5,
  y: Math.floor(i / 17) * 0.5,
  z: -22 + (i % 3) * 0.1,
  f: 800,
}));

const own = estimateCycleSeconds(MOVES, RAPID);

const op = (over: Partial<{ depth: number; depthPasses: number; passStepMm: number; estimatedSeconds: number }>) => ({
  number: 1,
  name: '[T1] Pocket "pocket-54"',
  labelId: 'pocket-54',
  depth: 21.999998,
  depthPasses: 22,
  passStepMm: 1,
  moves: MOVES,
  estimatedSeconds: own,
  ...over,
});

describe('#1025 — the plan names corrupt pocket metadata instead of posting it', () => {
  it('a depth that cannot reach its own passes is named', () => {
    expect(() => assertOwnPocketMetadata('test', 'pocket-54', [op({ depth: 2.999999, estimatedSeconds: 666.265 })], RAPID))
      .toThrow(/plan metadata inconsistent: pocket-54/);
  });

  it('an estimate that is not its own moves is named', () => {
    expect(() => assertOwnPocketMetadata('test', 'pocket-54', [op({ estimatedSeconds: own + 500 })], RAPID))
      .toThrow(/plan metadata inconsistent: pocket-54/);
  });

  it('an op whose own passes and estimate agree passes', () => {
    expect(() => assertOwnPocketMetadata('test', 'pocket-54', [op({})], RAPID)).not.toThrow();
  });
});
