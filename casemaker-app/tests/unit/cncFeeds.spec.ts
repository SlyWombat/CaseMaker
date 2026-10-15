// Feeds and speeds (#202). The table is hardcoded and every row is `unmeasured`; these tests
// pin its shape, the two refusals (no row; step-over past the radius) and the machine clamp.

import { describe, it, expect } from 'vitest';
import { FEEDS_TABLE, feedsFor, type FeedsEntry } from '@/engine/cnc/feeds';
import { flatEndMill, cuttingRadiusForSweep } from '@/engine/cnc/tool';
import { Z1, CLAMP_REFUSE_FRACTION } from '@/engine/cnc/machine';

/**
 * A cutter that lands in a row's range, on the row's OWN edge (#405): a row states the edge its
 * numbers were written for, and a V-bit's numbers are not a flat end mill's, so a flat cutter built
 * to the V row's diameter would resolve against a different row — or none.
 */
function cutterFor(row: FeedsEntry) {
  const mid = (row.minDiameter + row.maxDiameter) / 2;
  return (row.edge ?? 'flat') === 'v'
    ? flatEndMill(mid, { shape: 'engraving', typeText: 'Engraving', tipDiameter: mid, diameter: 3.175, halfAngle: 15, angle: 30 })
    : flatEndMill(mid);
}

/** The 30° × 0.3 mm engraving bit — the text job's default cutter (#405). */
function vBit30(tip: number) {
  return flatEndMill(tip, {
    name: 'Single Flute Engraving Bit 30 x 0.3',
    typeText: 'Engraving',
    shape: 'engraving',
    tipDiameter: tip,
    diameter: 3.175,
    halfAngle: 15,
    angle: 30,
  });
}

describe('the V1 feeds table', () => {
  it('is entirely unmeasured, and every row names its own source', () => {
    expect(FEEDS_TABLE.length).toBeGreaterThan(0);
    for (const row of FEEDS_TABLE) {
      expect(row.status).toBe('unmeasured');
      // #405 splits this: the V row's numbers come from a BENCH CUT on the machine
      // (`docs/bench/185-v-groove.nc`), not from Studio's own sample, so one provenance string for
      // the whole table is no longer the truth.
      if ((row.edge ?? 'flat') === 'v') {
        expect(row.provenance).toContain('#185');
        expect(row.provenance).toContain('185-v-groove.nc');
      } else {
        expect(row.provenance).toContain('Starting value');
        expect(row.provenance).toContain('#209');
        expect(row.provenance).toContain('TopClamp.nc');
      }
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
      const res = feedsFor([], row.material, cutterFor(row), Z1);
      expect(res.ok, `${row.material} ${row.edge ?? 'flat'} ${row.minDiameter}-${row.maxDiameter}`).toBe(true);
      if (!res.ok) continue;
      expect(res.entry).toBe(row);
      expect(res.diagnostics).toEqual([]);
    }
  });
});

