// The badge blank as an engrave job (#271 route 1). Pure: `badgeBlankFor` reads `BadgeParams`
// and nothing else, and the job it describes is then asked through `jobDepthLimit` — the single
// owner of the limit #174's verifier refuses against. No wasm, no store.

import { describe, it, expect } from 'vitest';

import { BADGE_POCKET_KEEP_OUT_ID, badgeBlankFor } from '@/engine/cnc/engrave/fromBadge';
import { defaultBadgeParams, type BadgeParams } from '@/types/badge';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { jobDepthLimit, keepOutLimitAt, toPartPlan } from '@/engine/cnc/engrave/partPlan';
import { parseEngraveJob } from '@/store/engraveJobSchema';
import type { EngraveJob } from '@/types/engraveJob';

/**
 * A badge that states NO print — the state a legacy project loads in, and the one #285's switch
 * reads. Written explicitly, because `defaultBadgeParams` now carries a print (#368) and the
 * switch's "off" side must stay reachable to be tested at all.
 */
const noPrint = (): BadgeParams => defaultBadgeParams({ print: undefined });

/** The job a caller gets by writing `badgeBlankFor(badge)` into a fresh default job. */
function jobForBadge(badge = defaultBadgeParams()): EngraveJob {
  const blank = badgeBlankFor(badge);
  return {
    ...defaultEngraveJob(),
    stock: blank.stock,
    keepOuts: blank.pocket ? [blank.pocket] : [],
  };
}

describe('badgeBlankFor (#271)', () => {
  it('reads the blank out of the badge, in the job’s own stock shape', () => {
    const blank = badgeBlankFor(defaultBadgeParams());
    // The badge is 3.0 in × 1.5 in (76.2 × 38.1), 0.15 in thick, and it goes on the bench TURNED
    // a quarter turn (#383): its 38.1 mm side is across the jaws (X), so the stock's `length` is
    // that side and its `width` the 76.2 mm one. What rides ALONG in the same object — the print
    // and the dome (#285, #352, #368) — is those issues' business and is asserted in its own
    // describe below, so here it is only that the dimensions are the badge's own, matched rather
    // than deep-equalled so a fact added beside them cannot fail this.
    expect(blank.stock).toMatchObject({
      length: 38.1,
      width: 76.2,
      thickness: 3.81,
      material: 'pla',
      colour: { kind: 'printed', capMm: 0.81, layerHeight: 0.2, firstLayerHeight: 0.2 },
    });
    // The note prints the stock in the job's own order, and says why it is the other way round
    // from the badge's numbers — a sentence the person reading 38.1 × 76.2 is owed (#383).
    expect(blank.notes[0]).toContain('38.1 × 76.2 × 3.81');
    expect(blank.notes[0]).toContain('turned a quarter turn');
    expect(blank.notes[0]).toContain('76.2 mm side now runs along Y');
  });

  it('stamps the magnet pocket with a ceiling in the blank’s own datum', () => {
    const { pocket } = badgeBlankFor(defaultBadgeParams());
    expect(pocket).not.toBeNull();
    expect(pocket!.id).toBe(BADGE_POCKET_KEEP_OUT_ID);
    expect(pocket!.kind).toBe('rect');
    if (pocket!.kind !== 'rect') return;
    // 45 × 13 in the badge's own frame, turned with the blank (#383): `pocket.length` runs along
    // the badge's X, which on the stock is Y — so on the blank the rect is 13 across and 45 along.
    expect(pocket!.width).toBe(13);
    expect(pocket!.height).toBe(45);
    // Centred on the outline in the badge's frame -> the middle of the job's stock.
    expect(pocket!.position).toEqual({ x: 19.05, y: 38.1 });
    // `pocket.depth` is measured from the BACK face; so is `zCeiling` — machined pocket-down
    // (/Fabrication.md §7.2), the back face IS the bottom face. Copied, not recomputed.
    expect(pocket!.zCeiling).toBe(2.3);
    expect(pocket!.enabled).toBe(true);
  });

  it('states the membrane §7.2 names — 3.81 mm of blank less a 2.3 mm pocket', () => {
    const blank = badgeBlankFor(defaultBadgeParams());
    expect(blank.notes.join(' ')).toContain('1.51');
  });

  it('declares no void for a badge with no pocket, and says so', () => {
    const blank = badgeBlankFor(defaultBadgeParams({ magnetPocket: null }));
    expect(blank.pocket).toBeNull();
    expect(blank.notes.join(' ')).toMatch(/no magnet pocket/);
    // The blank is still the badge's blank — a pocket-less badge is a badge.
    expect(blank.stock.thickness).toBe(3.81);
  });

  it('produces a void the depth limit reads, and only over its footprint', () => {
    const job = jobForBadge(noPrint());
    // The pocket's ceiling is an `above` bound like any other (#345), so what it reserves is the
    // margin its OWN rule keeps — and this badge states no print, so that is
    // `max(boundaryMargin, minFloor)` = 1.0, not the shipped 0.2 (#345 decision A: with no layer
    // grid the structural floor is the only number with a basis).
    // 1.51 mm of membrane, less 1.0: 0.51 mm over the pocket…
    expect(keepOutLimitAt(job, 19.05, 38.1)).toBeCloseTo(0.51, 6);
    // …and nothing reserved out at the blank's corner, where the limit is the stock's own.
    expect(keepOutLimitAt(job, 5, 5)).toBeNull();
    expect(jobDepthLimit(job)(5, 5)).toBeCloseTo(3.81 - 1, 6);
    // The membrane is thin: a 1.5 mm cut on the badge's engraved face breaks through it.
    expect(jobDepthLimit(job)(19.05, 38.1)).toBeLessThan(1.5);
  });

  it('survives the schema round-trip, at the same fixed id', () => {
    const reparsed = parseEngraveJob(JSON.parse(JSON.stringify(jobForBadge())) as unknown);
    expect(reparsed.ok).toBe(true);
    if (!reparsed.ok) return;
    expect(reparsed.job.keepOuts).toHaveLength(1);
    expect(reparsed.job.keepOuts![0]!.id).toBe(BADGE_POCKET_KEEP_OUT_ID);
    // The pocket reaches `toPartPlan`, which is what the run sheet and the findings read.
    const plan = toPartPlan(reparsed.job);
    expect(plan.stock.keepOuts.map((k) => k.id)).toEqual([BADGE_POCKET_KEEP_OUT_ID]);
  });
});

