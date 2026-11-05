// #970 — the follow's chord must hold the row dropper's guarantee: between two emitted points the
// straight chord may not fall below the true CL by more than the surface's own tolerance. A
// convex CL corner (a ridge whose peak sits between the follow's fixed sample fractions) is the
// case that broke on the organizer: the samples were on the CL, the chord cut the corner, and the
// ball's flank followed it 0.177 mm under the design 2.9 mm off-axis.
//
// Red at 6e08117e (the follow samples every stepMm and connects with straight chords);
// green once followCutSurface lays its points with dropRow's subdivision.
import { describe, expect, it } from 'vitest';

import { followCutSurface } from '@/engine/cnc/cam/model/rideTest';

// The CL surface's own tolerance (ARC_CHORD_TOLERANCE_MM) — the bound the row dropper promises.
const TOL = 0.005;

/** A convex ridge: two straight slopes meeting at x = 1.05, off every fixed sample fraction. */
const ridge = (x: number): number => -2.0 - 1.2 * Math.abs(x - 1.05);

const FROM = { x: 0, y: 0, z: ridge(0) };
const TO = { x: 2, y: 0, z: ridge(2) };
const FEEDS = { feedMmPerMin: 1000, plungeFeedMmPerMin: 300 };
const RAPID = { xyMmPerMin: 5000, zMmPerMin: 1000 };

describe('#970 the follow link holds the row dropper\'s chord guarantee', () => {
  it('no emitted chord dips below the true CL by more than the surface tolerance', () => {
    const moves = followCutSurface(
      FROM,
      TO,
      (x) => ridge(x),
      0.5, // the ball-6 finish's linkSampleStep
      Number.NEGATIVE_INFINITY, // no level clamp: the pure CL-follow case
      FEEDS,
      RAPID,
      10,
    );
    expect(moves, 'the follow must be taken for this short, cheap link').not.toBeNull();
    let prev = FROM;
    let worst = -Infinity;
    let worstAt = 0;
    for (const m of moves!) {
      for (let s = 0; s <= 100; s++) {
        const t = s / 100;
        const x = prev.x + (m.x - prev.x) * t;
        const z = prev.z + (m.z - prev.z) * t;
        const dip = ridge(x) - z;
        if (dip > worst) {
          worst = dip;
          worstAt = x;
        }
      }
      prev = m;
    }
    expect(
      worst,
      `worst chord dip ${worst.toFixed(4)} mm at x = ${worstAt.toFixed(3)} — a chord between emitted points must stay within ${TOL} mm of the CL`,
    ).toBeLessThanOrEqual(TOL + 1e-6);
  });
});
