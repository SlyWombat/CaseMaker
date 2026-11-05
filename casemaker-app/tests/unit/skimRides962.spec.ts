/**
 * #962 — THE SKIM'S RIDE TEST, RED-FIRST (B's review of e3f25fc7).
 *
 * The skim's ride test approved a stay-down link on its CENTRE samples alone, with no length cap —
 * unlike the finish's `ridesTheCl`, which gates on Kiri:Moto's short hop. Every ride the real
 * organizer takes today is one diagonal grid step (0.5–0.71 mm), so nothing bit; a longer ride
 * over a cut band would have been approved purely on its centre samples. The cap is now inside
 * `ridesCutSurface`, and this case pins both directions: with the cap the long ride refuses, without
 * one (the old behaviour) it was approved.
 */

import { describe, expect, it } from 'vitest';

import { ridesCutSurface } from '../../src/engine/cnc/cam/model/rideTest';

const TOL = 0.005;
const PITCH = 0.5;
const SHORT_HOP = 12; // Kiri's 2 x diameter, for a ⌀6 cutter

/** A cut band at z = 0 along the whole path. */
const bandTop = (): number | null => 0;

describe("#962 — the skim's ride test carries Kiri's short hop", () => {
  it("B's finding: a 20 mm ride over a cut band refuses; without a cap it was approved", () => {
    expect(ridesCutSurface({ x: 0, y: 0, z: 0 }, { x: 20, y: 0, z: 0 }, bandTop, TOL, SHORT_HOP, PITCH)).toBe(false);
    // The cap is the thing that refuses it — the old test (no cap) said yes at any length.
    expect(ridesCutSurface({ x: 0, y: 0, z: 0 }, { x: 20, y: 0, z: 0 }, bandTop, TOL, Number.POSITIVE_INFINITY, PITCH)).toBe(true);
  });

  it('a ride within the hop over the same band is approved', () => {
    expect(ridesCutSurface({ x: 0, y: 0, z: 0 }, { x: 0.5, y: 0, z: 0 }, bandTop, TOL, SHORT_HOP, PITCH)).toBe(true);
  });

  it('a ride whose path leaves the band is refused', () => {
    expect(ridesCutSurface({ x: 0, y: 0, z: 0 }, { x: 0.5, y: 0, z: 0 }, () => null, TOL, SHORT_HOP, PITCH)).toBe(false);
  });

  it('a ride below the band top is refused', () => {
    expect(ridesCutSurface({ x: 0, y: 0, z: -0.1 }, { x: 0.5, y: 0, z: -0.1 }, bandTop, TOL, SHORT_HOP, PITCH)).toBe(false);
  });
});

describe('#962 — an out-of-band join rides only if EVERY sample is at or below the link z', () => {
  // The manager's condition on the rough's out-of-band class: the honest field reports deeper
  // ground below the link (safe to ride), but ONE cell standing above it refuses the whole join —
  // a mostly-deeper strip with one standing cell must retract, not chord over it.
  const mostlyDeeper = (x: number): number | null => (x >= 0.45 ? 0.2 : -1);
  it('a mostly-deeper strip with one standing cell refuses', () => {
    expect(ridesCutSurface({ x: 0, y: 0, z: 0 }, { x: 0.5, y: 0, z: 0 }, mostlyDeeper, TOL, SHORT_HOP, PITCH)).toBe(false);
  });
  it('the same strip with every sample below the link rides', () => {
    expect(ridesCutSurface({ x: 0, y: 0, z: 0 }, { x: 0.5, y: 0, z: 0 }, () => -1, TOL, SHORT_HOP, PITCH)).toBe(true);
  });
  it('a standing cell between the samples is the sampling limit, not an approval: with a finer pitch it refuses', () => {
    const standingAtMid = (x: number): number | null => (Math.abs(x - 0.25) < 0.01 ? 0.2 : -1);
    expect(ridesCutSurface({ x: 0, y: 0, z: 0 }, { x: 0.5, y: 0, z: 0 }, standingAtMid, TOL, SHORT_HOP, 0.25)).toBe(false);
  });
});