describe('feedsFor selects a row by cutting diameter', () => {
  it('softwood + 1.0 mm flat end -> the first row, step-over 0.45 (fraction x diameter)', () => {
    const res = feedsFor([], 'softwood', flatEndMill(1.0), Z1);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.reason);
    expect(res.entry).toBe(FEEDS_TABLE[0]);
    expect(res.params.stepOver).toBe(0.45);
    expect(res.params.stepDown).toBe(0.5);
  });

  it('softwood + 3.175 mm flat end -> the 1.6-3.2 mm row (inclusive at both ends), step-down 1.0', () => {
    const res = feedsFor([], 'softwood', flatEndMill(3.175), Z1);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.reason);
    expect(res.entry.minDiameter).toBe(1.6);
    expect(res.entry.maxDiameter).toBe(3.2);
    expect(res.params.stepDown).toBe(1.0);
  });

  it('a cutter exactly on the shared 1.6 mm boundary takes the FIRST (smaller-diameter) row', () => {
    const res = feedsFor([], 'softwood', flatEndMill(1.6), Z1);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.reason);
    expect(res.entry).toBe(FEEDS_TABLE[0]);
    expect(res.params.stepDown).toBe(0.5);
  });

  // The second PLA row exists because the fitted bench cutter is a 2 mm O-flute and every PLA job on
  // it was refused at the feeds stage (#165/#383, bench 2026-10-12). It is a placeholder like the
  // rest of the table — #284's coupons measure it — so what is pinned here is only that it EXISTS and
  // is selected, at the CUTTING diameter (2), not the 3.175 shank.
  it('PLA + the fitted 2 mm O-flute -> the 1.6-3.2 mm PLA row', () => {
    const res = feedsFor([], 'pla', flatEndMill(2, { name: 'Spiral O single flute 2 x 12' }), Z1);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.reason);
    expect(res.entry.material).toBe('pla');
    expect(res.entry.minDiameter).toBe(1.6);
    expect(res.entry.maxDiameter).toBe(3.2);
    expect(res.params.stepDown).toBe(0.5);
    expect(res.params.feed).toBe(500);
    // Still the FIRST matching row for a smaller PLA cutter: #284's sweeps do not move the boundary.
    const small = feedsFor([], 'pla', flatEndMill(1.0), Z1);
    expect(small.ok).toBe(true);
    if (!small.ok) throw new Error(small.reason);
    expect(small.entry.maxDiameter).toBe(1.6);
  });

  it('a 6 mm cutter has no row: refused, never extrapolated', () => {
    const res = feedsFor([], 'softwood', flatEndMill(6), Z1);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected a refusal');
    expect(res.reason).toContain('6 mm');
    expect(res.reason).toContain('softwood');
  });

  it('a ball-nose is refused by cuttingRadiusForSweep, with its reason', () => {
    const ball = flatEndMill(1, { shape: 'ball', typeText: 'Ball End' });
    const res = feedsFor([], 'softwood', ball, Z1);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected a refusal');
    const expected = cuttingRadiusForSweep(ball);
    expect(expected.ok).toBe(false);
    if (expected.ok) throw new Error('expected a refusal');
    expect(res.reason).toBe(expected.reason);
  });
});

describe('feedsFor and the V-bit row (#405)', () => {
  it('PLA + the 30° × 0.3 mm engraving bit -> the V row: S12000, F500 along, F200 plunge, one 1 mm pass', () => {
    const res = feedsFor([], 'pla', vBit30(0.3), Z1);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.reason);
    expect(res.entry.edge).toBe('v');
    expect(res.entry.material).toBe('pla');
    // The hand-written bench file's own numbers (`docs/bench/185-v-groove.nc`), which the
    // 2026-10-15 cut confirmed: this row starts where a cut known to have worked started.
    expect(res.params.rpm).toBe(12000);
    expect(res.params.feed).toBe(500);
    expect(res.params.plungeFeed).toBe(200);
    // One pass to the 1.0 mm colour-reveal depth: stepDown = depth means `zPasses` returns one pass.
    expect(res.params.stepDown).toBe(1.0);
    // The provenance is the bench cut, and it says it is a STARTING value, not a coupon result.
    expect(res.entry.provenance).toContain('185-v-groove.nc');
    expect(res.entry.provenance).toContain('#284');
  });

  it('selects on the EDGE: a 0.4 mm flat end mill takes the V row for nothing', () => {
    // The V row's range (0.3–0.5 mm) covers the flat's diameter, and its numbers were written for
    // a cutter that engages its flank. Were the edge not part of selection, this flat end mill
    // would run a cone's feed. It has no flat PLA row at 0.4 mm, so the honest answer is a refusal.
    const flat = flatEndMill(0.4);
    const res = feedsFor([], 'pla', flat, Z1);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected a refusal');
    expect(res.reason).toContain('0.4 mm');
  });

  it('refuses a V-bit in a material with no V row, and says which row is missing', () => {
    const res = feedsFor([], 'softwood', vBit30(0.3), Z1);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected a refusal');
    // Not the flat cutter's "no row in this range" sentence: a cone is never asked of the vendor
    // table at all (#405), so the refusal names the missing row rather than a tier that would
    // never have answered.
    expect(res.reason).toContain('V-bit');
    expect(res.reason).toContain('PLA only');
  });

  it('refuses the metal bit’s 0.1 mm tip: outside every V row, so no numbers, no job', () => {
    // The 60° bit is a METAL cutter (the `(Metal)` line by name). Its 0.1 mm tip falls outside the
    // V row's 0.3–0.5 mm range — a tip, not a shank — so a PLA job on it is refused rather than
    // handed a feed invented for a different cone. Supporting the geometry is not licensing the job.
    const metal = flatEndMill(0.1, {
      name: 'Engraving V-bit 60° 0.1 (Metal)',
      typeText: 'Engraving',
      shape: 'engraving',
      tipDiameter: 0.1,
      diameter: 3.175,
      halfAngle: 30,
      angle: 60,
    });
    const res = feedsFor([], 'pla', metal, Z1);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected a refusal');
    expect(res.reason).toContain('V-bit');
  });
});

