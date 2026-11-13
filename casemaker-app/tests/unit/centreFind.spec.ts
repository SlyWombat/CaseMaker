// #827 — the centre-find geometry, pinned to the 2026-10-31 bench: the vise's counterbore, ball
// centres 7.196–7.235 apart in X/Y with the probe's measured effective radius 0.875 mm — the same
// numbers that made the ⌀8.97 reading Studio's Diagnostic panel would show.

import { describe, expect, it } from 'vitest';
import {
  centrePair,
  centreTouchDepthMm,
  centreWallOffsetMm,
  planCentreFind,
  readCentrePair,
} from '@/engine/cnc/registration/centreFind';

const R = 0.875;

describe('#827 the bench counterbore', () => {
  // docs/bench/2026-10-31 probe-bore record (in #790's comment): counterbore centre X −203.498,
  // Y −181.329; ball-centre spans 7.196/7.208 in X and 7.231/7.235 in Y.
  const CENTRE = { x: -203.498, y: -181.329 };
  const spans = [
    { axis: 'x' as const, span: 7.196 },
    { axis: 'x' as const, span: 7.208 },
    { axis: 'y' as const, span: 7.231 },
    { axis: 'y' as const, span: 7.235 },
  ];

  it('turns the measured spans into the counterbore centre and ⌀ 8.97 (8.94–8.99 across the runs)', () => {
    const diameters: number[] = [];
    for (const { axis, span } of spans) {
      const minus = axis === 'x' ? CENTRE.x - span / 2 : CENTRE.y - span / 2;
      const plus = axis === 'x' ? CENTRE.x + span / 2 : CENTRE.y + span / 2;
      const reading = readCentrePair('bore', axis, minus, plus, R);
      expect(reading.centre).toBeCloseTo(axis === 'x' ? CENTRE.x : CENTRE.y, 2);
      expect(reading.spanMm).toBeCloseTo(span, 3);
      // span + 2R, every run: 8.946–8.985, and the bench's headline is the mean, ⌀ 8.97.
      expect(reading.diameterMm).toBeGreaterThanOrEqual(8.94);
      expect(reading.diameterMm).toBeLessThanOrEqual(8.99);
      diameters.push(reading.diameterMm);
    }
    expect(diameters.reduce((a, b) => a + b, 0) / diameters.length).toBeCloseTo(8.97, 2);
  });

  it('a boss reads its diameter the other way: span less twice the radius', () => {
    // A ⌀30 round part: ball centres at ±(15 + R) from its centre.
    const reading = readCentrePair('boss', 'x', -15.875, 15.875, R);
    expect(reading.centre).toBe(0);
    expect(reading.spanMm).toBe(31.75);
    expect(reading.diameterMm).toBe(30);
  });

  it('the midpoint of two walls is the centre, and the repeat pair corrects an off estimate', () => {
    // First pair 1 mm off centre (a bore centred at 10): ball centres 10 ± (D/2 − R) with D = 8.
    const first = readCentrePair('bore', 'x', 10 - (4 - R), 10 + (4 - R), R);
    expect(first.centre).toBe(10);
    expect(first.diameterMm).toBe(8);
  });
});

describe('#827 the routine geometry', () => {
  it('a bore touches outward from the estimate; a boss touches inward from beyond its edge', () => {
    const at = { x: 5, y: -2 };
    // Bore, −X: starts at the centre and travels −search.
    expect(centrePair('bore', at, 'x', -1, 8)).toEqual({ from: { x: 5, y: -2 }, travelMm: -8 });
    // Bore, +Y: from the centre, +search.
    expect(centrePair('bore', at, 'y', 1, 8)).toEqual({ from: { x: 5, y: -2 }, travelMm: 8 });
    // Boss, −X: starts 8 mm left of the centre, travels back inward (+X).
    expect(centrePair('boss', at, 'x', -1, 8)).toEqual({ from: { x: -3, y: -2 }, travelMm: 8 });
    // Boss, +Y: starts 8 mm above, travels inward (−Y).
    expect(centrePair('boss', at, 'y', 1, 8)).toEqual({ from: { x: 5, y: 6 }, travelMm: -8 });
  });

  it('the touch depth is one radius on thick stock, half the thickness on thin, never under the floor', () => {
    expect(centreTouchDepthMm(R, 10)).toBe(0.875);
    expect(centreTouchDepthMm(R, 1.2)).toBe(0.6);
    expect(centreTouchDepthMm(R, 0.2)).toBe(0.3);
    expect(centreTouchDepthMm(R, undefined)).toBe(0.875);
  });

  it('the wall offset shrinks when the ball meets the top corner instead of the equator', () => {
    expect(centreWallOffsetMm(0.875, R)).toBe(0.875);
    const atCorner = centreWallOffsetMm(0.6, R);
    expect(atCorner).toBeLessThan(R);
    expect(atCorner).toBeCloseTo(Math.sqrt(R * R - 0.6 * 0.6), 3);
  });

  it('the plan carries the depth, the order and the measured radius; a bad ask is refused with a sentence', () => {
    const made = planCentreFind({ kind: 'bore', at: { x: 10, y: 20 }, searchMm: 8, ballRadiusMm: R, stockThicknessMm: 5, touchFeed: 150, maxSearchMm: 60 });
    expect(made.ok).toBe(true);
    if (made.ok) {
      expect(made.plan.order).toEqual(['x', 'y', 'x']);
      expect(made.plan.depthMm).toBe(0.875);
    }
    expect(planCentreFind({ kind: 'bore', at: { x: 0, y: 0 }, searchMm: 8, ballRadiusMm: 0, touchFeed: 150, maxSearchMm: 60 })).toMatchObject({ ok: false });
    expect(planCentreFind({ kind: 'bore', at: { x: 0, y: 0 }, searchMm: 0, ballRadiusMm: R, touchFeed: 150, maxSearchMm: 60 })).toMatchObject({ ok: false });
    expect(
      planCentreFind({ kind: 'bore', at: { x: 0, y: 0 }, searchMm: 61, ballRadiusMm: R, touchFeed: 150, maxSearchMm: 60 }),
    ).toMatchObject({ ok: false });
    expect(planCentreFind({ kind: 'boss', at: { x: 0, y: 0 }, searchMm: 8, ballRadiusMm: R, stockThicknessMm: 0, touchFeed: 150, maxSearchMm: 60 })).toMatchObject({
      ok: false,
    });
  });
});