describe('the badge’s print becomes the job’s (#285)', () => {
  it('carries nothing when the badge states no print — the switches stay off', () => {
    // A badge with no print is a legacy project's badge, or one a test builds by hand. The job
    // must be exactly what it was before #285 existed.
    const blank = badgeBlankFor(noPrint());
    expect(blank.stock.colour).toBeUndefined();
    // …and the plan therefore has no colour layers at all, which is what keeps the depth limit
    // analytic and the `.nc` byte-identical.
    expect(toPartPlan(jobForBadge(noPrint())).stock.split).toBeUndefined();
  });

  it('states the print the DEFAULT badge carries, so the template is not dormant (#368)', () => {
    // The default badge now declares its print, which is the whole point of #368: a badge made
    // from the template (or from `defaultBadgeParams`) reaches the engrave job with a colour
    // boundary, so #170's surface/reveal control and #351's layer-aligned limit are live.
    const blank = badgeBlankFor(defaultBadgeParams());
    expect(defaultBadgeParams().print).toEqual({ layerHeight: 0.2, firstLayerHeight: 0.2 });
    expect(blank.stock.colour).toEqual({
      kind: 'printed',
      capMm: 0.81,
      layerHeight: 0.2,
      firstLayerHeight: 0.2,
    });
    expect(toPartPlan(jobForBadge()).stock.split).toBe(3);
  });

  it('copies the split and the layer grid when the badge states its print', () => {
    const badge = defaultBadgeParams({ print: { layerHeight: 0.2, firstLayerHeight: 0.2 } });
    const blank = badgeBlankFor(badge);
    // The split travels WITH the blank: a job document is standalone and must not have to look
    // back at the project's badge to know where its colour boundary is.
    expect(blank.stock.colour).toEqual({
      kind: 'printed',
      capMm: 0.81,
      layerHeight: 0.2,
      firstLayerHeight: 0.2,
    });
    // The blank itself is unchanged — the print adds a fact, it does not move a dimension.
    expect(blank.stock.thickness).toBe(3.81);
    expect(blank.notes.join(' ')).toContain('3 mm colour split');
    expect(blank.notes.join(' ')).toContain('0.2 mm layers');
  });

  it('reaches the plan, where the layer stack reads it', () => {
    const badge = defaultBadgeParams({ print: { layerHeight: 0.2, firstLayerHeight: 0.2 } });
    const plan = toPartPlan(jobForBadge(badge));
    expect(plan.stock.split).toBe(3.0);
    expect(plan.stock.layerHeight).toBe(0.2);
    expect(plan.stock.firstLayerHeight).toBe(0.2);
  });

  it('keeps the print through the schema round-trip, and drops it for a job without one', () => {
    const badge = defaultBadgeParams({ print: { layerHeight: 0.2, firstLayerHeight: 0.2 } });
    const withPrint = parseEngraveJob(JSON.parse(JSON.stringify(jobForBadge(badge))) as unknown);
    expect(withPrint.ok).toBe(true);
    if (!withPrint.ok) return;
    expect(withPrint.job.stock.colour).toEqual({
      kind: 'printed',
      capMm: 0.81,
      layerHeight: 0.2,
      firstLayerHeight: 0.2,
    });

    // The other direction: a job built from a print-less badge keeps no key, so it round-trips
    // byte-for-byte.
    const without = parseEngraveJob(
      JSON.parse(JSON.stringify(jobForBadge(noPrint()))) as unknown,
    );
    expect(without.ok).toBe(true);
    if (!without.ok) return;
    expect(without.job.stock.colour).toBeUndefined();
    expect('print' in without.job.stock).toBe(false);
    expect(without.job.stock.colour).toBeUndefined();
  });
});
