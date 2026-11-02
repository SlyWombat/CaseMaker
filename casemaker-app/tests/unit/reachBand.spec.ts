/**
 * #914 — THE ONE RULE EVERY SIDE'S BAND READS: the cutter's stated reach less the holder
 * clearance, the need it cannot exceed, the remainder it states, and the seam adjacent sides
 * overlap by. The flat side plan and (later) the rotary station plan call this same function, so
 * these are the numbers both will state.
 */
import { describe, expect, it } from 'vitest';

import { reachBand, reachSeamMm, REACH_SEAM_MIN_MM } from '@/engine/cnc/engrave/reachBand';

describe('#914 the reach band', () => {
  it('with no stated reach the band is the need, and nothing is left beyond it', () => {
    expect(reachBand({ needMm: 33 })).toEqual({ usableReachMm: null, bandMm: 33, remainderMm: 0, seamMm: 0.5 });
    expect(reachBand({ needMm: 33, reachMm: null })).toEqual({
      usableReachMm: null,
      bandMm: 33,
      remainderMm: 0,
      seamMm: 0.5,
    });
  });

  it('the usable reach keeps the holder clearance off the cutter’s own number', () => {
    // A 32 mm reach cuts to 31 mm below the face; a 33 mm-deep side leaves its last 2 mm.
    expect(reachBand({ needMm: 33, reachMm: 32 })).toEqual({
      usableReachMm: 31,
      bandMm: 31,
      remainderMm: 2,
      seamMm: 0.5,
    });
  });

  it('a band past the need is the need: no remainder, nothing to state', () => {
    const b = reachBand({ needMm: 12, reachMm: 32 });
    expect(b.usableReachMm).toBe(31);
    expect(b.bandMm).toBe(12);
    expect(b.remainderMm).toBe(0);
  });

  it('a reach at or under the clearance cuts no depth safely', () => {
    const b = reachBand({ needMm: 5, reachMm: 0.5 });
    expect(b.usableReachMm).toBe(0);
    expect(b.bandMm).toBe(0);
    expect(b.remainderMm).toBe(5);
  });

  it('a nonsense need or reach states no limit rather than a wrong one', () => {
    expect(reachBand({ needMm: Number.NaN }).bandMm).toBe(0);
    expect(reachBand({ needMm: 10, reachMm: Number.NaN }).usableReachMm).toBeNull();
    expect(reachBand({ needMm: 10, reachMm: -3 }).usableReachMm).toBeNull();
  });

  it('the seam is one finishing step-over, floored at the minimum', () => {
    expect(reachSeamMm(undefined)).toBe(REACH_SEAM_MIN_MM);
    expect(reachSeamMm(null)).toBe(REACH_SEAM_MIN_MM);
    expect(reachSeamMm(0.2)).toBe(REACH_SEAM_MIN_MM);
    expect(reachSeamMm(0.8)).toBe(0.8);
    expect(reachSeamMm(Number.NaN)).toBe(REACH_SEAM_MIN_MM);
    expect(reachBand({ needMm: 5, finishStepOverMm: 0.8 }).seamMm).toBe(0.8);
  });
});
