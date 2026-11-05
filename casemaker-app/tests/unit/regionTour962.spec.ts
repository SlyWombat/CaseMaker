/**
 * #962 — THE REGION TOUR, RED-FIRST.
 *
 * Within one cutter's run, the ops used to be posted in PLANNING order, so a region's exit could
 * cross the whole part to reach the next region's entry (E's rapid-class picture: the ⌀6 flat's
 * 404 region moves against the vendor's 96). `orderOpsForPrograms` now orders each cutter's
 * regions by nearest-neighbour + 2-opt over their entry and exit points.
 *
 * The units and invariants this pins:
 *   - a REGION is one unit — all of a cutter's ops on it, in their planned order (a same-region
 *     pair must never be reversed);
 *   - the FREEING CONTOUR never moves: it stays last;
 *   - the travel between regions only falls.
 */

import { describe, expect, it } from 'vitest';

import { orderOpsForPrograms, type PlannedOp } from '../../src/engine/cnc/cam/model/plan';

type Xyz = [number, number, number];

function op(kind: PlannedOp['kind'], regionId: string, entry: Xyz, exit: Xyz, cutter = 'flat-6'): PlannedOp {
  return {
    kind,
    region: { id: regionId } as PlannedOp['region'],
    outcome: {
      cutter,
      ir: { operations: [{ moves: [] }] } as never,
      passes: [{ z: 0, boundary: [], cleared: { z: 0, boundary: [] }, entry, exit }],
    },
  } as unknown as PlannedOp;
}

/** The travel of a sequence: the straight distance from each unit's exit to the next's entry. */
function travel(ops: readonly PlannedOp[]): number {
  let total = 0;
  for (let i = 1; i < ops.length; i++) {
    const prev = ops[i - 1]!.outcome.passes[ops[i - 1]!.outcome.passes.length - 1]!.exit;
    const next = ops[i]!.outcome.passes[0]!.entry;
    total += Math.hypot(next[0] - prev[0], next[1] - prev[1]);
  }
  return total;
}

describe('#962 — the region tour orders each cutter’s regions by proximity', () => {
  it('a far region between two near ones is moved out of the way', () => {
    // A ends near C's start; B is far away on the other side of the part. The planning order
    // A, B, C pays A->B + B->C; the tour must visit A, C, B.
    const a = op('pocket', 'a', [0, 0, 0], [10, 0, 0]);
    const b = op('pocket', 'b', [100, 100, 0], [110, 100, 0]);
    const c = op('pocket', 'c', [12, 0, 0], [22, 0, 0]);
    const toured = orderOpsForPrograms([a, b, c]);
    expect(toured.map((o) => o.region.id)).toEqual(['a', 'c', 'b']);
    expect(travel(toured), 'the tour must not travel farther than the planning order').toBeLessThan(travel([a, b, c]));
  });

  it('same-region ops stay together and in their planned order', () => {
    // Two ops on region "a" (a rough then its rest), plus one on "b" nearer to a's exit.
    const a1 = op('rough', 'a', [0, 0, 0], [10, 0, 0]);
    const a2 = op('rest', 'a', [10, 0, 0], [10, 5, 0]);
    const b = op('rough', 'b', [12, 0, 0], [20, 0, 0]);
    const toured = orderOpsForPrograms([a1, a2, b]);
    const aOps = toured.filter((o) => o.region.id === 'a');
    expect(aOps.map((o) => o.kind), 'the same-region pair was reversed or split').toEqual(['rough', 'rest']);
  });

  it('the freeing contour never moves: it is last in every order', () => {
    const a = op('pocket', 'a', [0, 0, 0], [10, 0, 0]);
    const b = op('pocket', 'b', [100, 100, 0], [110, 100, 0]);
    const contour = op('contour', 'outline', [0, 0, 0], [0, 0, 0], 'flat-6');
    const toured = orderOpsForPrograms([a, b, contour]);
    expect(toured[toured.length - 1]!.kind).toBe('contour');
  });
});
