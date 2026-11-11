/**
 * #1030 — A SHORT JOIN'S RIDE TEST MUST LOOK BETWEEN ITS ENDPOINTS. `ridesTheCl` sampled a join
 * every `stepMm` with `steps = max(1, ceil(length / step))`: the ⌀6 finish's step (0.5 mm) gave a
 * 0.33 mm join ONE step — t = 0 and t = 1, both run endpoints that sit on the CL by construction —
 * so a chord across a CL crease was accepted unexamined. The organizer's 73 chords sat 0.011–0.014
 * mm under the exact CL that way (finishClOrganizer960, which skipped in every gate without the
 * card env).
 *
 * RED before the fix: the coarse-step case returns true (two samples). GREEN after: the ride test
 * insists on at least two intervals, and the caller floors the step at
 * `min(linkSampleStep, clSurface.maxSpacingMm, 0.05)` for the short joins.
 */
import { describe, expect, it } from 'vitest';

import { ridesTheCl } from '@/engine/cnc/cam/model/ops/finish';
import { followShortJoin } from '@/engine/cnc/cam/model/rideTest';
import type { ClSurface } from '@/engine/cnc/cam/model/clsurface';
import type { LinkPoint } from '@/engine/cnc/cam/model/linking';

/** A CL that bulges 0.02 mm up over the middle of a 0.33 mm join — a crease, not a surface. */
const CREASE: ClSurface = {
  dropCutter: (x: number) => (x > 0.08 && x < 0.25 ? 0 : -0.02),
  toleranceMm: 0.005,
  minSpacingMm: 0.05,
  minSpacingSource: 'derived',
  minSpacingFromStepOverMm: 0.5,
  maxSpacingMm: 0.1,
  sampleCount: 0,
};

/** A flat CL 5 mm long, at z = -1 — a straight ride that must keep passing. */
const FLAT: ClSurface = {
  dropCutter: () => -1,
  toleranceMm: 0.005,
  minSpacingMm: 0.05,
  minSpacingSource: 'derived',
  minSpacingFromStepOverMm: 0.5,
  maxSpacingMm: 0.1,
  sampleCount: 0,
};

const LINK_STEP = 0.5; // min(0.5, max(0.1, R/2)) for the ⌀6 finish

describe('#1030 — the ride test samples a short join’s interior', () => {
  const from: LinkPoint = { x: 0, y: 0, z: -0.02 };
  const to: LinkPoint = { x: 0.33, y: 0, z: -0.02 };

  it('refuses a 0.33 mm chord across a 0.02 mm crease at the coarse step (today: two samples, accepted)', () => {
    expect(ridesTheCl(from, to, CREASE, LINK_STEP)).toBe(false);
  });

  it('refuses it at the caller’s floored step too', () => {
    const step = Math.min(LINK_STEP, CREASE.maxSpacingMm, 0.05);
    expect(ridesTheCl(from, to, CREASE, step)).toBe(false);
  });

  it('still passes a 5 mm straight ride over a flat CL, and its sample count is the same as before', () => {
    const a: LinkPoint = { x: 0, y: 0, z: -1 };
    const b: LinkPoint = { x: 5, y: 0, z: -1 };
    const step = Math.min(LINK_STEP, FLAT.maxSpacingMm, 0.05);
    expect(ridesTheCl(a, b, FLAT, step)).toBe(true);
    // The flat ride's own sampling is unchanged: ceil(5 / 0.05) = 100 intervals (101 samples).
    let calls = 0;
    const counting: ClSurface = { ...FLAT, dropCutter: () => { calls++; return -1; } };
    expect(ridesTheCl(a, b, counting, step)).toBe(true);
    expect(calls).toBe(101);
  });

  it('refuses a ride whose endpoint leaves the CL surface (a null is a retract)', () => {
    const hole: ClSurface = { ...FLAT, dropCutter: (x: number) => (x > 2 && x < 3 ? null : -1) };
    const a: LinkPoint = { x: 0, y: 0, z: -1 };
    const b: LinkPoint = { x: 5, y: 0, z: -1 };
    expect(ridesTheCl(a, b, hole, Math.min(LINK_STEP, hole.maxSpacingMm, 0.05))).toBe(false);
  });

  it('a refused short join is FED along the sampled CL, never retracted (the manager’s ruling)', () => {
    // The crease above: the chord is refused at 0.5, and the short join follows the CL instead —
    // interior points on the CL, about zero seconds, no rapid.
    const moves = followShortJoin(from, to, (x) => CREASE.dropCutter(x, 0), -1, 0.05, { feedMmPerMin: 500, plungeFeedMmPerMin: 200 }, 0.1, 3);
    expect(moves).not.toBeNull();
    expect(moves!.length).toBeGreaterThan(2); // more than one straight chord
    for (const m of moves!) {
      // Every feed point sits ON the CL (the crease included), never below it.
      const cl = CREASE.dropCutter(m.x, 0)!;
      expect(m.z).toBeGreaterThanOrEqual(Math.max(cl, -1) - 1e-9);
    }
    // The join's own end is the last point.
    const last = moves![moves!.length - 1]!;
    expect(last.x).toBeCloseTo(to.x, 9);
    expect(last.z).toBeCloseTo(to.z, 9);
  });

  it('a join whose CL climbs like a wall keeps the retract (followShortJoin refuses it)', () => {
    const wall: ClSurface = { ...CREASE, dropCutter: (x: number) => (x > 0.1 && x < 0.23 ? 0.5 : -0.02) };
    const moves = followShortJoin({ x: 0, y: 0, z: -0.02 }, { x: 0.33, y: 0, z: -0.02 }, (x) => wall.dropCutter(x, 0), -1, 0.05, { feedMmPerMin: 500, plungeFeedMmPerMin: 200 }, 0.1, 3);
    expect(moves).toBeNull();
  });

  it('an interrupted CL keeps the retract (followShortJoin refuses it)', () => {
    const hole: ClSurface = { ...CREASE, dropCutter: (x: number) => (x > 0.1 && x < 0.23 ? null : -0.02) };
    const moves = followShortJoin({ x: 0, y: 0, z: -0.02 }, { x: 0.33, y: 0, z: -0.02 }, (x) => hole.dropCutter(x, 0), -1, 0.05, { feedMmPerMin: 500, plungeFeedMmPerMin: 200 }, 0.1, 3);
    expect(moves).toBeNull();
  });
});
