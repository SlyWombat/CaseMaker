/**
 * #1068-perf — THE FIXTURE'S EXACT STADIUM TEST, RED-FIRST (6b's ruling).
 *
 * The exact sweeper used to intersect every air move's tool body with the fixture union — one
 * Manifold boolean per move. The CLI now hands bracket jobs their fixture (#1068), the fixture's
 * boxes stand along the blank's free edges and the cuts run those edges, so nearly every move paid
 * one; on the shared manifold runtime those booleans crawl (the puck: 862 s against 3.9 s without a
 * fixture). The replacement is closed-form: the cutter is a vertical cylinder of radius r, a
 * straight move sweeps a stadium in XY (its segment grown by r), and a hit is the 2D
 * segment-to-rectangle distance below r with the Z intervals overlapping. The volume is the
 * box-overlap bound, labelled so in the message.
 */

import { describe, expect, it } from 'vitest';

import { tl } from './helpers/manifoldExec';
import { checkAirMoves, columnFixtureHit, fixtureStadiumHit } from '@/workers/geometry/sweep';
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

describe('#1068-perf the fixture stadium test', () => {
  it('skips the exact boolean for a move whose stadium clears every fixture box', () => {
    const stock = tl.Manifold.cube([20, 20, 10], true).translate([0, 0, -5]);
    const farBox = box([98, -3, 1], [103, 3, 4], 'far');
    const fixture = tl.Manifold.cube([5, 6, 3], true).translate([100.5, 0, 2.5]);
    const pushed: ReturnType<typeof checkAirMoves>['diagnostics'] = [];
    const air = checkAirMoves(tl, stock, 0, -10, MOVE, [], 1, null, fixture, 2, (d) => pushed.push(d), 0, undefined, undefined, [farBox]);
    expect(air.fixtureBooleans, 'the box path must run no exact boolean').toBe(0);
    expect(pushed.some((d) => d.code === 'rapid-into-fixture')).toBe(false);
    fixture.delete();
    stock.delete();
  });

  it('still refuses when the box is over the move, with no boolean either', () => {
    const stock = tl.Manifold.cube([20, 20, 10], true).translate([0, 0, -5]);
    const nearBox = box([-3, -3, 1], [8, 3, 4], 'near');
    const fixture = tl.Manifold.cube([11, 6, 3], true).translate([2.5, 0, 2.5]);
    const pushed: ReturnType<typeof checkAirMoves>['diagnostics'] = [];
    const air = checkAirMoves(tl, stock, 0, -10, MOVE, [], 1, null, fixture, 2, (d) => pushed.push(d), 0, undefined, undefined, [nearBox]);
    expect(air.fixtureBooleans).toBe(0);
    const hit = pushed.find((d) => d.code === 'rapid-into-fixture');
    expect(hit).toBeDefined();
    expect(hit!.message).toContain('(an upper bound)');
    fixture.delete();
    stock.delete();
  });

  it('a caller that passes only the union keeps the exact boolean', () => {
    const stock = tl.Manifold.cube([20, 20, 10], true).translate([0, 0, -5]);
    const fixture = tl.Manifold.cube([11, 6, 3], true).translate([2.5, 0, 2.5]);
    const air = checkAirMoves(tl, stock, 0, -10, MOVE, [], 1, null, fixture, 2, () => {}, 0, undefined, undefined);
    expect(air.fixtureBooleans).toBeGreaterThan(0);
    fixture.delete();
    stock.delete();
  });

  it('a diagonal pass clearing a clamp corner by 0.1 mm is NOT a hit; grazing it by 0.1 IS', () => {
    const corner = box([0, 0, 0], [10, 10, 10], 'corner');
    const radius = 0.5;
    // The 45° line x + y = d passes the (0,0) corner at distance |d| / sqrt(2); with d negative it
    // lies outside the box on both sides of the corner.
    const pass = (clearance: number) => {
      const d = -(radius + clearance) * Math.SQRT2;
      return fixtureStadiumHit([-5, d + 5, 5], [d + 5, -5, 5], radius, 0, 10, [corner]);
    };
    expect(pass(0.1), 'a pass 0.1 mm outside the radius was reported as a hit').toBeNull();
    expect(pass(-0.1), 'a pass 0.1 mm inside the radius was not reported').not.toBeNull();
  });

  it('a move that drives THROUGH the box with both endpoints outside is a hit (6b’s read)', () => {
    const b = box([0, 0, 0], [10, 10, 10], 'through');
    // (−5,5) → (15,5), r = 1: both endpoints are 5 mm from the rectangle, but the cutter drives
    // straight through the clamp.
    const through = fixtureStadiumHit([-5, 5, 5], [15, 5, 5], 1, 0, 10, [b]);
    expect(through, 'a through-drive was reported as clear').not.toBeNull();
    expect(through!.box.id).toBe('through');
    // The same move one clamp-width away at Y = 12 is clear.
    expect(fixtureStadiumHit([-5, 12, 5], [15, 12, 5], 1, 0, 10, [b])).toBeNull();
    // A move ending inside the box is a hit too.
    expect(fixtureStadiumHit([-5, 5, 5], [5, 5, 5], 1, 0, 10, [b])).not.toBeNull();
  });

  it('the through-drive reaches the sweep as a refusal with the upper-bound message', () => {
    const stock = tl.Manifold.cube([20, 20, 10], true).translate([0, 0, -5]);
    const throughBox = box([0, 0, 1], [10, 10, 4], 'through');
    const fixture = tl.Manifold.cube([10, 10, 3], true).translate([5, 5, 2.5]);
    const moves = [{ line: 7, kind: 'rapid' as const, from: [-5, 5, 1] as [number, number, number], to: [15, 5, 1] as [number, number, number], step: 0 }];
    const pushed: ReturnType<typeof checkAirMoves>['diagnostics'] = [];
    checkAirMoves(tl, stock, 0, -10, moves, [], 1, null, fixture, 2, (d) => pushed.push(d), 0, undefined, undefined, [throughBox]);
    const hit = pushed.find((d) => d.code === 'rapid-into-fixture');
    expect(hit).toBeDefined();
    expect(hit!.message).toContain('(an upper bound)');
    fixture.delete();
    stock.delete();
  });

  it('the reported volume is the box-overlap bound the column engine states', () => {
    const b = box([0, 0, 0], [4, 4, 4]);
    const hit = fixtureStadiumHit([-1, 2, 1], [5, 2, 1], 1, 0, 4, [b]);
    expect(hit).not.toBeNull();
    // the move's 6×1 bounding strip grown by 1 each side, clipped to 4×4, over the 3 mm Z overlap
    expect(hit!.volume).toBeGreaterThan(0);
    expect(hit!.box.id).toBe('clamp');
    expect(columnFixtureHit([-1, 2], [5, 2], 1, 1, 4, [b])!.volume).toBeGreaterThanOrEqual(hit!.volume - 1e-9);
  });
});
