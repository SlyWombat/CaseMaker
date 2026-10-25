// #634/#653 — the surface-frame un-lift's own rules, against hand-built timelines.
//
// `unliftTimeline` re-buckets a lifted program into the surface frame (the exact inverse of
// `applySurfaceLift`) and carries the posted frame beside it for the checks that judge unsheared
// geometry. Two of its rules are pinned here because they are invisible end to end: the grouping
// window is measured from a run's FIRST level (not the running minimum, which let a descending 1 µm
// staircase chain without bound), and every air move keeps its POSTED coordinates — the bed and the
// fixtures are not sheared, so the machine's real path is what they must be judged against.

import { describe, expect, it } from 'vitest';

import { unliftTimeline } from '@/workers/geometry/sweep';
import type { AirMove, Checkpoint, Timeline } from '@/engine/cnc/emulator/timeline';
import type { SurfaceFrame } from '@/engine/cnc/engrave/surfacePlane';

const FLAT: SurfaceFrame = { plane: { offset: 0, slopeX: 0, slopeY: 0 }, z0: 0 };
/** 0.01 mm of lift per mm of X: 0.1 mm at x = 10, 0.2 at x = 20. */
const TILT: SurfaceFrame = { plane: { offset: 0, slopeX: 0.01, slopeY: 0 }, z0: 0 };

function timeline(checkpoints: Checkpoint[], airMoves: AirMove[] = []): Timeline {
  return {
    events: [],
    airMoves,
    segments: [],
    pauses: [],
    checkpoints,
    diagnostics: [],
    stateAt: () => ({}) as never,
    summary: {
      steps: 0,
      segments: 0,
      pauses: 0,
      checkpoints: checkpoints.length,
      cuttingMoves: 0,
      unsweptMoves: 0,
      airMoves: airMoves.length,
      laser: false,
      rotary: false,
      diagnosticCounts: {},
    },
  };
}

/** One checkpoint of level XY moves, one at each of `levels`, in program order. */
function ladder(levels: number[]): Checkpoint {
  const zs: number[] = [];
  const xy: number[] = [];
  const steps: number[] = [];
  levels.forEach((z, i) => {
    zs.push(z, z);
    xy.push(i * 10, 0, (i + 1) * 10, 0);
    steps.push(i);
  });
  return {
    segment: 0,
    tool: 1,
    zKey: Math.round(Math.min(...levels) * 1000),
    z: Math.min(...levels),
    run: 0,
    zs,
    steps,
    xy,
    nonConstantZ: false,
  };
}

describe('#653 the un-lift’s grouping', () => {
  it('starts a new run when a descending staircase leaves the window from its FIRST level', () => {
    // Each move is 1 µm below the last — within one quantum of its predecessor, which is exactly
    // the chain the running-minimum rule could never break: it folded all six into one bucket
    // extruded from the lowest, with `nonConstantZ` false and no ramp over the material between.
    const out = unliftTimeline(timeline([ladder([0, -0.001, -0.002, -0.003, -0.004, -0.005])]), FLAT);
    expect(out.checkpoints.map((cp) => cp.steps.length)).toEqual([2, 2, 2]);
    // Every run spans at most the 1.5-quanta window from the level it started at.
    for (const cp of out.checkpoints) {
      const start = cp.zs[0] as number;
      for (const z of cp.zs) expect(Math.abs(z - start)).toBeLessThanOrEqual(0.0015);
    }
  });

  it('still folds a run of moves that only differ by the posted text’s rounding', () => {
    // The #634 case the window exists for: a level feed whose ends differ by the 3-dp residual.
    const cp = ladder([0, -0.001]);
    cp.zs = [0, 0.0004, -0.001, -0.0006];
    const out = unliftTimeline(timeline([cp]), FLAT);
    expect(out.checkpoints).toHaveLength(1);
    expect(out.checkpoints[0]!.nonConstantZ).toBe(false);
  });
});

describe('#653 the un-lift keeps the posted frame for unsheared geometry', () => {
  it('un-lifts an air move AND keeps its posted coordinates beside it', () => {
    const air: AirMove = { step: 1, line: 5, kind: 'rapid', from: [10, 0, 2], to: [20, 0, 2] };
    const out = unliftTimeline(timeline([], [air]), TILT);
    // The image the removal is compared against…
    expect(out.airMoves[0]!.from).toEqual([10, 0, 1.9]);
    expect(out.airMoves[0]!.to).toEqual([20, 0, 1.8]);
    // …and the motion the machine really makes, for the bed, the fixtures and the proximity rule.
    expect(out.airMoves[0]!.lifted).toEqual({ from: [10, 0, 2], to: [20, 0, 2] });
  });
});
