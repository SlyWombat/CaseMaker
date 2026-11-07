/**
 * #1001 — THE SKIM'S JOIN IS PROVED ON THE EXACT CL, NOT THE GRID'S CENTRE LINE. The two proofs
 * side by side on the measured class: a join across a slope whose GRID samples all agree
 * (`ridesCutSurface` passes) while the exact cutter height rises between those samples
 * (`pathClClear` fails). At the base the skim consulted `pathClClear` only for the ball fallback,
 * so the flat's join rode the chord through the rise — the organizer STL row's (57.1, 99.8) cell,
 * 0.186 mm under a ⌀6 flat. The op-level red is that row (3.97e-5 adjudicated before, 0 after);
 * this pins the discriminator the join now consults for every cutter.
 */
import { describe, expect, it } from 'vitest';

import { pathClClear } from '@/engine/cnc/cam/model/linking';
import { ridesCutSurface } from '@/engine/cnc/cam/model/rideTest';

const PITCH = 0.5;
const TOL = 0.005;
const SHORT_HOP = 12; // Kiri's 2 x diameter, ⌀6

describe('#1001 the skim join proves the exact CL', () => {
  it('a 20° descending join: the grid proof passes, the exact proof catches the rise between its samples', () => {
    // The join descends 0.4 mm over 2 mm of XY (≈ 11°) along y = 0; the grid's own samples read a
    // plane (z = −0.2x), so every centre-line sample is at or below the chord: the old proof rides.
    const from = { x: 0, y: 0, z: 0 };
    const to = { x: 2, y: 0, z: -0.4 };
    const gridTop = (x: number): number => -0.2 * x;
    expect(ridesCutSurface(from, to, gridTop, TOL, SHORT_HOP, PITCH)).toBe(true);
    // The exact CL adds a 0.15 mm rise centred between the grid samples (x = 0.25): the cutter
    // would cut into it on the chord, and the exact proof — sampled at pitch/4 = 0.125 — refuses.
    const exactTop = (x: number): number => -0.2 * x + 0.15 * Math.exp(-(((x - 0.25) / 0.06) ** 2));
    expect(pathClClear(from, to, exactTop, Math.max(PITCH / 4, 0.05), TOL)).toBe(false);
    // With the rise absent the exact proof agrees with the grid: the same join rides.
    expect(pathClClear(from, to, gridTop, Math.max(PITCH / 4, 0.05), TOL)).toBe(true);
  });

  it('the proof reads the Z at each SAMPLE, not at the start: a rise near the join’s far end still refuses', () => {
    // The chord descends 0 → −0.4; a 0.15 mm rise centred at x = 1.9 sits above the chord there.
    // A proof that compared against the START's z (0) would pass the whole join; the interpolated
    // sample z (−0.375 at x = 1.875) catches it.
    const from = { x: 0, y: 0, z: 0 };
    const to = { x: 2, y: 0, z: -0.4 };
    const farRise = (x: number): number => -0.2 * x + 0.15 * Math.exp(-(((x - 1.9) / 0.06) ** 2));
    expect(farRise(0)).toBeLessThanOrEqual(from.z + TOL); // the start alone would have said "clear"
    expect(pathClClear(from, to, farRise, Math.max(PITCH / 4, 0.05), TOL)).toBe(false);
  });
});
