/**
 * #1068-perf — THE FIXTURE'S BOX GATE, RED-FIRST.
 *
 * The exact sweeper's per-move fixture check is a Manifold boolean (`sweptToolBody` intersected
 * with the fixture union). With the CLI now handing bracket jobs their fixture (#1068), every air
 * move of a long bracket job paid one — tens of thousands per sweep — and once the shared manifold
 * runtime has grown, those booleans crawl (j25 blocks for more than twenty minutes in the
 * `benchTypicalJobs` sequence). A move whose own swept box clears every pre-inflated fixture box
 * cannot hit it, so the boolean is skipped; only moves near a box pay.
 *
 * The pass reports its own count (`fixtureBooleans`), which is what these pin: zero for a fixture
 * far from the path, and the exact check still running (and still refusing) when a box is over it.
 */

import { describe, expect, it } from 'vitest';

import { tl } from './helpers/manifoldExec';
import { checkAirMoves, columnFixtureHit } from '@/workers/geometry/sweep';
import type { ObstacleBox } from '@/engine/cnc/setup';

const box = (min: [number, number, number], max: [number, number, number], id = 'clamp'): ObstacleBox => ({
  id,
  label: 'the clamp on the back edge',
  min,
  max,
});

const MOVE = [
  { line: 1, kind: 'rapid' as const, from: [0, 0, 1] as [number, number, number], to: [5, 0, 1] as [number, number, number], step: 0 },
];

describe('#1068-perf the fixture box gate', () => {
  it('skips the fixture boolean for a move whose swept box clears every fixture box', () => {
    const stock = tl.Manifold.cube([20, 20, 10], true).translate([0, 0, -5]);
    const farBox = box([98, -3, 1], [103, 3, 4], 'far');
    const fixture = tl.Manifold.cube([5, 6, 3], true).translate([100.5, 0, 2.5]);
    const pushed: ReturnType<typeof checkAirMoves>['diagnostics'] = [];
    const air = checkAirMoves(tl, stock, 0, -10, MOVE, [], 1, null, fixture, 2, (d) => pushed.push(d), 0, undefined, undefined, [farBox]);
    expect(air.fixtureBooleans, 'a fixture far from the move still paid an exact boolean').toBe(0);
    expect(pushed.some((d) => d.code === 'rapid-into-fixture')).toBe(false);
    fixture.delete();
    stock.delete();
  });

  it('still pays it, and still refuses, when the box is over the move', () => {
    const stock = tl.Manifold.cube([20, 20, 10], true).translate([0, 0, -5]);
    const nearBox = box([-3, -3, 1], [8, 3, 4], 'near');
    const fixture = tl.Manifold.cube([11, 6, 3], true).translate([2.5, 0, 2.5]);
    const pushed: ReturnType<typeof checkAirMoves>['diagnostics'] = [];
    const air = checkAirMoves(tl, stock, 0, -10, MOVE, [], 1, null, fixture, 2, (d) => pushed.push(d), 0, undefined, undefined, [nearBox]);
    expect(air.fixtureBooleans).toBeGreaterThan(0);
    expect(pushed.some((d) => d.code === 'rapid-into-fixture')).toBe(true);
    fixture.delete();
    stock.delete();
  });

  it('the gate is the column engine’s own predicate, not a second rule', () => {
    const boxes = [box([0, 0, 0], [10, 10, 5])];
    expect(columnFixtureHit([0, 0], [5, 0], 1, 1, 2, boxes)).not.toBeNull();
    expect(columnFixtureHit([50, 50], [55, 50], 1, 1, 2, boxes)).toBeNull();
  });
});
