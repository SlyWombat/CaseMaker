/**
 * #1218 (planner v3 B3) — THE ONE ROTARY CLOCK. The Z1's firmware treats a feed that turns A as a
 * surface speed over a perimeter of `2π·r + 30` mm per turn and caps A at 3,600 °/min; the estimate
 * used to time A as an arc at the design radius, so rotary estimates ran short. These pin the
 * shared function and the estimate's new path. Expected values are the issue's, never edited.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ROTARY_CLOCK,
  FIRMWARE_A_MAX_DEG_PER_MIN,
  FIRMWARE_ROTARY_PERIMETER_EXTRA_MM,
  rotaryFeedSeconds,
  rotaryRate,
  rotaryRapidTurnSeconds,
} from '@/engine/cnc/rotaryClock';
import { estimateCycleSeconds, type CamMove, type RapidEstimate } from '@/engine/cnc/cam/ir';

/** The issue's rapid model: 1200 mm/min XY, 600 Z, 150 mm/s² accel. */
const RAPID: RapidEstimate = { xyMmPerMin: 1200, zMmPerMin: 600, accelMmPerS2: 150, source: 'spec fixture' };

describe('#1218 — the firmware constants are named machine facts', () => {
  it('are the controller’s own figures, with the shipped defaults', () => {
    expect(FIRMWARE_ROTARY_PERIMETER_EXTRA_MM).toBe(30);
    expect(FIRMWARE_A_MAX_DEG_PER_MIN).toBe(3600);
    expect(DEFAULT_ROTARY_CLOCK).toEqual({ aMaxDegPerMin: 3600, perimeterExtraMm: 30 });
  });
});

describe('#1218 — rotaryRate: what the feed asks of A, and the ceiling', () => {
  it('1200 mm/min at r = 10 asks 77.559585 °/s and is capped at 60', () => {
    const r = rotaryRate(1200, 10);
    expect(r.askedDegPerSec).toBeCloseTo(77.559585, 5);
    expect(r.allowedDegPerSec).toBeCloseTo(60, 5);
    expect(r.capDegPerSec).toBeCloseTo(60, 5);
    expect(r.capped).toBe(true);
  });

  it('600 mm/min at r = 20 asks 23.126778 °/s and is not capped', () => {
    const r = rotaryRate(600, 20);
    expect(r.askedDegPerSec).toBeCloseTo(23.126778, 5);
    expect(r.allowedDegPerSec).toBeCloseTo(23.126778, 5);
    expect(r.capped).toBe(false);
  });

  it('600 mm/min at r = 0.5 uses the 2π + 30 perimeter: 99.219514 °/s, capped', () => {
    const r = rotaryRate(600, 0.5);
    expect(r.askedDegPerSec).toBeCloseTo(99.219514, 5);
    expect(r.allowedDegPerSec).toBeCloseTo(60, 5);
    expect(r.capped).toBe(true);
  });

  it('a negative radius is read as its magnitude', () => {
    const r = rotaryRate(600, -20);
    expect(r.askedDegPerSec).toBeCloseTo(23.126778, 5);
    expect(r.allowedDegPerSec).toBeCloseTo(23.126778, 5);
    expect(r.capped).toBe(false);
  });
});

describe('#1218 — rotaryFeedSeconds: the slower of the turn and the travel', () => {
  it('one full turn at r = 20, feed 600: 15.566371 s', () => {
    expect(rotaryFeedSeconds(0, 0, 360, 600, 20)).toBeCloseTo(15.566371, 5);
  });

  it('10 mm of travel alongside a full turn: the turn still sets the time', () => {
    expect(rotaryFeedSeconds(10, 0, 360, 600, 20)).toBeCloseTo(15.566371, 5);
  });

  it('100 mm of travel with a 36° turn: the travel (10 s) is slower', () => {
    expect(rotaryFeedSeconds(100, 0, 36, 600, 20)).toBeCloseTo(10, 5);
  });

  it('no turn: the 3-4-5 travel at 10 mm/s is 5 s', () => {
    expect(rotaryFeedSeconds(30, 40, 0, 600, 20)).toBeCloseTo(5, 5);
  });

  it('two turns at feed 1200, r = 10: capped at 60 °/s, 12 s', () => {
    expect(rotaryFeedSeconds(0, 0, 720, 1200, 10)).toBeCloseTo(12, 5);
  });

  it('no feed: 0', () => {
    expect(rotaryFeedSeconds(0, 0, 360, 0, 20)).toBe(0);
  });
});

describe('#1218 — rotaryRapidTurnSeconds: A runs at its ceiling', () => {
  it('360° at 3,600 °/min is 6 s', () => {
    expect(rotaryRapidTurnSeconds(360)).toBeCloseTo(6, 9);
  });

  it('−90° is 1.5 s', () => {
    expect(rotaryRapidTurnSeconds(-90)).toBeCloseTo(1.5, 9);
  });
});

describe('#1218 — the estimate times A the way the firmware runs it', () => {
  it('a full turn at radius 20 takes the firmware’s time', () => {
    const moves: CamMove[] = [
      { kind: 'feed', x: 0, y: 0, z: 20, a: 0, f: 600 },
      { kind: 'feed', x: 0, y: 0, z: 20, a: 360, f: 600 },
    ];
    expect(estimateCycleSeconds(moves, RAPID, 20)).toBeCloseTo(15.566371, 5);
  });

  it('a rotary move that does not turn is timed as before', () => {
    const moves: CamMove[] = [
      { kind: 'feed', x: 0, y: 0, z: 20, a: 0, f: 600 },
      { kind: 'feed', x: 60, y: 0, z: 20, a: 0, f: 600 },
    ];
    expect(estimateCycleSeconds(moves, RAPID, 20)).toBe(estimateCycleSeconds(moves, RAPID));
  });
});
