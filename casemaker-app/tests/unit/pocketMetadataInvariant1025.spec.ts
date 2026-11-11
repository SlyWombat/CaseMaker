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

import { estimateCycleSeconds, type CamMove, type RapidEstimate } from '@/engine/cnc/cam/ir';
import { Z1 } from '@/engine/cnc/machine';
import { assertOwnPocketMetadata, PlanMetadataInconsistentError } from '@/engine/cnc/cam/model/planMeta';
import { planPocketsForTree } from '@/engine/cnc/cam/model/plan';
import type { FeatureTree, PocketNode } from '@/engine/cnc/cam/model/features';
import { makeClipperOffset } from '@/engine/cnc/cam/engraveJob';
import { flatEndMill } from '@/engine/cnc/tool';
import { tl } from './helpers/manifoldExec';

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
      .toThrow(PlanMetadataInconsistentError);
    expect(() => assertOwnPocketMetadata('test', 'pocket-54', [op({ depth: 2.999999, estimatedSeconds: 666.265 })], RAPID))
      .toThrow(/plan metadata inconsistent: pocket-54/);
  });

  it('an estimate that is not its own moves is named', () => {
    expect(() => assertOwnPocketMetadata('test', 'pocket-54', [op({ estimatedSeconds: own + 500 })], RAPID))
      .toThrow(PlanMetadataInconsistentError);
    expect(() => assertOwnPocketMetadata('test', 'pocket-54', [op({ estimatedSeconds: own + 500 })], RAPID))
      .toThrow(/plan metadata inconsistent: pocket-54/);
  });

  it('the sentence tells the operator what to do about it', () => {
    let thrown: unknown = null;
    try {
      assertOwnPocketMetadata('test', 'pocket-54', [op({ estimatedSeconds: own + 500 })], RAPID);
    } catch (err) {
      thrown = err;
    }
    expect((thrown as Error).message).toMatch(/Re-run Generate; if it recurs, keep the plan dump and the command and attach them to #1025/);
  });

  it('an op whose own passes and estimate agree passes', () => {
    expect(() => assertOwnPocketMetadata('test', 'pocket-54', [op({})], RAPID)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------------------------
// THE WHOLE PLAN REFUSES, NEVER A DROPPED REGION (the review's ruling on 89a83dbdf)
// ---------------------------------------------------------------------------------------------

const CHAIN_RAPID: RapidEstimate = { xyMmPerMin: 1200, zMmPerMin: 600, accelMmPerS2: 150, source: 'test fixture' };
const FLAT = flatEndMill(6, { number: 1, id: 'flat-6', name: 'flat-6', fluteLength: 30 });

/**
 * A 30×14 part, part top at 0, TWO 12×8 pockets 3 mm deep — two regions in the same primary
 * step, so the at-89a83dbdf behaviour is the one the review names: the corrupt region is dropped
 * and the OTHER pocket still posts.
 */
function twoPocketTree(): FeatureTree {
  const rect: [number, number][][] = [[[0, 0], [30, 0], [30, 14], [0, 14]]];
  const pocket = (id: string, x0: number): PocketNode => {
    const region: [number, number][][] = [[[x0, 0], [x0 + 12, 0], [x0 + 12, 8], [x0, 8]]];
    return {
      id, floorZ: -3, mouthZ: 0, open: false, through: false,
      region, floors: [{ polygons: region, area: 96 }],
      islands: [], children: [], remainder: [], narrowest: 8,
    };
  };
  return {
    frame: { up: [0, 0, 1], stockTop: 0, partTop: 0, partBottom: -3 },
    levels: [-3],
    top: { z: 0, floors: [], area: 0 },
    contour: { outline: rect, area: 420, zTo: -3, frees: true, shoulders: [] },
    pockets: [pocket('pocket-1', 0), pocket('pocket-2', 16)],
    rims: [],
    remainder: [],
    unreachable: [],
    report: { source: 'mesh', patches: 1, planarArea: 420, remainderArea: 0, tolerances: {} as never, slivers: [], notes: [] },
  };
}

describe('#1025 — a corrupt record refuses the whole plan, never a dropped region', () => {
  it('planPocketsForTree refuses with the named sentence when the chain is handed a corrupt pocket op', () => {
    let corrupted = false;
    let thrown: unknown = null;
    try {
      planPocketsForTree(twoPocketTree(), {
        offset: makeClipperOffset(tl),
        houseFlats: [FLAT],
        stepDownMm: 1,
        feeds: { feedMmPerMin: 1000, plungeFeedMmPerMin: 300 },
        rapid: CHAIN_RAPID,
        toolChangeSeconds: 91.4,
        spindleRpm: 12000,
        air: true,
        // The spec seam: the first live pocket op comes back with the card's own fault — a depth
        // that cannot reach its passes and an estimate that is not its moves' — and then takes
        // exactly the path the real 89a83dbdf firing takes through the chain.
        planRegionForTest: (outcome, id) => {
          if (outcome === null || corrupted || id !== 'pocket-1') return outcome;
          // The pocket's own op is the one carrying depth passes; the id gate keeps the contour
          // (which also declares passes) out of this test's way.
          const pocketOp = outcome.ir.operations.find((operation) => operation.depthPasses !== undefined);
          if (pocketOp === undefined) return outcome;
          corrupted = true;
          return {
            ...outcome,
            ir: {
              ...outcome.ir,
              operations: outcome.ir.operations.map((operation) =>
                operation === pocketOp
                  ? {
                      ...operation,
                      depth: Math.max(0, (operation.depthPasses! - 1) * (operation.passStepMm ?? 0) - 1),
                      estimatedSeconds: operation.estimatedSeconds + 500,
                    }
                  : operation,
              ),
            },
          };
        },
      });
    } catch (err) {
      thrown = err;
    }
    // At 89a83dbdf this call RETURNED a plan with the corrupt region dropped from the post; the
    // ruling is that the fault refuses the whole plan at every site.
    expect(thrown, 'the plan must refuse, not return with the region dropped').toBeInstanceOf(PlanMetadataInconsistentError);
    expect((thrown as Error).message).toMatch(/plan metadata inconsistent: pocket-1 \(pocket chain\)/);
    expect((thrown as Error).message).toMatch(/Re-run Generate; if it recurs, keep the plan dump and the command and attach them to #1025/);
  });
});
