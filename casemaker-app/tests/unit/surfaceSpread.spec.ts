// #475 — Z0 on a bowed blank is measured, not a point; #608 — a tilt is followed, not refused.
//
// The badge fixture is the issue's own: 3.81 mm blank, 3.0 mm split at 0.2 mm layers, the magnet
// pocket's membrane below. The colour line quantises to 0.8 and the pocket's ceiling to 1.4, so the
// floors may land from 1.0 to 1.2 — a 0.2 band. #608 changed the verdict from the raw SPREAD to the
// RESIDUAL after a least-squares plane fit: a 0.45 mm tilt (run 5) fits a plane and is followed, and
// a top whose bow outlasts the plane — a dome, whose residual is 4/5 of its height — is no longer
// refused (#631): the origin is still written and the machine levels it itself.

import { describe, it, expect } from 'vitest';

import { badgeBlankFor } from '@/engine/cnc/engrave/fromBadge';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { voidLimitForItem } from '@/engine/cnc/engrave/partPlan';
import {
  assessSurfaceReadings,
  assessSurfaceSpread,
  DEFAULT_SURFACE_TOUCH_COUNT,
  domeAcceptSentence,
  domeCentreMiss,
  surfaceDomeGuidance,
  surfaceFitForPost,
  surfaceMarginWords,
  surfaceSpreadPlan,
  surfaceTiltWords,
  Z0_REFERENCE,
  type SurfaceReading,
  type SurfaceSpreadPlan,
} from '@/engine/cnc/engrave/surfaceSpread';
import { registrationSettings } from '@/engine/cnc/registration/settings';
import { viseForNewJob } from '@/engine/cnc/fixture';
import { readDefault } from '@/platform/defaultsClient';
import { defaultBadgeParams } from '@/types/badge';
import type { EngraveJob, EngraveLabel } from '@/types/engraveJob';

const COLOUR_0_2 = { kind: 'printed' as const, capMm: 0.81, layerHeight: 0.2, firstLayerHeight: 0.2 };

