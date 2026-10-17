// #475 — Z0 on a bowed blank is measured, not a point.
//
// The badge fixture is the issue's own: 3.81 mm blank, 3.0 mm split at 0.2 mm layers, the magnet
// pocket's membrane below. The colour line quantises to 0.8 and the pocket's ceiling to 1.4, so the
// floors may land from 1.0 to 1.2 — a 0.2 band. The badge measures 0.21 across the cut and the house
// margin is 0.2: the refusal is the house margin, exactly as the issue's arithmetic says.

import { describe, it, expect } from 'vitest';

import { badgeBlankFor } from '@/engine/cnc/engrave/fromBadge';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { voidLimitForItem } from '@/engine/cnc/engrave/partPlan';
import {
  assessSurfaceSpread,
  DEFAULT_SURFACE_TOUCH_COUNT,
  surfaceSpreadPlan,
  Z0_REFERENCE,
  type SurfaceReading,
} from '@/engine/cnc/engrave/surfaceSpread';
import { registrationSettings } from '@/engine/cnc/registration/settings';
import { viseForNewJob } from '@/engine/cnc/fixture';
import { readDefault } from '@/platform/defaultsClient';
import { defaultBadgeParams } from '@/types/badge';
import type { EngraveJob, EngraveLabel } from '@/types/engraveJob';

const PRINT_0_2 = { split: 3.0, layerHeight: 0.2, firstLayerHeight: 0.2 };

/** The badge's own blank, with the demo line placed over the magnet pocket (nearJaw's x = 24). */
function badgeJob(over: Partial<EngraveJob> = {}): EngraveJob {
  const blank = badgeBlankFor(defaultBadgeParams({ print: undefined }));
  const base = defaultEngraveJob();
  const line = base.labels[0] as EngraveLabel;
  return {
    ...base,
    stock: { ...blank.stock, print: PRINT_0_2 },
    workholding: { kind: 'vise', vise: { ...viseForNewJob(undefined, blank.stock), stockProud: 1.905 } },
    keepOuts: blank.pocket ? [blank.pocket] : [],
    labels: [{ ...line, position: { x: 24, y: 43 }, depth: 1.1 }],
    ...over,
  };
}

/** The issue's readings, in the plan's order: centre, left, right, front, back. */
const BOWED: SurfaceReading[] = [
  { z: -55.131, source: 'probe' },
  { z: -55.269, source: 'probe' },
  { z: -55.232, source: 'probe' },
  { z: -55.315, source: 'probe' },
  { z: -55.341, source: 'stated' },
];

describe('the surface spread on a bowed blank (#475)', () => {
  it('the band is the badge’s own: colour line + margin below, pocket ceiling above', () => {
    const job = badgeJob();
    const plan = surfaceSpreadPlan(job)!;
    expect(plan.band.lower).toMatchObject({ depth: 1.0, name: 'the colour split', source: 'split', margin: 0.2 });
    expect(plan.band.upper).toMatchObject({ depth: 1.2, source: 'void', margin: 0.2 });
    expect(plan.band.upper.name).toBe("the magnet pocket's ceiling");
    expect(plan.band.width).toBe(0.2);
    // …and the band's upper is the checker's own answer for the same line, not a second arithmetic.
    expect(voidLimitForItem(job, job.labels[0] as EngraveLabel)?.limit).toBeCloseTo(1.2, 9);
  });

  it('the seed’s five touches are the centre and both extents on each axis', () => {
    const plan = surfaceSpreadPlan(badgeJob())!;
    expect(plan.touches).toHaveLength(DEFAULT_SURFACE_TOUCH_COUNT);
    expect(plan.touches.map((t) => t.at)).toEqual([
      "the cut area's centre",
      "the cut area's left extent",
      "the cut area's right extent",
      "the cut area's front extent",
      "the cut area's back extent",
    ]);
    const centre = plan.touches[0]!;
    expect(centre).toMatchObject({ x: 24, y: 43 });
    // The line is wider than the turned blank: the extents are held 1 mm inside the stock.
    expect(plan.touches[1]!.x).toBe(1);
    expect(plan.touches[2]!.x).toBe(37.1);
  });

  it('a spread wider than the band REFUSES with the issue’s sentence', () => {
    const a = assessSurfaceSpread(badgeJob(), BOWED);
    expect(a.spread).toBe(0.21);
    expect(a.ok).toBe(false);
    expect(a.landing).toBeNull();
    expect(a.refusal).toMatchObject({ severity: 'error', code: 'blank-bowed' });
    expect(a.refusal?.message).toBe(
      'this blank is bowed 0.21 mm across the cut; the floors cannot stay past the colour line and clear of the pocket',
    );
  });

  it('min and max carry the reading’s provenance, and Z0 comes from the LOWEST touch', () => {
    const a = assessSurfaceSpread(badgeJob(), BOWED);
    expect(a.min).toMatchObject({ z: -55.341, source: 'stated', touchId: 'surface-5' });
    expect(a.max).toMatchObject({ z: -55.131, source: 'probe', touchId: 'surface-1' });
    // One named rule: the colour line is a plane and the dome is extra top material (#475).
    expect(Z0_REFERENCE).toBe('lowest');
    expect(a.z0).toEqual({ z: -55.341, touchId: 'surface-5', rule: 'lowest' });
  });

  it('a spread equal to the band passes, and the floor’s landing range is one depth', () => {
    const atLimit: SurfaceReading[] = BOWED.map((r) => ({ ...r }));
    atLimit[0] = { z: -55.141, source: 'probe' }; // max
    atLimit[4] = { z: -55.341, source: 'probe' }; // min
    const a = assessSurfaceSpread(badgeJob(), atLimit);
    expect(a.spread).toBe(0.2);
    expect(a.ok).toBe(true);
    expect(a.refusal).toBeNull();
    expect(a.landing).toEqual({ lower: 1.0, upper: 1.0 });
  });

  it('one reading per planned touch, in order; a mismatch is a caller error', () => {
    expect(() => assessSurfaceSpread(badgeJob(), BOWED.slice(1))).toThrow(
      'the surface spread needs 5 readings, one per planned touch; got 4',
    );
    const six = assessSurfaceSpread(badgeJob(), [...BOWED, { z: -55.2, source: 'probe' }], { touchCount: 6 });
    expect(six.touches).toHaveLength(6);
    expect(six.touches[5]!.at).toBe("the cut area's front-left corner");
  });

  it('the count is a shop default: seeded 5, and the labelled fallback IS the seed', () => {
    expect(readDefault(null, 'registration.surfaceTouchCount')).toMatchObject({ value: 5, source: 'fallback' });
    const reg = registrationSettings(null);
    expect(reg.settings.surfaceTouchCount).toBe(5);
    expect(reg.fallbacks).toContain('registration.surfaceTouchCount');
  });
});
