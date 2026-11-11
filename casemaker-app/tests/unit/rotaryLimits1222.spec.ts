// #1222 (planner v3 B4) — THE ROTARY LIMITS ARE SHOP SETTINGS. With the settings at their
// recommended values every number below is today's constant; a measured value is used and says so.
import { describe, expect, it } from 'vitest';

import { rotaryLimits, type RotaryLimits } from '@/engine/cnc/rotary/limits';
import { rotaryFreeSpan, rotaryMapOf, ROTARY_CLEARANCE_MM, ROTARY_TAILSTOCK_BAND_MM } from '@/engine/cnc/rotary/wrap';
import {
  ROTARY_TAILSTOCK_BODY_MM,
  ROTARY_TAILSTOCK_CENTRE_MM,
  ROTARY_TAILSTOCK_HOUSING_RADIUS_MM,
  tailstockSpan,
} from '@/engine/cnc/rotary/tailstock';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import type { EngraveJob } from '@/types/engraveJob';
import type { ShopDefaults } from '@/platform/defaultsClient';

const RECOMMENDED: RotaryLimits = {
  jawKeepOutMm: 3,
  tailstockBandMm: 10,
  turnClearanceMm: 3,
  tailstockCentreMm: 12,
  tailstockBodyMm: 40,
  tailstockHousingRadiusMm: 45,
};

/** One seeded shop map entry, as the location's `defaults` holds it. */
function entry(value: number, source: 'seeded' | 'measured'): ShopDefaults[string] {
  return { value, source, setAt: null, unit: 'mm', note: null };
}

function rotaryJob(): EngraveJob {
  const base = defaultEngraveJob();
  return {
    ...base,
    stock: { ...base.stock, length: 100, width: 20, thickness: 20, shape: 'cylinder', diameter: 20 },
    workholding: {
      kind: 'rotary-chuck',
      rotary: { jawDiameter: null, stickout: 85, gripDiameter: null, jawMode: 'reverse-inner', tailstock: true, source: 'test' },
    },
  } as EngraveJob;
}

describe('#1222 the rotary limits', () => {
  it('the recommended values', () => {
    expect(rotaryLimits(null).limits).toEqual(RECOMMENDED);
    expect(rotaryLimits(null).unmeasured).toHaveLength(6);
  });

  it('a measured value is used and is not listed as unmeasured', () => {
    const map: ShopDefaults = { 'rotary.tailstockBandMm': entry(12, 'measured') };
    const read = rotaryLimits(map);
    expect(read.limits.tailstockBandMm).toBe(12);
    expect(read.unmeasured).toHaveLength(5);
    expect(read.unmeasured).not.toContain('rotary.tailstockBandMm');
  });

  it('the constants still read the recommended values', () => {
    expect(ROTARY_TAILSTOCK_BAND_MM).toBe(10);
    expect(ROTARY_CLEARANCE_MM).toBe(3);
    expect(ROTARY_TAILSTOCK_CENTRE_MM).toBe(12);
    expect(ROTARY_TAILSTOCK_BODY_MM).toBe(40);
    expect(ROTARY_TAILSTOCK_HOUSING_RADIUS_MM).toBe(45);
  });

  it('the free span, recommended', () => {
    expect(rotaryFreeSpan({ stickout: 85, tailstock: true })).toEqual({ from: 3, to: 75, centre: 39 });
  });

  it('the free span follows the shop', () => {
    expect(
      rotaryFreeSpan({
        stickout: 85,
        tailstock: true,
        limits: { ...RECOMMENDED, jawKeepOutMm: 5, tailstockBandMm: 12 },
      }),
    ).toEqual({ from: 5, to: 73, centre: 39 });
  });

  it('the tailstock body, recommended', () => {
    expect(tailstockSpan(30, 25, 10)).toEqual({ x0: 42, x1: 82, radius: 45 });
  });

  it('the tailstock body follows the shop', () => {
    expect(
      tailstockSpan(30, 25, 10, { tailstockCentreMm: 10, tailstockBodyMm: 30, tailstockHousingRadiusMm: 50 }),
    ).toEqual({ x0: 40, x1: 70, radius: 50 });
  });

  it("a job's map carries the limits", () => {
    expect(rotaryMapOf(rotaryJob(), null)?.limits).toEqual(RECOMMENDED);
    const map: ShopDefaults = { 'rotary.tailstockBandMm': entry(12, 'measured') };
    expect(rotaryMapOf(rotaryJob(), map)?.limits?.tailstockBandMm).toBe(12);
  });
});
