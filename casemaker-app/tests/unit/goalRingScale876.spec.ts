/**
 * #876 — THE ROTATE RING'S GRADUATED SCALE AND ZONE SNAP.
 *
 * PrusaSlicer's model, as the maintainer asked for it: the cursor's radius chooses the precision.
 * Outside the scale band the turn is free (0.1°, the document's precision); inside the band it
 * tracks the 5° ticks, and within 3° of a 45° major line it locks exactly. The band is measured in
 * screen pixels — 24 for a mouse, at least 44 for a finger — so a zoom cannot thin a phone's band.
 */
import { describe, expect, it } from 'vitest';

import {
  BAND_PX_COARSE,
  BAND_PX_FINE,
  bandPx,
  inScaleBand,
  ROTATE_MAJOR_DEG,
  ROTATE_MAJOR_LOCK_DEG,
  ROTATE_TICK_DEG,
  snapRingAngle,
} from '@/components/viewport/goalHandleFrame';

describe('#876 — the ring scale’s zones', () => {
  it('in the band the angle tracks the 5° ticks', () => {
    expect(ROTATE_TICK_DEG).toBe(5);
    expect(snapRingAngle(11.7, true)).toBe(10);
    expect(snapRingAngle(13, true)).toBe(15);
    expect(snapRingAngle(-13, true)).toBe(-15);
    expect(snapRingAngle(22, true)).toBe(20);
    // The old rule (a flat 15° snap) would have said 15 here; the scale's fine tick says 10.
    expect(snapRingAngle(11.7, true)).not.toBe(15);
  });

  it('near a 45° major line it locks onto that line exactly', () => {
    expect(ROTATE_MAJOR_DEG).toBe(45);
    expect(ROTATE_MAJOR_LOCK_DEG).toBe(3);
    expect(snapRingAngle(44, true)).toBe(45);
    expect(snapRingAngle(46.5, true)).toBe(45);
    expect(snapRingAngle(88, true)).toBe(90);
    expect(snapRingAngle(-91.5, true)).toBe(-90);
    // Exactly the lock's edge still locks; a hair past it falls back to the tick grid.
    expect(snapRingAngle(45 + ROTATE_MAJOR_LOCK_DEG, true)).toBe(45);
    expect(snapRingAngle(45 + ROTATE_MAJOR_LOCK_DEG + 0.1, true)).toBe(50);
  });

  it('outside the band the turn is free', () => {
    expect(snapRingAngle(11.7, false)).toBe(11.7);
    expect(snapRingAngle(13.24, false)).toBe(13.2);
    expect(snapRingAngle(44.6, false)).toBe(44.6);
    expect(snapRingAngle(-13.27, false)).toBe(-13.3);
  });

  it('the band is 24 px for a mouse and at least 44 px for a finger', () => {
    expect(BAND_PX_FINE).toBe(24);
    expect(bandPx(false)).toBe(BAND_PX_FINE);
    expect(bandPx(true)).toBe(BAND_PX_COARSE);
    expect(BAND_PX_COARSE).toBeGreaterThanOrEqual(44);
    // The band is an annulus CENTRED on the ring's projected radius: half its depth each side.
    expect(inScaleBand(100, 100, BAND_PX_COARSE)).toBe(true);
    expect(inScaleBand(122, 100, BAND_PX_COARSE)).toBe(true);
    expect(inScaleBand(122.5, 100, BAND_PX_COARSE)).toBe(false);
    expect(inScaleBand(112, 100, BAND_PX_FINE)).toBe(true);
    expect(inScaleBand(113, 100, BAND_PX_FINE)).toBe(false);
  });
});