/** The badge's own blank, with the demo line placed over the magnet pocket (nearJaw's x = 24). */
function badgeJob(over: Partial<EngraveJob> = {}): EngraveJob {
  const blank = badgeBlankFor(defaultBadgeParams({ print: undefined }));
  const base = defaultEngraveJob();
  const line = base.labels[0] as EngraveLabel;
  return {
    ...base,
    stock: { ...blank.stock, colour: COLOUR_0_2 },
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

/**
 * #608 — the 2026-10-23 run-5 readings, in plan order. A 0.45 mm tilt toward +X/+Y (the moving-jaw
 * side reads low), which a plane follows; the centre's 0.2 mm high spot is what the plane leaves as
 * its residual.
 */
const RUN5: SurfaceReading[] = [
  { z: -55.055, source: 'probe' },
  { z: -55.164, source: 'probe' },
  { z: -55.505, source: 'probe' },
  { z: -55.092, source: 'probe' },
  { z: -55.437, source: 'probe' },
];

/**
 * #608 — a genuinely NON-planar top: a dome whose centre is 0.33 mm above every extent (the badge's
 * own dome, `docs/design/cnc-job-workflow.md` Appendix C). A plane cannot explain a dome, so the
 * residual — 4/5 of the dome height — exceeds the 0.2 mm band and the blank still refuses.
 */
const NONPLANAR: SurfaceReading[] = [
  { z: -55.0, source: 'probe' },
  { z: -55.33, source: 'probe' },
  { z: -55.33, source: 'probe' },
  { z: -55.33, source: 'probe' },
  { z: -55.33, source: 'probe' },
];

/**
 * The run-5 cut extents, symmetric around their centre exactly as the bench's touches were (the
 * badge's cut regions span nearly the full blank, not the single demo line). The symmetry matters:
 * it is what lets the plane fit the tilt with its residual under the band.
 */
function run5Plan(): SurfaceSpreadPlan {
  const plan = surfaceSpreadPlan(badgeJob())!;
  const at = ["the cut area's centre", "the cut area's left extent", "the cut area's right extent", "the cut area's front extent", "the cut area's back extent"];
  const pts: [number, number][] = [
    [24, 43],
    [24 - 13.9725, 43],
    [24 + 13.9725, 43],
    [24, 43 - 33.566],
    [24, 43 + 33.566],
  ];
  return { ...plan, touches: pts.map(([x, y], i) => ({ id: `surface-${i + 1}`, x, y, at: at[i]! })) };
}

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

  it('#608 — the run-5 tilt fits a plane (residual under the band) and is followed, not refused', () => {
    const plan = run5Plan();
    const a = assessSurfaceReadings(plan, RUN5);
    expect(a.spread).toBe(0.45);
    expect(a.fit).not.toBeNull();
    expect(a.fit!.kind).toBe('plane');
    expect(a.fit!.residual).toBeCloseTo(0.196, 2);
    expect(a.fit!.residual).toBeLessThan(plan.band.width);
    expect(a.ok).toBe(true);
    expect(a.landing).not.toBeNull();
    // The run sheet's words: the fitted plane drops toward +X and +Y (the moving-jaw side is low).
    expect(surfaceTiltWords(a.tilt)).toBe('0.341 mm toward +X and 0.345 mm toward +Y');
    // Z0 stays the lowest touch, not the fitted plane's mean.
    expect(a.z0).toEqual({ z: -55.505, touchId: 'surface-3', rule: 'lowest' });
  });

  it('#608 — a top that is not one plane (residual wider than the band) is a DOME and no longer refuses', () => {
    const a = assessSurfaceSpread(badgeJob(), NONPLANAR);
    expect(a.spread).toBe(0.33);
    expect(a.fit).not.toBeNull();
    expect(a.fit!.residual).toBeGreaterThan(0.2);
    expect(a.ok).toBe(false);
    expect(a.landing).toBeNull();
    expect(a.verdict).toBe('dome');
    // #631 — Z0 is still the lowest touch, so the origin is written from the dome just as from a tilt.
    expect(a.z0).toEqual({ z: -55.33, touchId: 'surface-2', rule: 'lowest' });
  });

  it('min and max carry the reading’s provenance, and Z0 comes from the LOWEST touch', () => {
    const a = assessSurfaceSpread(badgeJob(), BOWED);
    expect(a.min).toMatchObject({ z: -55.341, source: 'stated', touchId: 'surface-5' });
    expect(a.max).toMatchObject({ z: -55.131, source: 'probe', touchId: 'surface-1' });
    // One named rule: the colour line is a plane and the dome is extra top material (#475).
    expect(Z0_REFERENCE).toBe('lowest');
    expect(a.z0).toEqual({ z: -55.341, touchId: 'surface-5', rule: 'lowest' });
    // #608 — the 0.21 mm spread bow still fits a plane (residual 0.125 < band), so it now FOLLOWS:
    // its spread was a mild dome the old spread-only rule refused, not a tilt a plane cannot take.
    expect(a.ok).toBe(true);
    expect(a.landing).toEqual({ lower: 1.0, upper: 1.075 });
  });

  it('#608 — a spread under the band passes, and the landing range is the band less the residual', () => {
    const flat: SurfaceReading[] = BOWED.map((r) => ({ ...r, z: -55.2 }));
    const a = assessSurfaceSpread(badgeJob(), flat);
    expect(a.spread).toBe(0);
    expect(a.ok).toBe(true);
    // Every reading identical: the plane is flat, the residual 0, and the landing range is the whole band.
    expect(a.fit!.residual).toBe(0);
    expect(a.landing).toEqual({ lower: 1.0, upper: 1.2 });
  });

  it('#608 — a tilted fit yields the post payload with r6 slopes; a flat fit yields null', () => {
    const tilted = assessSurfaceReadings(run5Plan(), RUN5);
    const post = surfaceFitForPost(tilted);
    expect(post).not.toBeNull();
    expect(post!.z0).toBe(-55.505);
    // The coefficients travel on the record forever and are re-posted from, so they are r6 — the
    // micrometer-resolution slopes, not the r3 read-out the verdict prints (-0.012 and -0.005).
    expect(post!.plane.slopeX).toBe(-0.012203);
    expect(post!.plane.slopeY).toBe(-0.005139);
    // A FLAT top fits a plane with no tilt: nothing to post, and the package must stay byte-identical.
    const flat = assessSurfaceSpread(badgeJob(), BOWED.map((r) => ({ ...r, z: -55.2 })));
    expect(flat.ok).toBe(true);
    expect(surfaceFitForPost(flat)).toBeNull();
  });

describe('#501 — the shape verdict and the console G32 recommendation', () => {
  const level = { toolRadiusMm: 0.15, clearanceMm: 3, points: 9 };

  it('a tilt (plane holds, drop wider than the band) is named, with the G32 recipe sized to the cut + radius', () => {
    const plan = { ...run5Plan(), level };
    const a = assessSurfaceReadings(plan, RUN5);
    expect(a.ok).toBe(true);
    expect(a.verdict).toBe('tilt');
    expect(a.slopeDeg).toBeGreaterThan(0);
    expect(a.slopeDeg).toBeLessThan(1);
    expect(a.recommendation).not.toBeNull();
    // The grid: the cut extents grown by the cutter's radius on every side, 3 × 3, the probe's clearance.
    expect(a.recommendation!.gcode).toBe('G32 R1 X9.878 Y9.284 A38.122 B76.716 I3 J3 H3');
    expect(a.recommendation!.dump).toBe('M375.1');
    expect(a.recommendation!.after).toBe('M370');
    expect(a.recommendation!.sentence).toContain('follows the tilt');
    expect(a.recommendation!.sentence).toContain('G32 is never uploaded in a file');
  });

  it('the same tilt without the level inputs keeps the verdict, and offers no recipe', () => {
    const a = assessSurfaceReadings(run5Plan(), RUN5);
    expect(a.verdict).toBe('tilt');
    expect(a.recommendation).toBeNull();
  });

  it('#631 — a dome is named, keeps its verdict, and offers the G32 recipe (upload FLAT)', () => {
    const a = assessSurfaceSpread(badgeJob(), NONPLANAR, { level });
    expect(a.verdict).toBe('dome');
    expect(a.ok).toBe(false);
    expect(a.recommendation).not.toBeNull();
    expect(a.recommendation!.gcode).toContain('G32 R1 X');
    expect(a.recommendation!.dump).toBe('M375.1');
    expect(a.recommendation!.after).toBe('M370');
    expect(a.recommendation!.sentence).toContain('dome, not a tilt');
    expect(a.recommendation!.sentence).toContain('uploads FLAT');
    expect(a.recommendation!.sentence).toContain('G32 is never uploaded in a file');
  });

  it('#631 (c) — run 8’s dome names the exact operator-accepted miss', () => {
    // Run 8's five readings (2026-10-24, k3 badge blank, #630): centre-high, the four extents below
    // it on a tilted blank. The miss is c + maxBelow − band, floored — NOT residual-based.
    const RUN8: SurfaceReading[] = [
      { z: -55.085, source: 'probe' },
      { z: -55.197, source: 'probe' },
      { z: -55.568, source: 'probe' },
      { z: -55.137, source: 'probe' },
      { z: -55.476, source: 'probe' },
    ];
    const a = assessSurfaceSpread(badgeJob(), RUN8, { level });
    expect(a.verdict).toBe('dome');
    // The centre is the highest point (its deviation equals the residual), so a residual-based
    // figure would double it; the honest miss is the centre height + the furthest below-plane touch.
    expect(a.fit!.residual).toBeCloseTo(0.224, 3);
    const miss = domeCentreMiss(a);
    expect(miss).not.toBeNull();
    expect(miss!.at).toBe('centre');
    expect(miss!.mm).toBe(0.171);
    expect(domeAcceptSentence(a)).toBe(
      'Write the origin anyway — the floor may miss the colour line by up to 0.171 mm at the centre',
    );
  });

  it('#631 (c) — without a centre-labelled touch the miss names the highest point', () => {
    const plan = surfaceSpreadPlan(badgeJob(), { level })!;
    const noCentre: SurfaceSpreadPlan = {
      ...plan,
      touches: plan.touches.map((t, i) => ({ ...t, at: i === 0 ? 'the peak' : t.at })),
    };
    const a = assessSurfaceReadings(noCentre, NONPLANAR);
    expect(a.verdict).toBe('dome');
    const miss = domeCentreMiss(a);
    expect(miss!.at).toBe('highest point');
    expect(domeAcceptSentence(a)).toContain('at the highest point');
  });

  it('#631 (c) — a top that fits the band offers no "write the origin anyway" route', () => {
    const flat = assessSurfaceSpread(badgeJob(), BOWED.map((r) => ({ ...r, z: -55.2 })), { level });
    expect(flat.verdict).toBe('flat');
    expect(domeCentreMiss(flat)).toBeNull();
    expect(domeAcceptSentence(flat)).toBeNull();
  });

  it('a flat top is flat: no slope, no recipe', () => {
    const flat = BOWED.map((r) => ({ ...r, z: -55.2 }));
    const a = assessSurfaceSpread(badgeJob(), flat, { level });
    expect(a.verdict).toBe('flat');
    expect(a.slopeDeg).toBe(0);
    expect(a.recommendation).toBeNull();
  });
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

describe('#630 — the verdict says the margin, and a dome names the next steps', () => {
  it('a followed tilt says the residual is inside the band, with both numbers named', () => {
    const a = assessSurfaceReadings(run5Plan(), RUN5);
    const words = surfaceMarginWords(a);
    expect(words).toContain('miss the plane by');
    expect(words).toContain('inside the 0.2 mm band');
    // The residual is the #608 read-out, so the margin is band − residual (0.2 − 0.196 = 0.004).
    expect(words).toContain('0.004 inside');
  });

  it('a flat top says the residual is inside the band too', () => {
    const a = assessSurfaceSpread(badgeJob(), BOWED.map((r) => ({ ...r, z: -55.2 })));
    const words = surfaceMarginWords(a);
    expect(words).toContain('inside the 0.2 mm band');
  });

  it('a dome says how far OUTSIDE the band the residual sits', () => {
    const a = assessSurfaceSpread(badgeJob(), NONPLANAR);
    const words = surfaceMarginWords(a);
    expect(words).toContain('miss the plane by');
    expect(words).toContain('outside the 0.2 mm band');
  });

  it('the dome guidance is ORDERED: the machine route, then the accepted one, then the re-seat note', () => {
    const a = assessSurfaceSpread(badgeJob(), NONPLANAR);
    const g = surfaceDomeGuidance(a);
    // 1 — the machine route, first, because it cuts the part as designed.
    const g32 = g.indexOf('G32 from the console levels the curved top');
    const accept = g.indexOf('Or write the origin anyway');
    const reseat = g.indexOf('A thin plastic blank bows centre-high');
    expect(g32).toBe(0);
    expect(accept).toBeGreaterThan(g32);
    expect(reseat).toBeGreaterThan(accept);
    expect(g).toContain('uploads FLAT');
    // #631 — the machine route states its ASSUMPTION and the landing it cannot check: G32 follows
    // the top, so the colour line is the programmed depth only when the whole blank is bowed, and a
    // top-only dome has no checked landing range.
    expect(g).toContain('G32 follows the top');
    expect(g).toContain('film included');
    expect(g).toContain('no landing range is checked');
    // The accepted clause is the SAME sentence the Cut step's checkbox and the run sheet print
    // (its first letter lowercased because it follows "Or").
    expect(g.toLowerCase()).toContain(domeAcceptSentence(a)!.toLowerCase());
    // 3 — the re-seat note is information only, and names the cause worth trying.
    expect(g.slice(reseat)).toContain('lighter re-seat');
    expect(g.slice(reseat)).toContain('chip');
    // No issue numbers in operator-facing text.
    expect(g).not.toMatch(/#\d/);
  });

  it('omits the accepted route when there is no miss to accept', () => {
    // A FLAT top: the plane fits, nothing overflows the band, so there is no miss to accept and the
    // sentence must not invent one.
    const flat = BOWED.slice(0, 3).map((r) => ({ ...r, z: -55.2 }));
    const a = assessSurfaceSpread(badgeJob(), flat, { touchCount: 3 });
    expect(domeAcceptSentence(a)).toBeNull();
    const g = surfaceDomeGuidance(a);
    expect(g).not.toContain('write the origin anyway');
    expect(g.startsWith('G32 from the console levels the curved top')).toBe(true);
  });
});
