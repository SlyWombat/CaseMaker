/**
 * #962 — THE SKIM'S RIDE TEST, RED-FIRST (B's review of e3f25fc7).
 *
 * The skim's ride test approved a stay-down link on its CENTRE samples alone, with no length cap —
 * unlike the finish's `ridesTheCl`, which gates on Kiri:Moto's short hop. Every ride the real
 * organizer takes today is one diagonal grid step (0.5–0.71 mm), so nothing bit; a longer ride
 * over a cut band would have been approved purely on its centre samples. The cap is now inside
 * `skimRides`, and this case pins both directions: with the cap the long ride refuses, without
 * one (the old behaviour) it was approved.
 */

import { describe, expect, it } from 'vitest';

import { skimRides } from '../../src/engine/cnc/cam/model/ops/rough';

const TOL = 0.005;
const PITCH = 0.5;
const SHORT_HOP = 12; // Kiri's 2 x diameter, for a ⌀6 cutter

/** A cut band at z = 0 along the whole path. */
const bandTop = (): number | null => 0;

describe("#962 — the skim's ride test carries Kiri's short hop", () => {
  it("B's finding: a 20 mm ride over a cut band refuses; without a cap it was approved", () => {
    expect(skimRides([0, 0, 0], [20, 0, 0], bandTop, TOL, SHORT_HOP, PITCH)).toBe(false);
    // The cap is the thing that refuses it — the old test (no cap) said yes at any length.
    expect(skimRides([0, 0, 0], [20, 0, 0], bandTop, TOL, Number.POSITIVE_INFINITY, PITCH)).toBe(true);
  });

  it('a ride within the hop over the same band is approved', () => {
    expect(skimRides([0, 0, 0], [0.5, 0, 0], bandTop, TOL, SHORT_HOP, PITCH)).toBe(true);
  });

  it('a ride whose path leaves the band is refused', () => {
    expect(skimRides([0, 0, 0], [0.5, 0, 0], () => null, TOL, SHORT_HOP, PITCH)).toBe(false);
  });

  it('a ride below the band top is refused', () => {
    expect(skimRides([0, 0, -0.1], [0.5, 0, -0.1], bandTop, TOL, SHORT_HOP, PITCH)).toBe(false);
  });
});
