/**
 * #1227 (planner v3 A5) — THE POCKET'S WALL PASS RUNS ONE POSTED STEP CLOSER.
 *
 * The program states centres to three decimals; a centre rounded AWAY from the wall leaves a strip
 * half a thousandth wide that the checks read as standing material (the tray's deep walls at 65.6
 * and 86.2 were the finding). Facing already holds its raster one posted step in
 * (`FACING_EDGE_CLEARANCE_MM`); the pocket's rings now do the same.
 */
import { describe, expect, it } from 'vitest';

import { pocketRingInsetMm } from '@/engine/cnc/cam/model/ops/pocket';

describe('#1227 pocketRingInsetMm', () => {
  it('one posted step inside the radius', () => {
    expect(pocketRingInsetMm(1.5875, false)).toBeCloseTo(1.5865, 9);
    expect(pocketRingInsetMm(1.5, false)).toBeCloseTo(1.499, 9);
  });

  it('a centre-space region is not inset', () => {
    expect(pocketRingInsetMm(1.5875, true)).toBe(0);
  });

  it('the posted centre reaches the wall', () => {
    const r = 1.5875;
    for (const wall of [65.6, 86.2, 127.4, 30, 12.345]) {
      const posted = Number((wall - pocketRingInsetMm(r, false)).toFixed(3));
      expect(posted + r, `wall ${wall}: posted ${posted} + ${r} must reach it`).toBeGreaterThanOrEqual(wall);
    }
  });

  it('the old inset did not', () => {
    // Documents the defect; no product code is called.
    expect(Number((65.6 - 1.5875).toFixed(3)) + 1.5875).toBeLessThan(65.6);
    expect(Number((86.2 - 1.5875).toFixed(3)) + 1.5875).toBeLessThan(86.2);
  });
});
