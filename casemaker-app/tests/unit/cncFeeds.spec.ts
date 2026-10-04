// Feeds and speeds (#202). The table is hardcoded and every row is `unmeasured`; these tests
// pin its shape, the two refusals (no row; step-over past the radius) and the machine clamp.

import { describe, it, expect } from 'vitest';
import { FEEDS_TABLE, feedsFor } from '@/engine/cnc/feeds';
import { flatEndMill, cuttingRadiusForSweep } from '@/engine/cnc/tool';
import { Z1, CLAMP_REFUSE_FRACTION } from '@/engine/cnc/machine';

/** A cutter for a row, in the middle of its range, so the row is unambiguous. */
function cutterFor(minDiameter: number, maxDiameter: number) {
  return flatEndMill((minDiameter + maxDiameter) / 2);
}

describe('the V1 feeds table', () => {
  it('is entirely unmeasured and carries its provenance', () => {
    expect(FEEDS_TABLE.length).toBeGreaterThan(0);
    for (const row of FEEDS_TABLE) {
      expect(row.status).toBe('unmeasured');
      expect(row.provenance).toContain('Starting value');
      expect(row.provenance).toContain('#209');
      expect(row.provenance).toContain('TopClamp.nc');
    }
  });

  it('covers only whole materials, each with a cutter range', () => {
    for (const row of FEEDS_TABLE) {
      expect(row.minDiameter).toBeGreaterThan(0);
      expect(row.maxDiameter).toBeGreaterThan(row.minDiameter);
    }
  });

  it('every row resolves for a cutter in its range, with NO diagnostics on the Z1', () => {
    // The table itself must never need clamping: it is written for this machine (#184, #202).
    for (const row of FEEDS_TABLE) {
      const res = feedsFor(row.material, cutterFor(row.minDiameter, row.maxDiameter), Z1);
      expect(res.ok, `${row.material} ${row.minDiameter}-${row.maxDiameter}`).toBe(true);
      if (!res.ok) continue;
      expect(res.entry).toBe(row);
      expect(res.diagnostics).toEqual([]);
    }
  });
});

describe('feedsFor selects a row by cutting diameter', () => {
  it('softwood + 1.0 mm flat end -> the first row, step-over 0.45 (fraction x diameter)', () => {
    const res = feedsFor('softwood', flatEndMill(1.0), Z1);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.reason);
    expect(res.entry).toBe(FEEDS_TABLE[0]);
    expect(res.params.stepOver).toBe(0.45);
    expect(res.params.stepDown).toBe(0.5);
  });

  it('softwood + 3.175 mm flat end -> the 1.6-3.2 mm row (inclusive at both ends), step-down 1.0', () => {
    const res = feedsFor('softwood', flatEndMill(3.175), Z1);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.reason);
    expect(res.entry.minDiameter).toBe(1.6);
    expect(res.entry.maxDiameter).toBe(3.2);
    expect(res.params.stepDown).toBe(1.0);
  });

  it('a 6 mm cutter has no row: refused, never extrapolated', () => {
    const res = feedsFor('softwood', flatEndMill(6), Z1);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected a refusal');
    expect(res.reason).toContain('6 mm');
    expect(res.reason).toContain('softwood');
  });

  it('a ball-nose is refused by cuttingRadiusForSweep, with its reason', () => {
    const ball = flatEndMill(1, { shape: 'ball', typeText: 'Ball End' });
    const res = feedsFor('softwood', ball, Z1);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected a refusal');
    const expected = cuttingRadiusForSweep(ball);
    expect(expected.ok).toBe(false);
    if (expected.ok) throw new Error('expected a refusal');
    expect(res.reason).toBe(expected.reason);
  });
});

describe('feedsFor enforces step-over <= radius (#191)', () => {
  it('refuses an override past the radius and names it; allows exactly the radius', () => {
    const tooWide = feedsFor('softwood', flatEndMill(1.0), Z1, { stepOver: 0.6 });
    expect(tooWide.ok).toBe(false);
    if (tooWide.ok) throw new Error('expected a refusal');
    expect(tooWide.reason).toContain('0.5 mm radius');
    expect(tooWide.reason).toContain('#191');

    const atRadius = feedsFor('softwood', flatEndMill(1.0), Z1, { stepOver: 0.5 });
    expect(atRadius.ok).toBe(true);
    if (!atRadius.ok) throw new Error(atRadius.reason);
    expect(atRadius.params.stepOver).toBe(0.5);
  });
});

describe('feedsFor clamps against the machine', () => {
  it('clamps an override feed of 1500 to the Z1 ceiling of 1200 and says so', () => {
    const res = feedsFor('softwood', flatEndMill(1.0), Z1, { feed: 1500 });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.reason);
    expect(res.params.feed).toBe(1200);
    expect(res.diagnostics).toHaveLength(1);
    expect(res.diagnostics[0]).toMatchObject({ severity: 'warning', code: 'feed-clamped' });
    // +25 %, inside the 50 % refusal band.
    expect(1500 / Z1.maxCutFeed - 1).toBeLessThan(CLAMP_REFUSE_FRACTION);
  });

  it('refuses an override rpm of 24000 (+85 %), past the 50 % refusal threshold', () => {
    const res = feedsFor('softwood', flatEndMill(1.0), Z1, { rpm: 24000 });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected a refusal');
    expect(res.reason).toContain('24000');
    expect(24000 / Z1.maxRpm - 1).toBeGreaterThan(CLAMP_REFUSE_FRACTION);
  });

  it('refuses non-positive depth, feeds and spindle rather than clamping them', () => {
    for (const override of [{ stepDown: 0 }, { feed: 0 }, { plungeFeed: -1 }, { rpm: 0 }]) {
      const res = feedsFor('softwood', flatEndMill(1.0), Z1, override);
      expect(res.ok, JSON.stringify(override)).toBe(false);
    }
  });
});