describe('feedsFor enforces step-over <= radius (#191)', () => {
  it('refuses an override past the radius and names it; allows exactly the radius', () => {
    const tooWide = feedsFor([], 'softwood', flatEndMill(1.0), Z1, { stepOver: 0.6 });
    expect(tooWide.ok).toBe(false);
    if (tooWide.ok) throw new Error('expected a refusal');
    expect(tooWide.reason).toContain('0.5 mm radius');
    expect(tooWide.reason).toContain('#191');

    const atRadius = feedsFor([], 'softwood', flatEndMill(1.0), Z1, { stepOver: 0.5 });
    expect(atRadius.ok).toBe(true);
    if (!atRadius.ok) throw new Error(atRadius.reason);
    expect(atRadius.params.stepOver).toBe(0.5);
  });

  it('refuses a zero or negative step-over override as well as one past the radius', () => {
    for (const stepOver of [0, -0.1]) {
      const res = feedsFor([], 'softwood', flatEndMill(1.0), Z1, { stepOver });
      expect(res.ok, String(stepOver)).toBe(false);
      if (res.ok) throw new Error('expected a refusal');
      expect(res.reason).toContain('step-over');
    }
  });
});

describe('feedsFor clamps against the machine', () => {
  it('clamps an override feed of 1500 to the Z1 ceiling of 1200 and says so', () => {
    const res = feedsFor([], 'softwood', flatEndMill(1.0), Z1, { feed: 1500 });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.reason);
    expect(res.params.feed).toBe(1200);
    expect(res.diagnostics).toHaveLength(1);
    expect(res.diagnostics[0]).toMatchObject({ severity: 'warning', code: 'feed-clamped' });
    // +25 %, inside the 50 % refusal band.
    expect(1500 / Z1.maxCutFeed - 1).toBeLessThan(CLAMP_REFUSE_FRACTION);
  });

  it('refuses an override rpm of 24000 (+85 %), past the 50 % refusal threshold', () => {
    const res = feedsFor([], 'softwood', flatEndMill(1.0), Z1, { rpm: 24000 });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected a refusal');
    expect(res.reason).toContain('24000');
    expect(24000 / Z1.maxRpm - 1).toBeGreaterThan(CLAMP_REFUSE_FRACTION);
  });

  it('refuses non-positive depth, feeds and spindle rather than clamping them', () => {
    for (const override of [{ stepDown: 0 }, { feed: 0 }, { plungeFeed: -1 }, { rpm: 0 }]) {
      const res = feedsFor([], 'softwood', flatEndMill(1.0), Z1, override);
      expect(res.ok, JSON.stringify(override)).toBe(false);
    }
  });
});
